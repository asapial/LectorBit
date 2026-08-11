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
                        i.effective_duration_ms, i.break_after_ms, i.status \
                 FROM plan_version_items i LEFT JOIN media_files m ON m.id = i.media_id \
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
}
