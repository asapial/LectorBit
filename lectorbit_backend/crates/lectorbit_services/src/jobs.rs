//! Persistent job table + Tokio worker orchestration.
//!
//! Replaces Redis/BullMQ from the original brief. The contract:
//!
//! - The job table is the source of truth (durable across restarts).
//! - A `JobQueue` is a thin Tokio wrapper that polls the table for `queued`
//!   rows, runs them with bounded concurrency, and writes progress events to a
//!   per-job `mpsc::Sender<JobEvent>`.
//! - Subscribers (the renderer, via the plugin) get a stream of events keyed
//!   by job id, with `start | progress | done | error` variants.
//!
//! We deliberately keep the runtime tiny — there is no separate worker
//! process. LectorBit is a single-user desktop app.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use thiserror::Error;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

/// What a job looks like in the DB.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub payload: String,
    pub status: JobStatus,
    pub attempt: u32,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Paused,
    RetryWait,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::RetryWait => "retry_wait",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "paused" => Self::Paused,
            "retry_wait" => Self::RetryWait,
            "completed" | "succeeded" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Queued,
        }
    }
}

/// Event sent to subscribers of a single job.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobEvent {
    Started {
        job_id: String,
        kind: String,
        at: DateTime<Utc>,
    },
    Progress {
        job_id: String,
        /// 0..=100.
        pct: u32,
        /// Free-form stage label (e.g. "scanning", "probing", "transcribing").
        stage: String,
        message: Option<String>,
    },
    Done {
        job_id: String,
        at: DateTime<Utc>,
    },
    Failed {
        job_id: String,
        error: String,
        at: DateTime<Utc>,
    },
}

#[derive(Debug, Error)]
pub enum JobError {
    #[error("job not found: {0}")]
    NotFound(String),
    #[error("job already in terminal state: {0}")]
    Terminal(String),
    #[error("database error: {0}")]
    Database(String),
}

/// Subscriber handle. The sender lives in `JobQueue::subscribers`; dropping the
/// receiver ends the subscription.
#[derive(Debug)]
pub struct JobSubscription {
    pub job_id: String,
    pub rx: mpsc::Receiver<JobEvent>,
}

/// In-memory broker of subscribers. Subscribers register a sender keyed by
/// job_id; when a job emits an event we fan it out to every sender.
#[derive(Debug, Default, Clone)]
pub struct JobBroker {
    inner: Arc<RwLock<HashMap<String, Vec<mpsc::Sender<JobEvent>>>>>,
}

impl JobBroker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new subscriber for `job_id`. Returns the subscription handle
    /// the caller holds onto. Drops in the channel are absorbed (a closed
    /// subscriber simply stops receiving events).
    pub async fn subscribe(&self, job_id: &str, buffer: usize) -> JobSubscription {
        let (tx, rx) = mpsc::channel(buffer);
        let mut guard = self.inner.write().await;
        guard.entry(job_id.to_string()).or_default().push(tx);
        JobSubscription {
            job_id: job_id.to_string(),
            rx,
        }
    }

    /// Broadcast an event to every subscriber of `job_id`. Slow subscribers are
    /// dropped (they fall behind and we have no use for back-pressure on a
    /// human-facing UI stream).
    pub async fn emit(&self, job_id: &str, ev: JobEvent) {
        let mut guard = self.inner.write().await;
        if let Some(subs) = guard.get_mut(job_id) {
            subs.retain(|tx| tx.try_send(ev.clone()).is_ok());
            if subs.is_empty() {
                guard.remove(job_id);
            }
        }
    }

    /// Drop subscribers for a job (called when a job reaches a terminal state).
    pub async fn finalize(&self, job_id: &str) {
        self.inner.write().await.remove(job_id);
    }
}

/// Generate a new job id (UUID v4 as text).
pub fn new_job_id() -> String {
    Uuid::new_v4().to_string()
}

/// Persist a job before any worker is spawned. This ordering is the core crash
/// recovery invariant: the UI can always observe/recover work it was told had
/// started.
pub async fn enqueue(
    pool: &SqlitePool,
    kind: &str,
    payload: &impl Serialize,
) -> Result<Job, JobError> {
    let id = new_job_id();
    let now = Utc::now();
    let payload =
        serde_json::to_string(payload).map_err(|error| JobError::Database(error.to_string()))?;
    sqlx::query(
        "INSERT INTO analysis_jobs \
         (id, kind, payload, status, attempt, last_error, created_at, updated_at) \
         VALUES (?, ?, ?, 'queued', 0, NULL, ?, ?)",
    )
    .bind(&id)
    .bind(kind)
    .bind(&payload)
    .bind(now.to_rfc3339())
    .bind(now.to_rfc3339())
    .execute(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?;
    Ok(Job {
        id,
        kind: kind.to_string(),
        payload,
        status: JobStatus::Queued,
        attempt: 0,
        last_error: None,
        created_at: now,
        updated_at: now,
    })
}

pub async fn mark_running(pool: &SqlitePool, id: &str) -> Result<(), JobError> {
    let updated = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE analysis_jobs \
         SET status = 'running', attempt = attempt + 1, last_error = NULL, updated_at = ? \
         WHERE id = ? AND status IN ('queued', 'retry_wait')",
    )
    .bind(updated)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?;
    if result.rows_affected() == 0 {
        return Err(JobError::Terminal(id.to_string()));
    }
    Ok(())
}

pub async fn mark_completed(pool: &SqlitePool, id: &str) -> Result<(), JobError> {
    mark_terminal(pool, id, JobStatus::Completed, None).await
}

pub async fn mark_failed(pool: &SqlitePool, id: &str, message: &str) -> Result<(), JobError> {
    mark_terminal(pool, id, JobStatus::Failed, Some(message)).await
}

async fn mark_terminal(
    pool: &SqlitePool,
    id: &str,
    status: JobStatus,
    message: Option<&str>,
) -> Result<(), JobError> {
    let result = sqlx::query(
        "UPDATE analysis_jobs SET status = ?, last_error = ?, updated_at = ? \
         WHERE id = ? AND status = 'running'",
    )
    .bind(status.as_str())
    .bind(message)
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?;
    if result.rows_affected() == 0 {
        return Err(JobError::Terminal(id.to_string()));
    }
    Ok(())
}

/// Every `running` row belongs to the previous process after startup. Requeue
/// it before workers begin so scans resume instead of becoming invisible.
pub async fn recover_interrupted(pool: &SqlitePool) -> Result<u64, JobError> {
    let result = sqlx::query(
        "UPDATE analysis_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'",
    )
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?;
    Ok(result.rows_affected())
}

pub async fn list_by_kind(pool: &SqlitePool, kind: &str, limit: u32) -> Result<Vec<Job>, JobError> {
    let rows = sqlx::query(
        "SELECT id, kind, payload, status, attempt, last_error, created_at, updated_at \
         FROM analysis_jobs WHERE kind = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
    )
    .bind(kind)
    .bind(i64::from(limit.min(50_000)))
    .fetch_all(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?;
    rows.into_iter().map(row_to_job).collect()
}

pub async fn get_by_id(pool: &SqlitePool, id: &str) -> Result<Job, JobError> {
    let row = sqlx::query(
        "SELECT id, kind, payload, status, attempt, last_error, created_at, updated_at \
         FROM analysis_jobs WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?
    .ok_or_else(|| JobError::NotFound(id.to_string()))?;
    row_to_job(row)
}

/// Cancel work that has not started. Running processes are deliberately not
/// reported as cancelled because the current sidecars are not cooperatively
/// interruptible yet.
pub async fn cancel_pending(pool: &SqlitePool, id: &str) -> Result<Job, JobError> {
    let result = sqlx::query(
        "UPDATE analysis_jobs SET status = 'cancelled', updated_at = ? \
         WHERE id = ? AND status IN ('queued', 'retry_wait', 'paused')",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?;
    if result.rows_affected() == 0 {
        let current = get_by_id(pool, id).await?;
        return Err(JobError::Terminal(format!(
            "{id} is {}",
            current.status.as_str()
        )));
    }
    get_by_id(pool, id).await
}

/// Requeue terminal work with the same immutable payload and attempt history.
pub async fn retry_terminal(pool: &SqlitePool, id: &str) -> Result<Job, JobError> {
    let result = sqlx::query(
        "UPDATE analysis_jobs SET status = 'queued', last_error = NULL, updated_at = ? \
         WHERE id = ? AND status IN ('failed', 'cancelled')",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?;
    if result.rows_affected() == 0 {
        let current = get_by_id(pool, id).await?;
        return Err(JobError::Terminal(format!(
            "{id} is {}",
            current.status.as_str()
        )));
    }
    get_by_id(pool, id).await
}

pub async fn find_active_by_payload(
    pool: &SqlitePool,
    kind: &str,
    payload: &impl Serialize,
) -> Result<Option<Job>, JobError> {
    let payload =
        serde_json::to_string(payload).map_err(|error| JobError::Database(error.to_string()))?;
    let row = sqlx::query(
        "SELECT id, kind, payload, status, attempt, last_error, created_at, updated_at \
         FROM analysis_jobs WHERE kind = ? AND payload = ? \
         AND status IN ('queued', 'running', 'retry_wait') \
         ORDER BY updated_at DESC, id DESC LIMIT 1",
    )
    .bind(kind)
    .bind(payload)
    .fetch_optional(pool)
    .await
    .map_err(|error| JobError::Database(error.to_string()))?;
    row.map(row_to_job).transpose()
}

fn row_to_job(row: sqlx::sqlite::SqliteRow) -> Result<Job, JobError> {
    let parse_time = |value: String| {
        DateTime::parse_from_rfc3339(&value)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|error| JobError::Database(error.to_string()))
    };
    Ok(Job {
        id: row
            .try_get("id")
            .map_err(|error| JobError::Database(error.to_string()))?,
        kind: row
            .try_get("kind")
            .map_err(|error| JobError::Database(error.to_string()))?,
        payload: row
            .try_get("payload")
            .map_err(|error| JobError::Database(error.to_string()))?,
        status: JobStatus::from_str(
            &row.try_get::<String, _>("status")
                .map_err(|error| JobError::Database(error.to_string()))?,
        ),
        attempt: row
            .try_get::<i64, _>("attempt")
            .map_err(|error| JobError::Database(error.to_string()))?
            .max(0) as u32,
        last_error: row
            .try_get("last_error")
            .map_err(|error| JobError::Database(error.to_string()))?,
        created_at: parse_time(
            row.try_get("created_at")
                .map_err(|error| JobError::Database(error.to_string()))?,
        )?,
        updated_at: parse_time(
            row.try_get("updated_at")
                .map_err(|error| JobError::Database(error.to_string()))?,
        )?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribe_then_emit_round_trips() {
        let broker = JobBroker::new();
        let mut sub = broker.subscribe("job-1", 8).await;

        broker
            .emit(
                "job-1",
                JobEvent::Progress {
                    job_id: "job-1".into(),
                    pct: 42,
                    stage: "scanning".into(),
                    message: None,
                },
            )
            .await;

        let ev = sub.rx.recv().await.expect("event");
        match ev {
            JobEvent::Progress { pct, stage, .. } => {
                assert_eq!(pct, 42);
                assert_eq!(stage, "scanning");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[tokio::test]
    async fn emit_to_unknown_job_is_no_op() {
        let broker = JobBroker::new();
        // Should not panic, should not retain anything.
        broker
            .emit(
                "missing",
                JobEvent::Done {
                    job_id: "missing".into(),
                    at: Utc::now(),
                },
            )
            .await;
        assert!(broker.inner.read().await.is_empty());
    }

    #[tokio::test]
    async fn dropped_subscriber_is_cleaned_up() {
        let broker = JobBroker::new();
        let sub = broker.subscribe("job-2", 1).await;
        // Drop the receiver; the sender inside the broker will fail on next
        // emit and get removed by `retain`.
        drop(sub.rx);
        broker
            .emit(
                "job-2",
                JobEvent::Done {
                    job_id: "job-2".into(),
                    at: Utc::now(),
                },
            )
            .await;
        assert!(broker.inner.read().await.is_empty());
    }

    #[test]
    fn job_status_round_trip() {
        for s in [
            JobStatus::Queued,
            JobStatus::Running,
            JobStatus::Paused,
            JobStatus::RetryWait,
            JobStatus::Completed,
            JobStatus::Failed,
            JobStatus::Cancelled,
        ] {
            assert_eq!(JobStatus::from_str(s.as_str()), s);
        }
    }

    #[test]
    fn new_job_id_is_unique() {
        let a = new_job_id();
        let b = new_job_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
    }

    #[tokio::test]
    async fn finalize_clears_subscribers() {
        let broker = JobBroker::new();
        let _sub = broker.subscribe("job-3", 4).await;
        assert!(!broker.inner.read().await.is_empty());
        broker.finalize("job-3").await;
        assert!(broker.inner.read().await.is_empty());
        tracing::info!("broker test ran");
    }

    #[tokio::test]
    async fn persistent_job_moves_through_lifecycle() {
        let db = lectorbit_db::Db::open_in_memory().await.expect("db");
        let job = enqueue(db.pool(), "scan", &serde_json::json!({ "root_id": "r" }))
            .await
            .expect("enqueue");
        assert_eq!(job.status, JobStatus::Queued);

        mark_running(db.pool(), &job.id).await.expect("running");
        mark_completed(db.pool(), &job.id).await.expect("completed");
        let jobs = list_by_kind(db.pool(), "scan", 10).await.expect("list");
        assert_eq!(jobs[0].status, JobStatus::Completed);
        assert_eq!(jobs[0].attempt, 1);
    }

    #[tokio::test]
    async fn recovery_requeues_running_jobs() {
        let db = lectorbit_db::Db::open_in_memory().await.expect("db");
        let job = enqueue(db.pool(), "scan", &serde_json::json!({ "root_id": "r" }))
            .await
            .expect("enqueue");
        mark_running(db.pool(), &job.id).await.expect("running");
        assert_eq!(recover_interrupted(db.pool()).await.expect("recover"), 1);
        let jobs = list_by_kind(db.pool(), "scan", 10).await.expect("list");
        assert_eq!(jobs[0].status, JobStatus::Queued);
    }

    #[tokio::test]
    async fn active_payload_lookup_is_not_limited_by_queue_size() {
        let db = lectorbit_db::Db::open_in_memory().await.expect("db");
        let payload = serde_json::json!({ "media_id": "m", "root_id": "r" });
        let job = enqueue(db.pool(), "probe", &payload)
            .await
            .expect("enqueue");
        let found = find_active_by_payload(db.pool(), "probe", &payload)
            .await
            .expect("lookup")
            .expect("active job");
        assert_eq!(found.id, job.id);
    }

    #[tokio::test]
    async fn pending_jobs_can_be_cancelled_and_retried() {
        let db = lectorbit_db::Db::open_in_memory().await.expect("db");
        let job = enqueue(db.pool(), "scan", &serde_json::json!({ "root_id": "r" }))
            .await
            .expect("enqueue");
        let cancelled = cancel_pending(db.pool(), &job.id).await.expect("cancel");
        assert_eq!(cancelled.status, JobStatus::Cancelled);
        let retried = retry_terminal(db.pool(), &job.id).await.expect("retry");
        assert_eq!(retried.status, JobStatus::Queued);
        assert_eq!(retried.attempt, 0);
    }

    #[tokio::test]
    async fn running_jobs_are_not_reported_as_cancelled() {
        let db = lectorbit_db::Db::open_in_memory().await.expect("db");
        let job = enqueue(db.pool(), "scan", &serde_json::json!({ "root_id": "r" }))
            .await
            .expect("enqueue");
        mark_running(db.pool(), &job.id).await.expect("running");
        assert!(matches!(
            cancel_pending(db.pool(), &job.id).await,
            Err(JobError::Terminal(_))
        ));
        assert_eq!(
            get_by_id(db.pool(), &job.id).await.expect("job").status,
            JobStatus::Running
        );
    }
}
