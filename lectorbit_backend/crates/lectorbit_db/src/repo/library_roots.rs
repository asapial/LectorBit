//! Repository for the `library_roots` table.
//!
//! `LibraryRoot` is the row shape; [`Repo`] is the only thing that touches the
//! table. Every operation is pure data, no I/O outside of SQLx, so the unit
//! tests run against `Db::open_in_memory()` and never touch disk.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::error::{DbError, DbResult};

/// A row from `library_roots`.
///
/// `revoked_at == None` means the root is active. We keep revoked rows around
/// (soft delete) so the audit log + UI can still show them and so the scanner
/// can skip them cheaply with a single index hit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryRoot {
    pub id: String,
    pub display_name: String,
    pub canonical_path: String,
    pub registered_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl LibraryRoot {
    /// True when the root is currently active (not revoked).
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }

    /// Render the path for the UI. We always redact the parent and keep only
    /// the basename to avoid leaking the host filesystem layout.
    pub fn path_redacted(&self) -> String {
        redact_for_display(&self.canonical_path)
    }
}

/// Outcome of [`Repo::insert_root`].
///
/// `Inserted` means a new row was added or a previously revoked row was
/// reactivated. `AlreadyPresent` means the same canonical path is already
/// active, so the caller can treat registration as an idempotent no-op.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertOutcome {
    Inserted(LibraryRoot),
    AlreadyPresent(LibraryRoot),
}

/// SQLx-backed repository.
#[derive(Clone)]
pub struct Repo {
    pool: SqlitePool,
}

impl Repo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Borrow the underlying pool. Used by the service layer to write
    /// auxiliary rows (e.g. `audit_events`) on the same connection pool.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Insert a new root. `display_name` defaults to the basename of
    /// `canonical_path` when the caller passes an empty string.
    ///
    /// Canonical-path uniqueness is enforced by the schema. If a row already
    /// exists we return [`InsertOutcome::AlreadyPresent`] instead of erroring
    /// so the service layer can stay idempotent.
    pub async fn insert_root(
        &self,
        canonical_path: &str,
        display_name: Option<&str>,
    ) -> DbResult<InsertOutcome> {
        if canonical_path.trim().is_empty() {
            return Err(DbError::Path("canonical_path is empty".into()));
        }
        let name = match display_name {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => derive_display_name(canonical_path),
        };
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        let res = sqlx::query(
            "INSERT INTO library_roots (id, display_name, canonical_path, registered_at) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&name)
        .bind(canonical_path)
        .bind(&now_str)
        .execute(&self.pool)
        .await;

        match res {
            Ok(_) => Ok(InsertOutcome::Inserted(LibraryRoot {
                id,
                display_name: name,
                canonical_path: canonical_path.to_string(),
                registered_at: now,
                revoked_at: None,
            })),
            Err(sqlx::Error::Database(db_err)) if is_unique_violation(db_err.as_ref()) => {
                let mut existing = self
                    .find_by_canonical_path(canonical_path)
                    .await?
                    .ok_or_else(|| {
                        DbError::Pool("UNIQUE violation but row vanished on lookup".into())
                    })?;
                if existing.revoked_at.is_some() {
                    let reactivated_at = Utc::now();
                    sqlx::query(
                        "UPDATE library_roots SET revoked_at = NULL, registered_at = ? WHERE id = ?",
                    )
                    .bind(reactivated_at.to_rfc3339())
                    .bind(&existing.id)
                    .execute(&self.pool)
                    .await?;
                    existing.registered_at = reactivated_at;
                    existing.revoked_at = None;
                    return Ok(InsertOutcome::Inserted(existing));
                }
                Ok(InsertOutcome::AlreadyPresent(existing))
            }
            Err(e) => Err(DbError::from(e)),
        }
    }

    /// Return every root (active + revoked), newest first.
    pub async fn list_roots(&self) -> DbResult<Vec<LibraryRoot>> {
        let rows = sqlx::query(
            "SELECT id, display_name, canonical_path, registered_at, revoked_at \
             FROM library_roots ORDER BY registered_at DESC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(row_to_root).collect()
    }

    /// Return only active roots, newest first.
    pub async fn list_active_roots(&self) -> DbResult<Vec<LibraryRoot>> {
        let rows = sqlx::query(
            "SELECT id, display_name, canonical_path, registered_at, revoked_at \
             FROM library_roots WHERE revoked_at IS NULL \
             ORDER BY registered_at DESC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(row_to_root).collect()
    }

    /// Look up by canonical path. Used to handle duplicate-insert responses.
    pub async fn find_by_canonical_path(
        &self,
        canonical_path: &str,
    ) -> DbResult<Option<LibraryRoot>> {
        let row = sqlx::query(
            "SELECT id, display_name, canonical_path, registered_at, revoked_at \
             FROM library_roots WHERE canonical_path = ?",
        )
        .bind(canonical_path)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_root).transpose()
    }

    /// Look up by id. Used by the revoke command and tests.
    pub async fn find_by_id(&self, id: &str) -> DbResult<Option<LibraryRoot>> {
        let row = sqlx::query(
            "SELECT id, display_name, canonical_path, registered_at, revoked_at \
             FROM library_roots WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_root).transpose()
    }

    /// Soft-revoke a root by id. Idempotent: revoking an already-revoked root
    /// is a no-op (returns the existing row).
    pub async fn revoke_root(&self, id: &str) -> DbResult<LibraryRoot> {
        let existing = self
            .find_by_id(id)
            .await?
            .ok_or_else(|| DbError::Pool(format!("library root not found: {id}")))?;
        if existing.revoked_at.is_some() {
            return Ok(existing);
        }
        let now_str = Utc::now().to_rfc3339();
        sqlx::query("UPDATE library_roots SET revoked_at = ? WHERE id = ?")
            .bind(&now_str)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(LibraryRoot {
            revoked_at: Some(Utc::now()),
            ..existing
        })
    }

    /// Counts for the diagnostics panel.
    pub async fn count_roots(&self) -> DbResult<(i64, i64)> {
        let row = sqlx::query(
            "SELECT \
                SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active, \
                COUNT(*) AS total \
             FROM library_roots",
        )
        .fetch_one(&self.pool)
        .await?;
        let active: Option<i64> = row.try_get("active").unwrap_or(None);
        let total: i64 = row.try_get("total").unwrap_or(0);
        Ok((active.unwrap_or(0), total))
    }
}

fn row_to_root(row: sqlx::sqlite::SqliteRow) -> DbResult<LibraryRoot> {
    let id: String = row.try_get("id")?;
    let display_name: String = row.try_get("display_name")?;
    let canonical_path: String = row.try_get("canonical_path")?;
    let registered_at_str: String = row.try_get("registered_at")?;
    let revoked_at_str: Option<String> = row.try_get("revoked_at")?;
    let registered_at = DateTime::parse_from_rfc3339(&registered_at_str)
        .map_err(|e| DbError::Pool(format!("registered_at not RFC3339: {e}")))?
        .with_timezone(&Utc);
    let revoked_at = revoked_at_str
        .map(|s| {
            DateTime::parse_from_rfc3339(&s)
                .map(|dt| dt.with_timezone(&Utc))
                .map_err(|e| DbError::Pool(format!("revoked_at not RFC3339: {e}")))
        })
        .transpose()?;
    Ok(LibraryRoot {
        id,
        display_name,
        canonical_path,
        registered_at,
        revoked_at,
    })
}

fn is_unique_violation(err: &dyn sqlx::error::DatabaseError) -> bool {
    // SQLite reports UNIQUE violations as `SQLITE_CONSTRAINT_UNIQUE` (code 2067)
    // and generic constraint failures as `SQLITE_CONSTRAINT` (code 19). We
    // accept either because sqlx sometimes collapses them.
    let code = err.code().map(|c| c.to_string()).unwrap_or_default();
    code == "2067" || code == "19" || err.message().contains("UNIQUE")
}

fn derive_display_name(canonical_path: &str) -> String {
    let last = canonical_path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(canonical_path);
    if last.is_empty() {
        canonical_path.to_string()
    } else {
        last.to_string()
    }
}

/// Same redaction rule the diagnostics module uses: keep only the basename.
fn redact_for_display(path: &str) -> String {
    let last = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path);
    if last.is_empty() {
        "[REDACTED]".into()
    } else {
        format!("[REDACTED]/{last}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pool::Db;

    async fn fresh_db() -> Db {
        Db::open_in_memory().await.expect("open in-memory")
    }

    #[tokio::test]
    async fn insert_then_list_round_trips() {
        let db = fresh_db().await;
        let repo = Repo::new(db.pool().clone());

        let outcome = repo
            .insert_root("/home/me/Videos", None)
            .await
            .expect("insert");
        let inserted = match outcome {
            InsertOutcome::Inserted(r) => r,
            InsertOutcome::AlreadyPresent(_) => panic!("should be Inserted"),
        };
        assert_eq!(inserted.display_name, "Videos");
        assert!(inserted.is_active());

        let roots = repo.list_roots().await.expect("list");
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, inserted.id);

        let (active, total) = repo.count_roots().await.expect("count");
        assert_eq!(active, 1);
        assert_eq!(total, 1);
        db.close().await;
    }

    #[tokio::test]
    async fn duplicate_canonical_path_is_idempotent() {
        let db = fresh_db().await;
        let repo = Repo::new(db.pool().clone());

        let first = repo
            .insert_root("/home/me/Videos", None)
            .await
            .expect("insert 1");
        let second = repo
            .insert_root("/home/me/Videos", Some("renamed"))
            .await
            .expect("insert 2");

        // Display-name update is NOT performed on duplicate: original row
        // wins so the UI shows a stable name.
        let rows = repo.list_roots().await.expect("list");
        assert_eq!(rows.len(), 1);
        match (first, second) {
            (InsertOutcome::Inserted(a), InsertOutcome::AlreadyPresent(b)) => {
                assert_eq!(a.id, b.id);
                assert_eq!(b.display_name, "Videos");
            }
            _ => panic!("unexpected outcomes"),
        }
        db.close().await;
    }

    #[tokio::test]
    async fn revoke_then_re_revoke_is_idempotent() {
        let db = fresh_db().await;
        let repo = Repo::new(db.pool().clone());

        let outcome = repo
            .insert_root("/data/lectures", None)
            .await
            .expect("insert");
        let id = match outcome {
            InsertOutcome::Inserted(r) => r.id,
            InsertOutcome::AlreadyPresent(_) => panic!("first should be Inserted"),
        };

        let once = repo.revoke_root(&id).await.expect("revoke once");
        assert!(once.revoked_at.is_some());

        let twice = repo.revoke_root(&id).await.expect("revoke twice");
        assert!(twice.revoked_at.is_some());

        let active = repo.list_active_roots().await.expect("list active");
        assert_eq!(active.len(), 0);
        let (active_count, total_count) = repo.count_roots().await.expect("count");
        assert_eq!(active_count, 0);
        assert_eq!(total_count, 1);
        db.close().await;
    }

    #[tokio::test]
    async fn selecting_a_revoked_root_reactivates_it() {
        let db = fresh_db().await;
        let repo = Repo::new(db.pool().clone());
        let path = "/data/reselectable";
        let id = match repo.insert_root(path, None).await.expect("insert") {
            InsertOutcome::Inserted(root) => root.id,
            InsertOutcome::AlreadyPresent(_) => panic!("first should be inserted"),
        };
        repo.revoke_root(&id).await.expect("revoke");

        let reactivated = match repo.insert_root(path, None).await.expect("reactivate") {
            InsertOutcome::Inserted(root) => root,
            InsertOutcome::AlreadyPresent(_) => panic!("revoked root should reactivate"),
        };

        assert_eq!(reactivated.id, id);
        assert!(reactivated.is_active());
        assert_eq!(repo.list_active_roots().await.expect("active").len(), 1);
        db.close().await;
    }

    #[tokio::test]
    async fn revoke_unknown_id_returns_error() {
        let db = fresh_db().await;
        let repo = Repo::new(db.pool().clone());
        let err = repo.revoke_root("does-not-exist").await.unwrap_err();
        // We don't enforce a typed NotFound variant yet; the string is the
        // signal the service layer uses.
        assert!(format!("{err}").contains("not found"));
        db.close().await;
    }

    #[tokio::test]
    async fn empty_path_is_rejected() {
        let db = fresh_db().await;
        let repo = Repo::new(db.pool().clone());
        let err = repo.insert_root("   ", None).await.unwrap_err();
        assert!(format!("{err}").contains("empty"));
        db.close().await;
    }

    #[test]
    fn derive_display_name_handles_trailing_separators() {
        assert_eq!(derive_display_name("/home/me/Videos/"), "Videos");
        assert_eq!(derive_display_name("C:\\Users\\me\\Videos\\"), "Videos");
        assert_eq!(derive_display_name("plain"), "plain");
    }

    #[test]
    fn redact_for_display_keeps_only_basename() {
        assert_eq!(redact_for_display("/home/me/Videos"), "[REDACTED]/Videos");
        assert_eq!(redact_for_display("plain"), "[REDACTED]/plain");
        assert_eq!(redact_for_display("/"), "[REDACTED]");
    }
}
