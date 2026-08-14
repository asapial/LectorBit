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
struct TimedRange {
    start_ms: u64,
    end_ms: u64,
    created_at: String,
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
        "SELECT start_ms, end_ms, created_at FROM playback_coverage_ranges \
         WHERE media_id = ? ORDER BY start_ms, end_ms",
    )
    .bind(&item.media_id)
    .fetch_all(&mut **transaction)
    .await?;
    let ranges = rows
        .into_iter()
        .map(|row| {
            Ok(TimedRange {
                start_ms: nonnegative_u64(row.try_get("start_ms")?),
                end_ms: nonnegative_u64(row.try_get("end_ms")?),
                created_at: row.try_get("created_at")?,
            })
        })
        .collect::<DbResult<Vec<_>>>()?;
    // Reopen actions are range-specific coverage reset points. Earlier ranges
    // remain append-only history, but cannot instantly complete a repeated or
    // must-watch block (including its newly-created item after a replan).
    let reset_rows = sqlx::query(
        "SELECT source.raw_start_ms, source.raw_end_ms, action.created_at \
         FROM study_actions action \
         JOIN plan_version_items source ON source.id = action.plan_version_item_id \
         WHERE source.media_id = ? \
           AND action.kind IN ('postpone', 'repeat', 'must_watch') \
         ORDER BY action.created_at, action.id",
    )
    .bind(&item.media_id)
    .fetch_all(&mut **transaction)
    .await?;
    let reset_ranges = reset_rows
        .into_iter()
        .map(|row| {
            Ok(TimedRange {
                start_ms: nonnegative_u64(row.try_get("raw_start_ms")?),
                end_ms: nonnegative_u64(row.try_get("raw_end_ms")?),
                created_at: row.try_get("created_at")?,
            })
        })
        .collect::<DbResult<Vec<_>>>()?;
    let merged = effective_coverage_ranges(ranges, &reset_ranges);
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
        .is_some_and(|kind| matches!(kind.as_str(), "complete" | "skip")))
}

fn completion_state(instruction: Option<&str>, covered_enough: bool) -> bool {
    match instruction {
        Some("complete" | "skip") => true,
        // For reopen instructions, `covered_enough` already excludes stale
        // coverage from before the applicable reset point.
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

fn effective_coverage_ranges(
    ranges: Vec<TimedRange>,
    reset_ranges: &[TimedRange],
) -> Vec<(u64, u64)> {
    let mut effective = Vec::new();
    for coverage in ranges {
        if coverage.start_ms >= coverage.end_ms {
            continue;
        }
        let mut segments = vec![(coverage.start_ms, coverage.end_ms)];
        for reset in reset_ranges.iter().filter(|reset| {
            coverage.created_at <= reset.created_at
                && reset.start_ms < reset.end_ms
                && reset.end_ms > coverage.start_ms
                && reset.start_ms < coverage.end_ms
        }) {
            let mut remaining = Vec::with_capacity(segments.len() + 1);
            for (start, end) in segments {
                if reset.end_ms <= start || reset.start_ms >= end {
                    remaining.push((start, end));
                    continue;
                }
                if start < reset.start_ms {
                    remaining.push((start, reset.start_ms.min(end)));
                }
                if reset.end_ms < end {
                    remaining.push((reset.end_ms.max(start), end));
                }
            }
            segments = remaining;
            if segments.is_empty() {
                break;
            }
        }
        effective.extend(segments);
    }
    merge_ranges(effective)
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
    use crate::{Db, PlansRepo};
    use chrono::NaiveDate;
    use lectorbit_core::planning::{DayLoad, PlanDraft, PlanningConstraints, ScheduledItem};

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
    fn reopen_actions_can_complete_again_with_fresh_coverage() {
        assert!(completion_state(Some("complete"), false));
        assert!(!completion_state(Some("repeat"), false));
        assert!(completion_state(Some("repeat"), true));
        assert!(completion_state(Some("must_watch"), true));
        assert!(completion_state(None, true));
    }

    #[test]
    fn reopen_actions_remove_only_stale_overlapping_coverage() {
        let ranges = vec![
            TimedRange {
                start_ms: 0,
                end_ms: 100,
                created_at: "2026-08-13T10:00:00Z".into(),
            },
            TimedRange {
                start_ms: 20,
                end_ms: 40,
                created_at: "2026-08-13T10:02:00Z".into(),
            },
        ];
        let resets = vec![TimedRange {
            start_ms: 20,
            end_ms: 80,
            created_at: "2026-08-13T10:01:00Z".into(),
        }];

        assert_eq!(
            effective_coverage_ranges(ranges, &resets),
            vec![(0, 40), (80, 100)]
        );
    }

    #[tokio::test]
    async fn repeat_resets_old_coverage_but_accepts_fresh_watching() {
        let db = Db::open_in_memory().await.expect("database");
        sqlx::query(
            "INSERT INTO library_roots (id, display_name, canonical_path, registered_at) \
             VALUES ('root', 'Course', 'C:/Course', '2000-01-01T00:00:00Z')",
        )
        .execute(db.pool())
        .await
        .expect("root");
        sqlx::query(
            "INSERT INTO media_files \
             (id, root_id, path, size_bytes, mtime, discovered_at, display_name, \
              media_kind, duration_ms, probe_status) \
             VALUES ('media', 'root', 'C:/Course/lesson.mp4', 1, 'now', 'now', \
                     'Lesson', 'video', 1000, 'ready')",
        )
        .execute(db.pool())
        .await
        .expect("media");
        let date = NaiveDate::from_ymd_opt(2099, 1, 1).expect("date");
        let draft = PlanDraft {
            horizon_start: date,
            horizon_end: date,
            items: vec![ScheduledItem {
                sequence: 0,
                media_id: "media".into(),
                chunk_id: "chunk".into(),
                scheduled_for: date,
                raw_start_ms: 0,
                raw_end_ms: 1_000,
                effective_duration_ms: 1_000,
                break_after_ms: 0,
            }],
            days: vec![DayLoad {
                date,
                effective_content_ms: 1_000,
                break_ms: 0,
                item_count: 1,
            }],
            unscheduled: Vec::new(),
        };
        let committed = PlansRepo::new(db.pool().clone())
            .commit(
                "local",
                "Course",
                &PlanningConstraints::default(),
                "[]",
                &draft,
            )
            .await
            .expect("plan");
        let item_id: String =
            sqlx::query_scalar("SELECT id FROM plan_version_items WHERE plan_version_id = ?")
                .bind(&committed.plan_version_id)
                .fetch_one(db.pool())
                .await
                .expect("item");
        let item = PlaybackItem {
            id: item_id,
            plan_version_id: committed.plan_version_id,
            media_id: "media".into(),
            display_name: "Lesson".into(),
            raw_start_ms: 0,
            raw_end_ms: 1_000,
            media_duration_ms: 1_000,
        };
        sqlx::query(
            "INSERT INTO playback_coverage_ranges \
             (id, media_id, start_ms, end_ms, created_at) \
             VALUES ('old', 'media', 0, 1000, '2000-01-01T00:00:00Z')",
        )
        .execute(db.pool())
        .await
        .expect("old coverage");
        let repo = Repo::new(db.pool().clone());
        repo.record_action(&item, StudyActionKind::Repeat, None)
            .await
            .expect("repeat");

        let reopened = repo.snapshot_for_item(&item).await.expect("snapshot");
        assert_eq!(reopened.item_covered_ms, 0);
        assert!(!reopened.completed);

        let saved = repo
            .checkpoint(&item, 900, None, Some((0, 900)))
            .await
            .expect("fresh checkpoint");
        let CheckpointResult::Saved(fresh) = saved else {
            panic!("unexpected checkpoint conflict");
        };
        assert_eq!(fresh.item_covered_ms, 900);
        assert!(fresh.completed);
        db.close().await;
    }
}
