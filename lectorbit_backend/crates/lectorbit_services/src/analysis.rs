//! Use-cases for verified model installs and resumable local transcription.

use std::path::{Path, PathBuf};

use chrono::Utc;
use lectorbit_ai::{builtin_models, ModelManifest, TranscriptOutput, EXPECTED_WHISPER_VERSION};
use lectorbit_db::{AnalysisRepo, DbError, ModelManifestRow, TranscriptSegmentInput};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{jobs, Job, MediaService};

#[derive(Debug, Error)]
pub enum AnalysisError {
    #[error("model not found")]
    ModelNotFound,
    #[error("model is not installed and verified")]
    ModelNotReady,
    #[error("media is unavailable")]
    MediaUnavailable,
    #[error("invalid input")]
    InvalidInput,
    #[error("database error: {0}")]
    Database(String),
    #[error("filesystem error")]
    Filesystem,
}

impl From<DbError> for AnalysisError {
    fn from(error: DbError) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<jobs::JobError> for AnalysisError {
    fn from(error: jobs::JobError) -> Self {
        Self::Database(error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelView {
    pub id: String,
    pub version: String,
    pub provider: String,
    pub expected_size_bytes: u64,
    pub architecture: String,
    pub analyzer_compatibility: String,
    pub license: String,
    pub state: String,
    pub bytes_downloaded: u64,
    pub verified_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelDownloadPayload {
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptionPayload {
    pub media_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptState {
    pub media_id: String,
    pub status: String,
    pub segment_count: u64,
    pub updated_at: Option<String>,
    pub job: Option<Job>,
}

#[derive(Debug, Clone)]
pub struct JobEnqueue {
    pub job: Job,
    pub is_new: bool,
}

#[derive(Clone)]
pub struct AnalysisService {
    repo: AnalysisRepo,
    media: MediaService,
    models_dir: PathBuf,
}

impl AnalysisService {
    pub fn new(repo: AnalysisRepo, media: MediaService, models_dir: PathBuf) -> Self {
        Self {
            repo,
            media,
            models_dir,
        }
    }

    pub async fn initialize_catalog(&self) -> Result<(), AnalysisError> {
        let rows = builtin_models()
            .into_iter()
            .map(to_manifest_row)
            .collect::<Vec<_>>();
        self.repo.sync_manifests(&rows).await?;
        Ok(())
    }

    pub async fn list_models(&self) -> Result<Vec<ModelView>, AnalysisError> {
        Ok(self
            .repo
            .list_models()
            .await?
            .into_iter()
            .map(|row| ModelView {
                id: row.manifest.id,
                version: row.manifest.version,
                provider: row.manifest.provider,
                expected_size_bytes: row.manifest.expected_size_bytes,
                architecture: row.manifest.architecture,
                analyzer_compatibility: row.manifest.analyzer_compatibility,
                license: row.manifest.license,
                state: row.state,
                bytes_downloaded: row.bytes_downloaded,
                verified_at: row.verified_at,
                last_error: row.last_error,
            })
            .collect())
    }

    pub async fn enqueue_model_download(
        &self,
        model_id: &str,
    ) -> Result<JobEnqueue, AnalysisError> {
        validate_identifier(model_id)?;
        let model = self
            .repo
            .get_model(model_id)
            .await?
            .ok_or(AnalysisError::ModelNotFound)?;
        if model.state == "ready" {
            return Err(AnalysisError::InvalidInput);
        }
        let payload = ModelDownloadPayload {
            model_id: model_id.into(),
        };
        if let Some(job) =
            jobs::find_active_by_payload(self.repo.pool(), "model_download", &payload).await?
        {
            return Ok(JobEnqueue { job, is_new: false });
        }
        let job = jobs::enqueue(self.repo.pool(), "model_download", &payload).await?;
        Ok(JobEnqueue { job, is_new: true })
    }

    pub async fn enqueue_transcription(
        &self,
        media_id: &str,
        model_id: &str,
    ) -> Result<JobEnqueue, AnalysisError> {
        validate_identifier(media_id)?;
        validate_identifier(model_id)?;
        let model = self
            .repo
            .get_model(model_id)
            .await?
            .ok_or(AnalysisError::ModelNotFound)?;
        if model.state != "ready" || model.installed_path.is_none() {
            return Err(AnalysisError::ModelNotReady);
        }
        self.media
            .resolve_authorized_media(media_id)
            .await
            .map_err(|_| AnalysisError::MediaUnavailable)?;
        let payload = TranscriptionPayload {
            media_id: media_id.into(),
            model_id: model_id.into(),
        };
        if let Some(job) =
            jobs::find_active_by_payload(self.repo.pool(), "transcribe", &payload).await?
        {
            return Ok(JobEnqueue { job, is_new: false });
        }
        let job = jobs::enqueue(self.repo.pool(), "transcribe", &payload).await?;
        Ok(JobEnqueue { job, is_new: true })
    }

    pub async fn list_jobs(&self, kind: &str, limit: u32) -> Result<Vec<Job>, AnalysisError> {
        if !matches!(kind, "model_download" | "transcribe") {
            return Err(AnalysisError::InvalidInput);
        }
        Ok(jobs::list_by_kind(self.repo.pool(), kind, limit).await?)
    }

    pub async fn transcript_state(&self, media_id: &str) -> Result<TranscriptState, AnalysisError> {
        validate_identifier(media_id)?;
        let stored = self.repo.transcript_state(media_id).await?;
        let jobs = jobs::list_by_kind(self.repo.pool(), "transcribe", 50_000).await?;
        let job = jobs.into_iter().find(|job| {
            serde_json::from_str::<TranscriptionPayload>(&job.payload)
                .is_ok_and(|payload| payload.media_id == media_id)
        });
        let status = match job.as_ref().map(|job| job.status) {
            Some(jobs::JobStatus::Queued) => "queued",
            Some(jobs::JobStatus::Running) => "processing",
            Some(jobs::JobStatus::Paused | jobs::JobStatus::RetryWait) => "attention",
            Some(jobs::JobStatus::Failed | jobs::JobStatus::Cancelled) if stored.is_none() => {
                "failed"
            }
            _ if stored.is_some() => "completed",
            _ => "not_started",
        };
        Ok(TranscriptState {
            media_id: media_id.into(),
            status: status.into(),
            segment_count: stored.as_ref().map(|value| value.1).unwrap_or(0),
            updated_at: stored.map(|value| value.0),
            job,
        })
    }

    pub async fn model_manifest(&self, model_id: &str) -> Result<ModelManifest, AnalysisError> {
        let row = self
            .repo
            .get_model(model_id)
            .await?
            .ok_or(AnalysisError::ModelNotFound)?;
        Ok(ModelManifest {
            id: row.manifest.id,
            version: row.manifest.version,
            provider: row.manifest.provider,
            source_url: row.manifest.source_url,
            expected_size_bytes: row.manifest.expected_size_bytes,
            sha256: row.manifest.sha256,
            architecture: row.manifest.architecture,
            analyzer_compatibility: row.manifest.analyzer_compatibility,
            license: row.manifest.license,
        })
    }

    pub async fn ready_model_path(&self, model_id: &str) -> Result<PathBuf, AnalysisError> {
        let model = self
            .repo
            .get_model(model_id)
            .await?
            .ok_or(AnalysisError::ModelNotFound)?;
        if model.state != "ready" {
            return Err(AnalysisError::ModelNotReady);
        }
        let stored = model.installed_path.ok_or(AnalysisError::ModelNotReady)?;
        authorize_owned_file(&self.models_dir, Path::new(&stored))
    }

    pub async fn resolve_media(&self, media_id: &str) -> Result<PathBuf, AnalysisError> {
        Ok(self
            .media
            .resolve_authorized_media(media_id)
            .await
            .map_err(|_| AnalysisError::MediaUnavailable)?
            .canonical_path)
    }

    pub async fn mark_job_running(&self, id: &str) -> Result<(), AnalysisError> {
        Ok(jobs::mark_running(self.repo.pool(), id).await?)
    }

    pub async fn mark_job_completed(&self, id: &str) -> Result<(), AnalysisError> {
        Ok(jobs::mark_completed(self.repo.pool(), id).await?)
    }

    pub async fn mark_job_failed(&self, id: &str, message: &str) -> Result<(), AnalysisError> {
        Ok(jobs::mark_failed(self.repo.pool(), id, message).await?)
    }

    pub async fn mark_model_downloading(
        &self,
        model_id: &str,
        bytes: u64,
    ) -> Result<(), AnalysisError> {
        Ok(self
            .repo
            .update_install(model_id, "downloading", bytes, None, None, None)
            .await?)
    }

    pub async fn update_model_download_progress(
        &self,
        model_id: &str,
        bytes: u64,
    ) -> Result<(), AnalysisError> {
        Ok(self.repo.update_download_progress(model_id, bytes).await?)
    }

    pub async fn mark_model_ready(
        &self,
        model_id: &str,
        bytes: u64,
        path: &Path,
    ) -> Result<(), AnalysisError> {
        let path = authorize_owned_file(&self.models_dir, path)?;
        let verified_at = Utc::now().to_rfc3339();
        Ok(self
            .repo
            .update_install(
                model_id,
                "ready",
                bytes,
                Some(&path.to_string_lossy()),
                Some(&verified_at),
                None,
            )
            .await?)
    }

    pub async fn mark_model_failed(
        &self,
        model_id: &str,
        bytes: u64,
        message: &str,
    ) -> Result<(), AnalysisError> {
        Ok(self
            .repo
            .update_install(model_id, "failed", bytes, None, None, Some(message))
            .await?)
    }

    pub async fn remove_model(&self, model_id: &str) -> Result<(), AnalysisError> {
        let model = self
            .repo
            .get_model(model_id)
            .await?
            .ok_or(AnalysisError::ModelNotFound)?;
        if model.installed_path.is_some() {
            let expected = self.models_dir.join(format!("{model_id}.bin"));
            if expected.is_file() {
                let authorized = authorize_owned_file(&self.models_dir, &expected)?;
                tokio::fs::remove_file(authorized)
                    .await
                    .map_err(|_| AnalysisError::Filesystem)?;
            }
        }
        self.repo
            .update_install(model_id, "available", 0, None, None, None)
            .await?;
        Ok(())
    }

    pub async fn save_transcript(
        &self,
        media_id: &str,
        model_id: &str,
        output: TranscriptOutput,
    ) -> Result<String, AnalysisError> {
        let segments = output
            .segments
            .into_iter()
            .map(|segment| TranscriptSegmentInput {
                start_ms: segment.start_ms,
                end_ms: segment.end_ms,
                text: segment.text,
            })
            .collect::<Vec<_>>();
        Ok(self
            .repo
            .save_transcript(
                media_id,
                model_id,
                EXPECTED_WHISPER_VERSION,
                &output.language,
                &segments,
            )
            .await?)
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }
}

fn to_manifest_row(model: ModelManifest) -> ModelManifestRow {
    ModelManifestRow {
        id: model.id,
        version: model.version,
        provider: model.provider,
        source_url: model.source_url,
        expected_size_bytes: model.expected_size_bytes,
        sha256: model.sha256,
        architecture: model.architecture,
        analyzer_compatibility: model.analyzer_compatibility,
        license: model.license,
    }
}

fn validate_identifier(value: &str) -> Result<(), AnalysisError> {
    if value.is_empty() || value.len() > 128 || value.contains(['/', '\\']) {
        return Err(AnalysisError::InvalidInput);
    }
    Ok(())
}

fn authorize_owned_file(root: &Path, file: &Path) -> Result<PathBuf, AnalysisError> {
    let root = std::fs::canonicalize(root).map_err(|_| AnalysisError::Filesystem)?;
    let file = std::fs::canonicalize(file).map_err(|_| AnalysisError::Filesystem)?;
    if !file.is_file() || !file.starts_with(root) {
        return Err(AnalysisError::Filesystem);
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_like_identifiers() {
        assert!(matches!(
            validate_identifier("../model"),
            Err(AnalysisError::InvalidInput)
        ));
        assert!(matches!(
            validate_identifier("folder\\model"),
            Err(AnalysisError::InvalidInput)
        ));
    }

    #[test]
    fn owned_file_cannot_escape_model_directory() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::NamedTempFile::new().expect("outside");
        assert!(authorize_owned_file(root.path(), outside.path()).is_err());
    }
}
