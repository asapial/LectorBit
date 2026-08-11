//! Authorized library roots and persistent scan orchestration.

use std::path::{Path, PathBuf};

use lectorbit_db::{DbError, InsertOutcome, LibraryRoot, LibraryRootsRepo};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::jobs::{self, Job, JobStatus};

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("path does not exist or is not a directory")]
    NotADirectory,
    #[error("path is empty")]
    EmptyPath,
    #[error("I/O error: {0}")]
    Io(String),
    #[error("database error: {0}")]
    Database(String),
    #[error("library root not found")]
    NotFound,
}

impl From<DbError> for LibraryError {
    fn from(error: DbError) -> Self {
        match error {
            DbError::Path(_) => Self::EmptyPath,
            DbError::Io(message) => Self::Io(message),
            other => Self::Database(other.to_string()),
        }
    }
}

impl From<jobs::JobError> for LibraryError {
    fn from(error: jobs::JobError) -> Self {
        Self::Database(error.to_string())
    }
}

pub type LibraryResult<T> = Result<T, LibraryError>;

/// Renderer-safe root metadata. Absolute host paths never cross IPC.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LibraryRootView {
    pub id: String,
    pub display_name: String,
    pub path_redacted: String,
    pub registered_at: String,
    pub revoked_at: Option<String>,
    pub is_active: bool,
}

impl From<LibraryRoot> for LibraryRootView {
    fn from(root: LibraryRoot) -> Self {
        Self {
            id: root.id.clone(),
            display_name: root.display_name.clone(),
            path_redacted: root.path_redacted(),
            registered_at: root.registered_at.to_rfc3339(),
            revoked_at: root.revoked_at.map(|value| value.to_rfc3339()),
            is_active: root.is_active(),
        }
    }
}

/// Backend-only resolved root. This type must never be serialized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedRoot {
    pub id: String,
    pub canonical_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanJobPayload {
    pub root_id: String,
}

#[derive(Debug, Clone)]
pub struct ScanEnqueue {
    pub job: Job,
    pub is_new: bool,
}

#[derive(Clone)]
pub struct LibraryService {
    repo: LibraryRootsRepo,
}

impl LibraryService {
    pub fn new(repo: LibraryRootsRepo) -> Self {
        Self { repo }
    }

    /// Called only after the native picker returns a path. Canonicalization is
    /// offloaded so unavailable network/removable roots cannot freeze the UI.
    pub async fn register_root(
        &self,
        selected_path: &str,
        display_name: Option<&str>,
    ) -> LibraryResult<LibraryRootView> {
        let selected_path = selected_path.trim();
        if selected_path.is_empty() {
            return Err(LibraryError::EmptyPath);
        }
        let candidate = PathBuf::from(selected_path);
        let canonical = tokio::task::spawn_blocking(move || validate_root(&candidate))
            .await
            .map_err(|error| LibraryError::Io(error.to_string()))??;
        let canonical = canonical.to_string_lossy().into_owned();

        let root = match self.repo.insert_root(&canonical, display_name).await? {
            InsertOutcome::Inserted(root) => {
                self.write_audit_event("library.root.registered", &root)
                    .await;
                root
            }
            InsertOutcome::AlreadyPresent(root) => {
                tracing::info!(
                    target: "lectorbit_library",
                    root_id = %root.id,
                    "library root already registered"
                );
                root
            }
        };
        Ok(root.into())
    }

    pub async fn list_roots(&self) -> LibraryResult<Vec<LibraryRootView>> {
        Ok(self
            .repo
            .list_roots()
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub async fn list_active_roots(&self) -> LibraryResult<Vec<LibraryRootView>> {
        Ok(self
            .repo
            .list_active_roots()
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub async fn resolve_active_root(&self, id: &str) -> LibraryResult<AuthorizedRoot> {
        let root = self
            .repo
            .find_by_id(id)
            .await?
            .filter(LibraryRoot::is_active)
            .ok_or(LibraryError::NotFound)?;
        Ok(AuthorizedRoot {
            id: root.id,
            canonical_path: PathBuf::from(root.canonical_path),
        })
    }

    pub async fn revoke_root(&self, id: &str) -> LibraryResult<LibraryRootView> {
        match self.repo.revoke_root(id).await {
            Ok(root) => {
                self.write_audit_event("library.root.revoked", &root).await;
                Ok(root.into())
            }
            Err(DbError::Pool(message)) if message.contains("not found") => {
                Err(LibraryError::NotFound)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn count_roots(&self) -> LibraryResult<(i64, i64)> {
        Ok(self.repo.count_roots().await?)
    }

    /// Persist one queued scan per root. Repeated clicks return the existing
    /// active job instead of launching competing disk crawlers.
    pub async fn enqueue_scan(&self, root_id: &str) -> LibraryResult<ScanEnqueue> {
        let root = self.resolve_active_root(root_id).await?;
        let existing = jobs::list_by_kind(self.repo.pool(), "scan", 500)
            .await?
            .into_iter()
            .find(|job| {
                matches!(job.status, JobStatus::Queued | JobStatus::Running)
                    && serde_json::from_str::<ScanJobPayload>(&job.payload)
                        .is_ok_and(|payload| payload.root_id == root.id)
            });
        if let Some(job) = existing {
            return Ok(ScanEnqueue { job, is_new: false });
        }
        let job = jobs::enqueue(
            self.repo.pool(),
            "scan",
            &ScanJobPayload { root_id: root.id },
        )
        .await
        .map_err(LibraryError::from)?;
        Ok(ScanEnqueue { job, is_new: true })
    }

    async fn write_audit_event(&self, action: &str, root: &LibraryRoot) {
        let payload = serde_json::json!({
            "root_id": root.id,
            "display_name": root.display_name,
            "path_redacted": root.path_redacted(),
        })
        .to_string();
        let result = sqlx::query(
            "INSERT INTO audit_events (id, user_id, category, action, payload, created_at) \
             VALUES (?, NULL, 'library', ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(action)
        .bind(payload)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(self.repo.pool())
        .await;
        if let Err(error) = result {
            tracing::warn!(target: "lectorbit_library", %error, action, "audit write failed");
        }
    }
}

fn validate_root(path: &Path) -> LibraryResult<PathBuf> {
    let canonical = std::fs::canonicalize(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => LibraryError::NotADirectory,
        _ => LibraryError::Io(error.to_string()),
    })?;
    if !canonical.is_dir() {
        return Err(LibraryError::NotADirectory);
    }
    Ok(strip_windows_verbatim_prefix(canonical))
}

fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let rendered = path.to_string_lossy().into_owned();
    rendered
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lectorbit_db::Db;

    async fn fixture() -> (Db, LibraryService, tempfile::TempDir) {
        let db = Db::open_in_memory().await.expect("database");
        let service = LibraryService::new(LibraryRootsRepo::new(db.pool().clone()));
        let directory = tempfile::tempdir().expect("tempdir");
        (db, service, directory)
    }

    #[tokio::test]
    async fn registration_is_idempotent_and_renderer_safe() {
        let (db, service, directory) = fixture().await;
        let selected = directory.path().to_string_lossy();
        let first = service
            .register_root(&selected, None)
            .await
            .expect("register");
        let second = service
            .register_root(&selected, Some("ignored"))
            .await
            .expect("repeat");
        assert_eq!(first.id, second.id);
        assert!(first.path_redacted.starts_with("[REDACTED]"));
        assert!(!serde_json::to_string(&first)
            .expect("serialize")
            .contains(directory.path().to_string_lossy().as_ref()));
        db.close().await;
    }

    #[tokio::test]
    async fn registration_and_revocation_are_audited() {
        let (db, service, directory) = fixture().await;
        let root = service
            .register_root(&directory.path().to_string_lossy(), None)
            .await
            .expect("register");
        service.revoke_root(&root.id).await.expect("revoke");
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE category = 'library'")
                .fetch_one(db.pool())
                .await
                .expect("audit count");
        assert_eq!(count, 2);
        db.close().await;
    }

    #[tokio::test]
    async fn enqueue_scan_is_persistent_and_deduplicated() {
        let (db, service, directory) = fixture().await;
        let root = service
            .register_root(&directory.path().to_string_lossy(), None)
            .await
            .expect("register");
        let first = service.enqueue_scan(&root.id).await.expect("enqueue");
        let second = service.enqueue_scan(&root.id).await.expect("deduplicate");
        assert_eq!(first.job.id, second.job.id);
        assert!(first.is_new);
        assert!(!second.is_new);
        assert_eq!(first.job.status, JobStatus::Queued);
        db.close().await;
    }

    #[tokio::test]
    async fn revoked_roots_cannot_be_resolved_or_scanned() {
        let (db, service, directory) = fixture().await;
        let root = service
            .register_root(&directory.path().to_string_lossy(), None)
            .await
            .expect("register");
        service.revoke_root(&root.id).await.expect("revoke");
        assert!(matches!(
            service.enqueue_scan(&root.id).await,
            Err(LibraryError::NotFound)
        ));
        db.close().await;
    }
}
