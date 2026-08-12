//! Media metadata orchestration and backend-only media authorization.

use std::path::{Path, PathBuf};

use lectorbit_db::{DbError, DiscoveredMedia, MediaPage, MediaRepo, ProbeCandidate, StoredProbe};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{jobs, Job};

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("media row not found")]
    NotFound,
    #[error("media path is outside its authorized root")]
    Unauthorized,
    #[error("media file is unavailable")]
    Unavailable,
    #[error("database error: {0}")]
    Database(String),
}

impl From<DbError> for MediaError {
    fn from(error: DbError) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<jobs::JobError> for MediaError {
    fn from(error: jobs::JobError) -> Self {
        Self::Database(error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProbeJobPayload {
    pub media_id: String,
    pub root_id: String,
}

#[derive(Debug, Clone)]
pub struct ProbeEnqueue {
    pub job: Job,
    pub is_new: bool,
}

/// Backend-only target. Absolute paths cannot be serialized across IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedMedia {
    pub media_id: String,
    pub canonical_path: PathBuf,
}

#[derive(Clone)]
pub struct MediaService {
    repo: MediaRepo,
}

impl MediaService {
    pub fn new(repo: MediaRepo) -> Self {
        Self { repo }
    }

    pub async fn reconcile_discovery(
        &self,
        root_id: &str,
        discovered: &[DiscoveredMedia],
        reconcile_missing: bool,
    ) -> Result<Vec<ProbeCandidate>, MediaError> {
        Ok(self
            .repo
            .reconcile_discovery(root_id, discovered, reconcile_missing)
            .await?)
    }

    pub async fn list_page(
        &self,
        root_id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<MediaPage, MediaError> {
        Ok(self.repo.list_page(root_id, cursor, limit).await?)
    }

    pub async fn enqueue_probe(
        &self,
        candidate: &ProbeCandidate,
    ) -> Result<ProbeEnqueue, MediaError> {
        let payload = ProbeJobPayload {
            media_id: candidate.media_id.clone(),
            root_id: candidate.root_id.clone(),
        };
        let existing = jobs::find_active_by_payload(self.repo.pool(), "probe", &payload).await?;
        if let Some(job) = existing {
            return Ok(ProbeEnqueue { job, is_new: false });
        }
        let job = jobs::enqueue(self.repo.pool(), "probe", &payload).await?;
        Ok(ProbeEnqueue { job, is_new: true })
    }

    pub async fn list_probe_jobs(&self, limit: u32) -> Result<Vec<Job>, MediaError> {
        Ok(jobs::list_by_kind(self.repo.pool(), "probe", limit).await?)
    }

    pub async fn list_unavailable_probe_candidates(
        &self,
        limit: u32,
    ) -> Result<Vec<ProbeCandidate>, MediaError> {
        Ok(self.repo.list_unavailable_probe_candidates(limit).await?)
    }

    pub async fn mark_probe_job_running(&self, id: &str) -> Result<(), MediaError> {
        Ok(jobs::mark_running(self.repo.pool(), id).await?)
    }

    pub async fn mark_probe_job_completed(&self, id: &str) -> Result<(), MediaError> {
        Ok(jobs::mark_completed(self.repo.pool(), id).await?)
    }

    pub async fn mark_probe_job_failed(&self, id: &str, message: &str) -> Result<(), MediaError> {
        Ok(jobs::mark_failed(self.repo.pool(), id, message).await?)
    }

    pub async fn resolve_authorized_media(
        &self,
        media_id: &str,
    ) -> Result<AuthorizedMedia, MediaError> {
        let target = self
            .repo
            .resolve_probe_target(media_id)
            .await?
            .ok_or(MediaError::NotFound)?;
        let media_id = target.media_id;
        let canonical_root = target.canonical_root;
        let absolute_path = target.absolute_path;
        tokio::task::spawn_blocking(move || authorize_target(&canonical_root, &absolute_path))
            .await
            .map_err(|_| MediaError::Unavailable)?
            .map(|canonical_path| AuthorizedMedia {
                media_id,
                canonical_path,
            })
    }

    pub async fn mark_probing(&self, media_id: &str) -> Result<(), MediaError> {
        Ok(self.repo.mark_probing(media_id).await?)
    }

    pub async fn save_probe_success(
        &self,
        media_id: &str,
        version: &str,
        probe: &StoredProbe,
    ) -> Result<(), MediaError> {
        Ok(self
            .repo
            .save_probe_success(media_id, version, probe)
            .await?)
    }

    pub async fn save_probe_failure(
        &self,
        media_id: &str,
        status: &str,
        safe_message: &str,
        version: &str,
    ) -> Result<(), MediaError> {
        Ok(self
            .repo
            .save_probe_failure(media_id, status, safe_message, version)
            .await?)
    }
}

fn authorize_target(root: &str, media: &str) -> Result<PathBuf, MediaError> {
    let root = std::fs::canonicalize(Path::new(root)).map_err(|_| MediaError::Unavailable)?;
    let media = std::fs::canonicalize(Path::new(media)).map_err(|_| MediaError::Unavailable)?;
    if !media.is_file() || !media.starts_with(&root) {
        return Err(MediaError::Unauthorized);
    }
    Ok(media)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_rejects_files_outside_the_root() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::NamedTempFile::new().expect("outside");
        assert!(matches!(
            authorize_target(
                &root.path().to_string_lossy(),
                &outside.path().to_string_lossy()
            ),
            Err(MediaError::Unauthorized)
        ));
    }

    #[test]
    fn authorization_accepts_a_regular_file_inside_the_root() {
        let root = tempfile::tempdir().expect("root");
        let media = root.path().join("lesson.mp4");
        std::fs::write(&media, b"media").expect("write");
        assert!(authorize_target(&root.path().to_string_lossy(), &media.to_string_lossy()).is_ok());
    }
}
