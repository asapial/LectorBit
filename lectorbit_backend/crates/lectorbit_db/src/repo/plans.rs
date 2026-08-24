//! Transactional immutable plan-version persistence.

use std::collections::BTreeMap;

use chrono::Utc;
use lectorbit_core::{PlanDraft, PlanningConstraints};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{DbError, DbResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedPlan {
    pub plan_id: String,
    pub plan_version_id: String,
    pub constraint_version_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivePlanSeed {
    pub title: String,
    pub constraints: PlanningConstraints,
    pub selections_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutineItem {
    pub id: String,
    pub media_id: String,
    pub display_name: String,
    pub chunk_id: String,
    pub sequence: u32,
    pub raw_start_ms: u64,
    pub raw_end_ms: u64,
    pub effective_duration_ms: u64,
    pub break_after_ms: u64,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutineDay {
    pub id: String,
    pub date: String,
    pub effective_content_ms: u64,
    pub break_ms: u64,
    pub items: Vec<RoutineItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutinePlan {
    pub plan_id: String,
    pub plan_version_id: String,
    pub title: String,
    pub horizon_start: String,
    pub horizon_end: String,
    pub created_at: String,
    pub days: Vec<RoutineDay>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanVersionSummaryRow {
    pub id: String,
    pub created_at: String,
    pub horizon_start: String,
    pub horizon_end: String,
    pub is_active: bool,
    pub day_count: u32,
    pub item_count: u32,
    pub effective_content_ms: u64,
    pub added_count: u32,
    pub removed_count: u32,
    pub moved_count: u32,
}

#[derive(Clone)]
pub struct Repo {
    pool: SqlitePool,
}

impl Repo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn commit(
        &self,
        user_id: &str,
        title: &str,
        constraints: &PlanningConstraints,
        selections_json: &str,
        draft: &PlanDraft,
    ) -> DbResult<CommittedPlan> {
        if !draft.is_feasible() || draft.items.is_empty() {
            return Err(DbError::Pool(
                "only non-empty feasible drafts can be committed".into(),
            ));
        }
        let mut transaction = self.pool.begin().await?;
        let now = Utc::now().to_rfc3339();
        let plan_id = match sqlx::query(
            "SELECT id FROM plans WHERE user_id = ? AND archived_at IS NULL \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            Some(row) => row.try_get("id")?,
            None => {
                let id = new_id();
                sqlx::query(
                    "INSERT INTO plans (id, user_id, title, created_at, archived_at, active_version_id) \
                     VALUES (?, ?, ?, ?, NULL, NULL)",
                )
                .bind(&id)
                .bind(user_id)
                .bind(normalize_title(title))
                .bind(&now)
                .execute(&mut *transaction)
                .await?;
                id
            }
        };

        let constraint_version_id = new_id();
        let weekdays_json = serde_json::to_string(&constraints.allowed_weekdays)
            .map_err(|_| DbError::Pool("serialize planning constraints".into()))?;
        sqlx::query(
            "INSERT INTO study_constraint_versions \
             (id, user_id, daily_budget_minutes, allowed_weekdays, preferred_session_minutes, \
              max_continuous_minutes, minimum_break_minutes, playback_speed_milli, \
              horizon_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&constraint_version_id)
        .bind(user_id)
        .bind(i64::from(constraints.daily_budget_minutes))
        .bind(weekdays_json)
        .bind(i64::from(constraints.preferred_session_minutes))
        .bind(i64::from(constraints.max_continuous_minutes))
        .bind(i64::from(constraints.minimum_break_minutes))
        .bind(i64::from(constraints.playback_speed_milli))
        .bind(i64::from(constraints.horizon_days))
        .bind(&now)
        .execute(&mut *transaction)
        .await?;

        let plan_version_id = new_id();
        sqlx::query(
            "INSERT INTO plan_versions \
             (id, plan_id, constraint_version_id, horizon_start, horizon_end, selections_json, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&plan_version_id)
        .bind(&plan_id)
        .bind(&constraint_version_id)
        .bind(draft.horizon_start.to_string())
        .bind(draft.horizon_end.to_string())
        .bind(selections_json)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;

        let mut day_ids = BTreeMap::new();
        for day in &draft.days {
            let day_id = new_id();
            sqlx::query(
                "INSERT INTO plan_version_days \
                 (id, plan_version_id, date, effective_content_ms, break_ms, item_count) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&day_id)
            .bind(&plan_version_id)
            .bind(day.date.to_string())
            .bind(to_i64(day.effective_content_ms))
            .bind(to_i64(day.break_ms))
            .bind(i64::from(day.item_count))
            .execute(&mut *transaction)
            .await?;
            day_ids.insert(day.date, day_id);
        }
        for item in &draft.items {
            let day_id = day_ids.get(&item.scheduled_for).ok_or_else(|| {
                DbError::Pool("plan item references a missing day summary".into())
            })?;
            sqlx::query(
                "INSERT INTO plan_version_items \
                 (id, plan_version_day_id, plan_version_id, media_id, chunk_id, sequence, \
                  raw_start_ms, raw_end_ms, effective_duration_ms, break_after_ms, status) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
            )
            .bind(new_id())
            .bind(day_id)
            .bind(&plan_version_id)
            .bind(&item.media_id)
            .bind(&item.chunk_id)
            .bind(i64::from(item.sequence))
            .bind(to_i64(item.raw_start_ms))
            .bind(to_i64(item.raw_end_ms))
            .bind(to_i64(item.effective_duration_ms))
            .bind(to_i64(item.break_after_ms))
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query("UPDATE plans SET active_version_id = ?, title = ? WHERE id = ?")
            .bind(&plan_version_id)
            .bind(normalize_title(title))
            .bind(&plan_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;

        Ok(CommittedPlan {
            plan_id,
            plan_version_id,
            constraint_version_id,
            created_at: now,
        })
    }

    pub async fn get_active_seed(&self, user_id: &str) -> DbResult<Option<ActivePlanSeed>> {
        let row = sqlx::query(
            "SELECT p.title, pv.selections_json, cv.daily_budget_minutes, \
                    cv.allowed_weekdays, cv.preferred_session_minutes, \
                    cv.max_continuous_minutes, cv.minimum_break_minutes, \
                    cv.playback_speed_milli, cv.horizon_days \
             FROM plans p \
             JOIN plan_versions pv ON pv.id = p.active_version_id \
             JOIN study_constraint_versions cv ON cv.id = pv.constraint_version_id \
             WHERE p.user_id = ? AND p.archived_at IS NULL \
             ORDER BY p.created_at DESC LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            let allowed_weekdays: String = row.try_get("allowed_weekdays")?;
            let constraints = PlanningConstraints {
                daily_budget_minutes: checked_u32(
                    row.try_get("daily_budget_minutes")?,
                    "daily budget",
                )?,
                allowed_weekdays: serde_json::from_str(&allowed_weekdays)
                    .map_err(|_| DbError::Pool("stored weekdays are invalid".into()))?,
                preferred_session_minutes: checked_u32(
                    row.try_get("preferred_session_minutes")?,
                    "preferred session",
                )?,
                max_continuous_minutes: checked_u32(
                    row.try_get("max_continuous_minutes")?,
                    "maximum continuous session",
                )?,
                minimum_break_minutes: checked_u32(
                    row.try_get("minimum_break_minutes")?,
                    "minimum break",
                )?,
                playback_speed_milli: checked_u16(
                    row.try_get("playback_speed_milli")?,
                    "playback speed",
                )?,
                horizon_days: checked_u16(row.try_get("horizon_days")?, "horizon")?,
            };
            constraints
                .validate()
                .map_err(|_| DbError::Pool("stored planning constraints are invalid".into()))?;
            Ok(ActivePlanSeed {
                title: row.try_get("title")?,
                constraints,
                selections_json: row.try_get("selections_json")?,
            })
        })
        .transpose()
    }

    pub async fn list_version_summaries(
        &self,
        user_id: &str,
        limit: u32,
    ) -> DbResult<Vec<PlanVersionSummaryRow>> {
        let rows = sqlx::query(
            "SELECT pv.id, pv.horizon_start, pv.horizon_end, pv.created_at, \
                    CASE WHEN p.active_version_id = pv.id THEN 1 ELSE 0 END AS is_active, \
                    (SELECT COUNT(*) FROM plan_version_days d WHERE d.plan_version_id = pv.id) AS day_count, \
                    (SELECT COALESCE(SUM(d.effective_content_ms), 0) FROM plan_version_days d \
                     WHERE d.plan_version_id = pv.id) AS effective_content_ms \
             FROM plans p JOIN plan_versions pv ON pv.plan_id = p.id \
             WHERE p.user_id = ? AND p.archived_at IS NULL \
             ORDER BY is_active DESC, pv.created_at DESC, pv.id DESC LIMIT ?",
        )
        .bind(user_id)
        .bind(i64::from(limit.clamp(1, 50)))
        .fetch_all(&self.pool)
        .await?;

        struct VersionWork {
            summary: PlanVersionSummaryRow,
            schedule: BTreeMap<String, String>,
        }
        let mut versions = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id")?;
            let schedule_rows = sqlx::query(
                "SELECT i.media_id, i.chunk_id, d.date \
                 FROM plan_version_items i JOIN plan_version_days d ON d.id = i.plan_version_day_id \
                 WHERE i.plan_version_id = ? ORDER BY i.sequence",
            )
            .bind(&id)
            .fetch_all(&self.pool)
            .await?;
            let schedule = schedule_rows
                .into_iter()
                .map(|item| {
                    Ok((
                        format!(
                            "{}:{}",
                            item.try_get::<String, _>("media_id")?,
                            item.try_get::<String, _>("chunk_id")?
                        ),
                        item.try_get("date")?,
                    ))
                })
                .collect::<DbResult<BTreeMap<_, _>>>()?;
            versions.push(VersionWork {
                summary: PlanVersionSummaryRow {
                    id,
                    created_at: row.try_get("created_at")?,
                    horizon_start: row.try_get("horizon_start")?,
                    horizon_end: row.try_get("horizon_end")?,
                    is_active: row.try_get::<i64, _>("is_active")? != 0,
                    day_count: nonnegative_u32(row.try_get("day_count")?),
                    item_count: schedule.len().min(u32::MAX as usize) as u32,
                    effective_content_ms: nonnegative_u64(row.try_get("effective_content_ms")?),
                    added_count: 0,
                    removed_count: 0,
                    moved_count: 0,
                },
                schedule,
            });
        }
        for index in 0..versions.len() {
            let Some(previous) = versions.get(index + 1).map(|version| &version.schedule) else {
                continue;
            };
            let current = &versions[index].schedule;
            let added_count = current
                .keys()
                .filter(|key| !previous.contains_key(*key))
                .count()
                .min(u32::MAX as usize) as u32;
            let removed_count = previous
                .keys()
                .filter(|key| !current.contains_key(*key))
                .count()
                .min(u32::MAX as usize) as u32;
            let moved_count = current
                .iter()
                .filter(|(key, date)| previous.get(*key).is_some_and(|old_date| old_date != *date))
                .count()
                .min(u32::MAX as usize) as u32;
            versions[index].summary.added_count = added_count;
            versions[index].summary.removed_count = removed_count;
            versions[index].summary.moved_count = moved_count;
        }
        Ok(versions
            .into_iter()
            .map(|version| version.summary)
            .collect())
    }

    pub async fn get_active_routine(
        &self,
        user_id: &str,
        day_limit: u32,
    ) -> DbResult<Option<RoutinePlan>> {
        let Some(header) = sqlx::query(
            "SELECT p.id AS plan_id, p.title, pv.id AS plan_version_id, \
                    pv.horizon_start, pv.horizon_end, pv.created_at \
             FROM plans p JOIN plan_versions pv ON pv.id = p.active_version_id \
             WHERE p.user_id = ? AND p.archived_at IS NULL \
             ORDER BY p.created_at DESC LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let plan_version_id: String = header.try_get("plan_version_id")?;
        let day_rows = sqlx::query(
            "SELECT id, date, effective_content_ms, break_ms \
             FROM plan_version_days WHERE plan_version_id = ? \
             ORDER BY date LIMIT ?",
        )
        .bind(&plan_version_id)
        .bind(i64::from(day_limit.clamp(1, 60)))
        .fetch_all(&self.pool)
        .await?;
        let mut days = Vec::with_capacity(day_rows.len());
        for day in day_rows {
            let day_id: String = day.try_get("id")?;
            let item_rows = sqlx::query(
                "SELECT i.id, i.media_id, COALESCE(m.display_name, 'Unavailable media') AS display_name, \
                        i.chunk_id, i.sequence, i.raw_start_ms, i.raw_end_ms, \
                        i.effective_duration_ms, i.break_after_ms, \
                        CASE directive.kind \
                          WHEN 'complete' THEN 'done' WHEN 'finished' THEN 'done' \
                          WHEN 'skip' THEN 'skipped' WHEN 'skipped' THEN 'skipped' \
                          WHEN 'postpone' THEN 'postponed' WHEN 'postponed' THEN 'postponed' \
                          WHEN 'repeat' THEN CASE WHEN started.id IS NOT NULL AND ( \
                            started.created_at > directive.created_at OR \
                            (started.created_at = directive.created_at AND started.id > directive.id) \
                          ) THEN 'in_progress' ELSE 'pending' END \
                          WHEN 'must_watch' THEN CASE WHEN started.id IS NOT NULL AND ( \
                            started.created_at > directive.created_at OR \
                            (started.created_at = directive.created_at AND started.id > directive.id) \
                          ) THEN 'in_progress' ELSE 'pending' END \
                          ELSE CASE WHEN started.id IS NOT NULL THEN 'in_progress' ELSE i.status END \
                        END AS status \
                 FROM plan_version_items i LEFT JOIN media_files m ON m.id = i.media_id \
                 LEFT JOIN study_actions directive ON directive.id = ( \
                   SELECT latest.id FROM study_actions latest \
                   WHERE latest.plan_version_item_id = i.id AND latest.kind IN ( \
                     'complete', 'finished', 'skip', 'skipped', 'postpone', 'postponed', \
                     'repeat', 'must_watch' \
                   ) \
                   ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1 \
                 ) \
                 LEFT JOIN study_actions started ON started.id = ( \
                   SELECT latest_started.id FROM study_actions latest_started \
                   WHERE latest_started.plan_version_item_id = i.id \
                     AND latest_started.kind = 'started' \
                   ORDER BY latest_started.created_at DESC, latest_started.id DESC LIMIT 1 \
                 ) \
                 WHERE i.plan_version_day_id = ? ORDER BY i.sequence",
            )
            .bind(&day_id)
            .fetch_all(&self.pool)
            .await?;
            let items = item_rows
                .into_iter()
                .map(|row| {
                    Ok(RoutineItem {
                        id: row.try_get("id")?,
                        media_id: row.try_get("media_id")?,
                        display_name: row.try_get("display_name")?,
                        chunk_id: row.try_get("chunk_id")?,
                        sequence: nonnegative_u32(row.try_get("sequence")?),
                        raw_start_ms: nonnegative_u64(row.try_get("raw_start_ms")?),
                        raw_end_ms: nonnegative_u64(row.try_get("raw_end_ms")?),
                        effective_duration_ms: nonnegative_u64(
                            row.try_get("effective_duration_ms")?,
                        ),
                        break_after_ms: nonnegative_u64(row.try_get("break_after_ms")?),
                        status: row.try_get("status")?,
                    })
                })
                .collect::<DbResult<Vec<_>>>()?;
            days.push(RoutineDay {
                id: day_id,
                date: day.try_get("date")?,
                effective_content_ms: nonnegative_u64(day.try_get("effective_content_ms")?),
                break_ms: nonnegative_u64(day.try_get("break_ms")?),
                items,
            });
        }
        Ok(Some(RoutinePlan {
            plan_id: header.try_get("plan_id")?,
            plan_version_id,
            title: header.try_get("title")?,
            horizon_start: header.try_get("horizon_start")?,
            horizon_end: header.try_get("horizon_end")?,
            created_at: header.try_get("created_at")?,
            days,
        }))
    }
}

fn normalize_title(title: &str) -> &str {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "My study plan"
    } else {
        trimmed
    }
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

fn nonnegative_u32(value: i64) -> u32 {
    u32::try_from(value.max(0)).unwrap_or(u32::MAX)
}

fn checked_u32(value: i64, field: &str) -> DbResult<u32> {
    u32::try_from(value).map_err(|_| DbError::Pool(format!("stored {field} is invalid")))
}

fn checked_u16(value: i64, field: &str) -> DbResult<u16> {
    u16::try_from(value).map_err(|_| DbError::Pool(format!("stored {field} is invalid")))
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use lectorbit_core::{DayLoad, PlanDraft, ScheduledItem};

    use super::*;
    use crate::Db;

    fn draft() -> PlanDraft {
        let date = NaiveDate::from_ymd_opt(2026, 8, 11).unwrap();
        PlanDraft {
            horizon_start: date,
            horizon_end: date,
            items: vec![ScheduledItem {
                sequence: 0,
                media_id: "media".into(),
                chunk_id: "chunk".into(),
                scheduled_for: date,
                raw_start_ms: 0,
                raw_end_ms: 1_500_000,
                effective_duration_ms: 1_500_000,
                break_after_ms: 0,
            }],
            days: vec![DayLoad {
                date,
                effective_content_ms: 1_500_000,
                break_ms: 0,
                item_count: 1,
            }],
            unscheduled: Vec::new(),
        }
    }

    #[tokio::test]
    async fn commit_sets_active_version_and_freezes_the_snapshot() {
        let db = Db::open_in_memory().await.expect("database");
        let repo = Repo::new(db.pool().clone());
        let committed = repo
            .commit(
                "local",
                "  Algorithms  ",
                &PlanningConstraints::default(),
                "[]",
                &draft(),
            )
            .await
            .expect("commit");

        let routine = repo
            .get_active_routine("local", 14)
            .await
            .expect("routine")
            .expect("active plan");
        assert_eq!(routine.plan_version_id, committed.plan_version_id);
        assert_eq!(routine.title, "Algorithms");
        assert_eq!(routine.days[0].items[0].display_name, "Unavailable media");

        let mutation = sqlx::query("UPDATE plan_versions SET horizon_end = ? WHERE id = ?")
            .bind("2026-09-01")
            .bind(&committed.plan_version_id)
            .execute(db.pool())
            .await;
        assert!(mutation.is_err(), "immutable plan version was updated");
    }

    #[tokio::test]
    async fn version_history_reports_blocks_moved_by_a_replan() {
        let db = Db::open_in_memory().await.expect("database");
        let repo = Repo::new(db.pool().clone());
        repo.commit(
            "local",
            "Algorithms",
            &PlanningConstraints::default(),
            "[]",
            &draft(),
        )
        .await
        .expect("initial commit");

        let mut moved = draft();
        let next_day = NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
        moved.horizon_start = next_day;
        moved.horizon_end = next_day;
        moved.items[0].scheduled_for = next_day;
        moved.days[0].date = next_day;
        repo.commit(
            "local",
            "Algorithms",
            &PlanningConstraints::default(),
            "[]",
            &moved,
        )
        .await
        .expect("replan commit");

        let history = repo
            .list_version_summaries("local", 10)
            .await
            .expect("history");
        assert_eq!(history.len(), 2);
        assert!(history[0].is_active);
        assert_eq!(history[0].moved_count, 1);
        assert_eq!(history[0].added_count, 0);
        assert_eq!(history[0].removed_count, 0);
        assert_eq!(history[0].item_count, 1);
    }

    #[tokio::test]
    async fn invalid_day_reference_rolls_back_the_transaction() {
        let db = Db::open_in_memory().await.expect("database");
        let repo = Repo::new(db.pool().clone());
        let mut invalid = draft();
        invalid.days.clear();
        assert!(repo
            .commit(
                "local",
                "Plan",
                &PlanningConstraints::default(),
                "[]",
                &invalid,
            )
            .await
            .is_err());
        let plan_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM plans")
            .fetch_one(db.pool())
            .await
            .expect("count plans");
        assert_eq!(plan_count.0, 0);
    }

    #[tokio::test]
    async fn passive_playback_events_do_not_erase_completion_directives() {
        let db = Db::open_in_memory().await.expect("database");
        let repo = Repo::new(db.pool().clone());
        let committed = repo
            .commit(
                "local",
                "Plan",
                &PlanningConstraints::default(),
                "[]",
                &draft(),
            )
            .await
            .expect("commit");
        let item_id: String =
            sqlx::query_scalar("SELECT id FROM plan_version_items WHERE plan_version_id = ?")
                .bind(&committed.plan_version_id)
                .fetch_one(db.pool())
                .await
                .expect("item");
        for (id, kind, created_at) in [
            ("01-started", "started", "2026-08-11T10:00:00Z"),
            ("02-complete", "complete", "2026-08-11T10:01:00Z"),
            ("03-paused", "paused", "2026-08-11T10:02:00Z"),
        ] {
            sqlx::query(
                "INSERT INTO study_actions \
                 (id, user_id, plan_item_id, media_id, kind, payload, created_at, plan_version_item_id) \
                 VALUES (?, 'local', NULL, NULL, ?, NULL, ?, ?)",
            )
            .bind(id)
            .bind(kind)
            .bind(created_at)
            .bind(&item_id)
            .execute(db.pool())
            .await
            .expect("action");
        }

        let routine = repo
            .get_active_routine("local", 14)
            .await
            .expect("routine")
            .expect("active plan");
        assert_eq!(routine.days[0].items[0].status, "done");

        sqlx::query(
            "INSERT INTO study_actions \
             (id, user_id, plan_item_id, media_id, kind, payload, created_at, plan_version_item_id) \
             VALUES ('04-repeat', 'local', NULL, NULL, 'repeat', NULL, \
                     '2026-08-11T10:03:00Z', ?)",
        )
        .bind(&item_id)
        .execute(db.pool())
        .await
        .expect("repeat");
        let repeated = repo
            .get_active_routine("local", 14)
            .await
            .expect("routine")
            .expect("active plan");
        assert_eq!(repeated.days[0].items[0].status, "pending");

        sqlx::query(
            "INSERT INTO study_actions \
             (id, user_id, plan_item_id, media_id, kind, payload, created_at, plan_version_item_id) \
             VALUES ('05-started', 'local', NULL, NULL, 'started', NULL, \
                     '2026-08-11T10:04:00Z', ?)",
        )
        .bind(&item_id)
        .execute(db.pool())
        .await
        .expect("restart");
        let restarted = repo
            .get_active_routine("local", 14)
            .await
            .expect("routine")
            .expect("active plan");
        assert_eq!(restarted.days[0].items[0].status, "in_progress");
        db.close().await;
    }
}
