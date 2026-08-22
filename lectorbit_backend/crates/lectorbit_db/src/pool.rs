//! SQLite connection pool wiring.
//!
//! LectorBit is a single-process desktop app, so the pool is intentionally
//! small (max 5 connections). The WAL journal mode lets readers and writers
//! work concurrently as long as there's exactly one writer at a time.
//!
//! PRAGMAs applied on every new connection (see [`apply_pragmas`]):
//!
//! - `journal_mode = WAL`         — concurrent reads, durable writes
//! - `foreign_keys = ON`          — required by the schema
//! - `busy_timeout = 5000`        — wait up to 5s on locks instead of failing
//! - `synchronous = NORMAL`       — safe with WAL, much faster than FULL
//! - `temp_store = MEMORY`        — temporary tables live in RAM
//! - `cache_size = -64000`        — ~64MB of page cache (negative = KiB)

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use log::LevelFilter;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{ConnectOptions, SqlitePool};

use crate::error::{DbError, DbResult};

/// The handle every service holds instead of a raw `SqlitePool`.
///
/// Cheap to clone (it's a single `Arc` under the hood). All access is read-only
/// from the outside; services that need to mutate the schema must go through
/// the `Db::migrate` boundary, which is intentionally `pub(crate)`.
#[derive(Clone, Debug)]
pub struct Db {
    pool: SqlitePool,
    path: Option<PathBuf>,
}

impl Db {
    /// Open (or create) a SQLite database at `path`, run migrations, and apply
    /// the project's PRAGMAs to every connection.
    pub async fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        let path = path.as_ref();
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true)
            .log_statements(LevelFilter::Debug)
            .log_slow_statements(LevelFilter::Warn, Duration::from_millis(500));

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(opts)
            .await
            .map_err(|e| DbError::Pool(e.to_string()))?;

        apply_pragmas(&pool).await?;

        let db = Self {
            pool,
            path: Some(path.to_path_buf()),
        };
        db.migrate().await?;
        Ok(db)
    }

    /// Open an in-memory database. Used in tests and for ad-hoc tooling.
    pub async fn open_in_memory() -> DbResult<Self> {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Memory)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            // Each `:memory:` SQLite connection owns a separate database.
            // Keep the test/tooling pool on one connection so migrations and
            // repository queries always see the same schema.
            .max_connections(1)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(opts)
            .await
            .map_err(|e| DbError::Pool(e.to_string()))?;

        apply_pragmas(&pool).await?;

        let db = Self { pool, path: None };
        db.migrate().await?;
        Ok(db)
    }

    /// Run the embedded migrations. Idempotent.
    pub(crate) async fn migrate(&self) -> DbResult<()> {
        crate::migrations::MIGRATOR
            .run(&self.pool)
            .await
            .map_err(|e| DbError::Migrate(e.to_string()))
    }

    /// Borrow the underlying pool. Use sparingly — prefer [`Db::acquire`].
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Acquire a single connection. Most callers should just use the pool.
    pub async fn acquire(&self) -> DbResult<sqlx::pool::PoolConnection<sqlx::Sqlite>> {
        self.pool
            .acquire()
            .await
            .map_err(|e| DbError::Pool(e.to_string()))
    }

    /// Path to the file backing this DB, if any (None for `:memory:`).
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Close the pool. After this, callers should construct a new `Db`.
    pub async fn close(self) {
        self.pool.close().await;
    }

    /// Convenience: run a single read-only statement and read one row.
    pub async fn ping(&self) -> DbResult<()> {
        let row: (i64,) = sqlx::query_as("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .map_err(DbError::from)?;
        if row.0 != 1 {
            return Err(DbError::Pool("ping returned non-one".into()));
        }
        Ok(())
    }
}

/// Apply the LectorBit house-style PRAGMAs to every connection in `pool`.
async fn apply_pragmas(pool: &SqlitePool) -> DbResult<()> {
    let pragmas: &[(&str, &str, &str)] = &[
        ("journal_mode", "WAL", "PRAGMA journal_mode = WAL"),
        ("foreign_keys", "ON", "PRAGMA foreign_keys = ON"),
        ("busy_timeout", "5000", "PRAGMA busy_timeout = 5000"),
        ("synchronous", "NORMAL", "PRAGMA synchronous = NORMAL"),
        ("temp_store", "MEMORY", "PRAGMA temp_store = MEMORY"),
        ("cache_size", "-64000", "PRAGMA cache_size = -64000"),
    ];

    for (key, value, statement) in pragmas {
        // SQLx 0.9 accepts literal SQL by default. Keeping each PRAGMA as a
        // literal preserves that audit boundary and prevents configuration
        // values from becoming dynamic SQL later.
        sqlx::query(*statement)
            .execute(pool)
            .await
            .map_err(|e| DbError::Pragma(format!("{key} -> {value}: {e}")))?;
    }

    // Verify journal_mode came back as WAL (it will silently degrade to MEMORY
    // for `:memory:` or read-only files; we don't fail on that, we just log).
    let journal: (String,) = sqlx::query_as("PRAGMA journal_mode")
        .fetch_one(pool)
        .await?;
    let journal = SqliteJournalMode::from_str(&journal.0).unwrap_or(SqliteJournalMode::Memory);
    tracing::debug!(target: "lectorbit_db", ?journal, "sqlite journal mode applied");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_in_memory_pings() {
        let db = Db::open_in_memory().await.expect("open");
        db.ping().await.expect("ping");
        db.close().await;
    }

    #[tokio::test]
    async fn migrations_are_idempotent() {
        let db = Db::open_in_memory().await.expect("open");
        // Re-running migrate() on the same Db should be a no-op.
        db.migrate().await.expect("migrate again");
        db.close().await;
    }

    #[tokio::test]
    async fn required_tables_exist() {
        let db = Db::open_in_memory().await.expect("open");
        for table in [
            "schema_meta",
            "library_roots",
            "folders",
            "media_files",
            "media_streams",
            "analysis_jobs",
            "study_constraints",
            "plans",
            "plan_days",
            "plan_items",
            "playback_progress",
            "study_actions",
            "settings",
            "consent_events",
            "ai_request_events",
            "audit_events",
            "chunks",
            "study_constraint_versions",
            "plan_versions",
            "plan_version_days",
            "plan_version_items",
        ] {
            let exists: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(table)
            .fetch_one(db.pool())
            .await
            .expect("query master");
            assert_eq!(exists.0, 1, "missing table {table}");
        }
        db.close().await;
    }

    #[tokio::test]
    async fn foreign_keys_are_enforced() {
        let db = Db::open_in_memory().await.expect("open");
        let bad = sqlx::query(
            "INSERT INTO media_files (id, root_id, path, size_bytes, mtime, discovered_at) \
             VALUES (?, ?, ?, 0, '', '')",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(uuid::Uuid::new_v4().to_string()) // unknown root -> FK fail
        .bind("/missing/root.mp4")
        .execute(db.pool())
        .await;

        assert!(bad.is_err(), "FK insert should fail");
    }

    #[tokio::test]
    async fn persisted_file_round_trips() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("roundtrip.sqlite");
        let db = Db::open(&path).await.expect("open file");
        // Round-trip: insert a settings row, then a Tx, close, reopen, read.
        sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
            .bind("app")
            .bind("{\"theme\":\"dark\"}")
            .bind("2026-08-08T00:00:00Z")
            .execute(db.pool())
            .await
            .expect("insert");
        db.close().await;

        let db2 = Db::open(&path).await.expect("reopen");
        let value: (String,) = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
            .bind("app")
            .fetch_one(db2.pool())
            .await
            .expect("query");
        assert_eq!(value.0, "{\"theme\":\"dark\"}");
        db2.close().await;
    }
}
