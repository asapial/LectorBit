//! Transactional playback checkpoints and append-only study actions.

use std::collections::BTreeMap;

use chrono::Utc;
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{DbError, DbResult};

pub const COMPLETION_PERCENT: u64 = 90;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybackItem {
    pub id: String,
    pub plan_version_id: String,
    pub media_id: String,
    pub display_name: String,
    pub raw_start_ms: u64,
    pub raw_end_ms: u64,
    pub media_duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressSnapshot {
    pub media_id: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub version: u64,
    pub covered_ms: u64,
    pub item_covered_ms: u64,
    pub item_duration_ms: u64,
    pub completed: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplanMediaState {
    pub media_id: String,
    pub completed_ranges: Vec<(u64, u64)>,
    pub forced_ranges: Vec<(u64, u64)>,
    pub split_points: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointResult {
    Saved(ProgressSnapshot),
    Conflict(ProgressSnapshot),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudyActionKind {
    Started,
    Paused,
    Complete,
    Skip,
    Postpone,
    Split,
    Repeat,
    MustWatch,
}

impl StudyActionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Paused => "paused",
            Self::Complete => "complete",
            Self::Skip => "skip",
            Self::Postpone => "postpone",
            Self::Split => "split",
            Self::Repeat => "repeat",
            Self::MustWatch => "must_watch",
        }
    }
}

#[derive(Clone)]
pub struct Repo {
    pool: SqlitePool,
}

impl Repo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn resolve_active_item(&self, item_id: &str) -> DbResult<Option<PlaybackItem>> {
        let row = sqlx::query(
            "SELECT i.id, i.plan_version_id, i.media_id, m.display_name, \
                    i.raw_start_ms, i.raw_end_ms, m.duration_ms \
             FROM plan_version_items i \
             JOIN plans p ON p.active_version_id = i.plan_version_id \
             JOIN media_files m ON m.id = i.media_id \
             JOIN library_roots r ON r.id = m.root_id \
             WHERE i.id = ? AND p.user_id = 'local' AND p.archived_at IS NULL \
               AND r.revoked_at IS NULL AND m.probe_status = 'ready'",
        )
        .bind(item_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_item).transpose()
    }

    pub async fn snapshot_for_item(&self, item: &PlaybackItem) -> DbResult<ProgressSnapshot> {
        let mut transaction = self.pool.begin().await?;
        let snapshot = build_snapshot(&mut transaction, item).await?;
        transaction.commit().await?;
        Ok(snapshot)
    }

    pub async fn checkpoint(
        &self,
        item: &PlaybackItem,
        position_ms: u64,
        expected_version: Option<u64>,
        watched_range: Option<(u64, u64)>,
    ) -> DbResult<CheckpointResult> {
        if position_ms > item.media_duration_ms {
            return Err(DbError::Pool(
                "playback position is outside the media".into(),
            ));
        }
        if let Some((start, end)) = watched_range {
            if start >= end || end > item.media_duration_ms {
                return Err(DbError::Pool("watched range is invalid".into()));
            }
        }

        let mut transaction = self.pool.begin().await?;
        let current = build_snapshot(&mut transaction, item).await?;
        if expected_version.is_some_and(|expected| expected != current.version) {
            transaction.rollback().await?;
            return Ok(CheckpointResult::Conflict(current));
        }
        let next_version = current.version.saturating_add(1);
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO playback_progress \
             (media_id, position_ms, duration_ms, updated_at, version) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(media_id) DO UPDATE SET position_ms = excluded.position_ms, \
                duration_ms = excluded.duration_ms, updated_at = excluded.updated_at, \
                version = excluded.version",
        )
        .bind(&item.media_id)
        .bind(to_i64(position_ms))
        .bind(to_i64(item.media_duration_ms))
        .bind(&now)
        .bind(to_i64(next_version))
        .execute(&mut *transaction)
        .await?;
        if let Some((start, end)) = watched_range {
            sqlx::query(
                "INSERT INTO playback_coverage_ranges \
                 (id, media_id, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(new_id())
            .bind(&item.media_id)
            .bind(to_i64(start))
            .bind(to_i64(end))
            .bind(&now)
            .execute(&mut *transaction)
            .await?;
        }
        let snapshot = build_snapshot(&mut transaction, item).await?;
        if snapshot.completed && !blocks_automatic_completion(&mut transaction, &item.id).await? {
            insert_action(
                &mut transaction,
                item,
                StudyActionKind::Complete,
                Some(r#"{"source":"watched_coverage"}"#),
            )
            .await?;
        }
        transaction.commit().await?;
        Ok(CheckpointResult::Saved(snapshot))
    }

    pub async fn record_action(
        &self,
        item: &PlaybackItem,
        kind: StudyActionKind,
        at_ms: Option<u64>,
    ) -> DbResult<()> {
        if kind == StudyActionKind::Split
            && !at_ms
                .is_some_and(|position| position > item.raw_start_ms && position < item.raw_end_ms)
        {
            return Err(DbError::Pool(
                "split point must be inside the study block".into(),
            ));
        }
        let payload = at_ms.map(|position| format!(r#"{{"at_ms":{position}}}"#));
        let mut transaction = self.pool.begin().await?;
        insert_action(&mut transaction, item, kind, payload.as_deref()).await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn replan_media_states(&self) -> DbResult<Vec<ReplanMediaState>> {
        let mut states = BTreeMap::<String, ReplanMediaState>::new();
        let item_rows = sqlx::query(
            "SELECT i.media_id, i.raw_start_ms, i.raw_end_ms, directive.kind \
             FROM plan_version_items i \
             JOIN plans p ON p.active_version_id = i.plan_version_id \
             LEFT JOIN study_actions directive ON directive.id = ( \
               SELECT action.id FROM study_actions action \
               WHERE action.plan_version_item_id = i.id \
                 AND action.kind IN ('complete', 'skip', 'postpone', 'repeat', 'must_watch') \
               ORDER BY action.created_at DESC, action.id DESC LIMIT 1 \
             ) \
             WHERE p.user_id = 'local' AND p.archived_at IS NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        for row in item_rows {
            let media_id: String = row.try_get("media_id")?;
            let start = nonnegative_u64(row.try_get("raw_start_ms")?);
            let end = nonnegative_u64(row.try_get("raw_end_ms")?);
            let kind: Option<String> = row.try_get("kind")?;
            let state = states
                .entry(media_id.clone())
                .or_insert_with(|| ReplanMediaState {
                    media_id,
                    completed_ranges: Vec::new(),
                    forced_ranges: Vec::new(),
                    split_points: Vec::new(),
                });
            match kind.as_deref() {
                Some("complete" | "skip") => state.completed_ranges.push((start, end)),
                Some("postpone" | "repeat" | "must_watch") => {
                    state.forced_ranges.push((start, end));
                }
                _ => {}
            }
        }

        let coverage_rows = sqlx::query(
            "SELECT coverage.media_id, coverage.start_ms, coverage.end_ms \
             FROM playback_coverage_ranges coverage \
             WHERE EXISTS ( \
               SELECT 1 FROM plan_version_items item \
               JOIN plans p ON p.active_version_id = item.plan_version_id \
               WHERE item.media_id = coverage.media_id \
                 AND p.user_id = 'local' AND p.archived_at IS NULL \
             ) ORDER BY coverage.media_id, coverage.start_ms, coverage.end_ms",
        )
        .fetch_all(&self.pool)
        .await?;
        for row in coverage_rows {
            let media_id: String = row.try_get("media_id")?;
            if let Some(state) = states.get_mut(&media_id) {
                state.completed_ranges.push((
                    nonnegative_u64(row.try_get("start_ms")?),
                    nonnegative_u64(row.try_get("end_ms")?),
                ));
            }
        }

        let split_rows = sqlx::query(
            "SELECT item.media_id, action.payload \
             FROM study_actions action \
             JOIN plan_version_items item ON item.id = action.plan_version_item_id \
             JOIN plans p ON p.active_version_id = item.plan_version_id \
             WHERE action.kind = 'split' AND p.user_id = 'local' \
               AND p.archived_at IS NULL ORDER BY action.created_at, action.id",
        )
        .fetch_all(&self.pool)
        .await?;
        for row in split_rows {
            let media_id: String = row.try_get("media_id")?;
            let payload: Option<String> = row.try_get("payload")?;
            let point = payload
                .as_deref()
                .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
                .and_then(|value| value.get("at_ms").and_then(serde_json::Value::as_u64));
            if let (Some(state), Some(point)) = (states.get_mut(&media_id), point) {
                state.split_points.push(point);
            }
        }

        for state in states.values_mut() {
            state.completed_ranges = merge_ranges(std::mem::take(&mut state.completed_ranges));
            state.forced_ranges = merge_ranges(std::mem::take(&mut state.forced_ranges));
            state.split_points.sort_unstable();
            state.split_points.dedup();
        }
        Ok(states.into_values().collect())
    }
}

async fn build_snapshot(
    transaction: &mut Transaction<'_, Sqlite>,
    item: &PlaybackItem,
) -> DbResult<ProgressSnapshot> {
    let progress = sqlx::query(
        "SELECT position_ms, duration_ms, version, updated_at \
         FROM playback_progress WHERE media_id = ?",
    )
    .bind(&item.media_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let (position_ms, duration_ms, version, updated_at) = match progress {
        Some(row) => (
            nonnegative_u64(row.try_get("position_ms")?),
            nonnegative_u64(row.try_get("duration_ms")?),
            nonnegative_u64(row.try_get("version")?),
            row.try_get("updated_at")?,
        ),
        None => (
            item.raw_start_ms,
            item.media_duration_ms,
            0,
            Utc::now().to_rfc3339(),
        ),
    };
    let rows = sqlx::query(
        "SELECT start_ms, end_ms FROM playback_coverage_ranges \
         WHERE media_id = ? ORDER BY start_ms, end_ms",
    )
    .bind(&item.media_id)
    .fetch_all(&mut **transaction)
    .await?;
    let ranges = rows
        .into_iter()
        .map(|row| {
            Ok((
                nonnegative_u64(row.try_get("start_ms")?),
                nonnegative_u64(row.try_get("end_ms")?),
            ))
        })
        .collect::<DbResult<Vec<_>>>()?;
    let merged = merge_ranges(ranges);
    let covered_ms: u64 = merged.iter().map(|(start, end)| end - start).sum();
    let item_covered_ms: u64 = merged
        .iter()
        .map(|(start, end)| {
            (*end)
                .min(item.raw_end_ms)
                .saturating_sub((*start).max(item.raw_start_ms))
        })
        .sum();
    let item_duration_ms = item.raw_end_ms.saturating_sub(item.raw_start_ms);
    let action = latest_completion_instruction(&mut **transaction, &item.id).await?;
    let covered_enough = item_duration_ms > 0
        && item_covered_ms.saturating_mul(100)
            >= item_duration_ms.saturating_mul(COMPLETION_PERCENT);
    let completed = completion_state(action.as_deref(), covered_enough);
    Ok(ProgressSnapshot {
        media_id: item.media_id.clone(),
        position_ms,
        duration_ms,
        version,
        covered_ms,
        item_covered_ms,
        item_duration_ms,
        completed,
        updated_at,
    })
}

async fn latest_completion_instruction<'e, E>(
    executor: E,
    item_id: &str,
) -> DbResult<Option<String>>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    Ok(sqlx::query(
        "SELECT kind FROM study_actions WHERE plan_version_item_id = ? \
           AND kind IN ('complete', 'skip', 'postpone', 'repeat', 'must_watch') \
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(item_id)
    .fetch_optional(executor)
    .await?
    .map(|row| row.try_get("kind"))
    .transpose()?)
}

async fn blocks_automatic_completion(
    transaction: &mut Transaction<'_, Sqlite>,
    item_id: &str,
) -> DbResult<bool> {
    Ok(latest_completion_instruction(&mut **transaction, item_id)
        .await?
        .is_some_and(|kind| matches!(kind.as_str(), "complete" | "skip" | "repeat" | "must_watch")))
}

fn completion_state(instruction: Option<&str>, covered_enough: bool) -> bool {
    match instruction {
        Some("complete" | "skip") => true,
        // These instructions deliberately reopen the item. Old coverage remains
        // history, but cannot silently complete the new request.
        Some("postpone" | "repeat" | "must_watch") => false,
        _ => covered_enough,
    }
}

async fn insert_action(
    transaction: &mut Transaction<'_, Sqlite>,
    item: &PlaybackItem,
    kind: StudyActionKind,
    payload: Option<&str>,
) -> DbResult<()> {
    sqlx::query(
        "INSERT INTO study_actions \
         (id, user_id, plan_item_id, media_id, kind, payload, created_at, plan_version_item_id) \
         VALUES (?, 'local', NULL, ?, ?, ?, ?, ?)",
    )
    .bind(new_id())
    .bind(&item.media_id)
    .bind(kind.as_str())
    .bind(payload)
    .bind(Utc::now().to_rfc3339())
    .bind(&item.id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn row_to_item(row: sqlx::sqlite::SqliteRow) -> DbResult<PlaybackItem> {
    Ok(PlaybackItem {
        id: row.try_get("id")?,
        plan_version_id: row.try_get("plan_version_id")?,
        media_id: row.try_get("media_id")?,
        display_name: row.try_get("display_name")?,
        raw_start_ms: nonnegative_u64(row.try_get("raw_start_ms")?),
        raw_end_ms: nonnegative_u64(row.try_get("raw_end_ms")?),
        media_duration_ms: nonnegative_u64(row.try_get("duration_ms")?),
    })
}

fn merge_ranges(mut ranges: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    ranges.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::new();
    for (start, end) in ranges {
        if start >= end {
            continue;
        }
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

fn new_id() -> String {
    Uuid::now_v7().to_string()
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn nonnegative_u64(value: i64) -> u64 {
    u64::try_from(value.max(0)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_ranges_merge_without_double_counting() {
        assert_eq!(
            merge_ranges(vec![(10, 30), (0, 20), (50, 70), (70, 90)]),
            vec![(0, 30), (50, 90)]
        );
    }

    #[test]
    fn action_names_are_stable() {
        assert_eq!(StudyActionKind::MustWatch.as_str(), "must_watch");
        assert_eq!(StudyActionKind::Postpone.as_str(), "postpone");
    }

    #[test]
    fn repeat_and_must_watch_override_historical_coverage() {
        assert!(completion_state(Some("complete"), false));
        assert!(!completion_state(Some("repeat"), true));
        assert!(!completion_state(Some("must_watch"), true));
        assert!(completion_state(None, true));
    }
}
