use std::sync::Arc;

use lectorbit_db::{AiRequestsRepo, LearningRepo};
use lectorbit_services::{cancel_pending, get_by_id, retry_terminal, Job};
use tauri_plugin_lectorbit::{
    AiArtifactSummaryDto, AiRequestEventDto, AiStudioOps, AnalysisJobDto, BoxFuture,
    LearningErrorCode, LearningErrorKind,
};

use crate::analysis_adapter::AnalysisAdapter;
use crate::library_adapter::LibraryAdapter;
use crate::media_adapter::ProbeScheduler;
use crate::openrouter_learning_adapter::OpenRouterLearningAdapter;

#[derive(Clone)]
pub struct AiStudioAdapter {
    learning: LearningRepo,
    requests: AiRequestsRepo,
    analysis_worker: Arc<AnalysisAdapter>,
    learning_worker: Arc<OpenRouterLearningAdapter>,
    library_worker: Arc<LibraryAdapter>,
    probe_worker: ProbeScheduler,
}

impl AiStudioAdapter {
    pub fn new(
        learning: LearningRepo,
        requests: AiRequestsRepo,
        analysis_worker: Arc<AnalysisAdapter>,
        learning_worker: Arc<OpenRouterLearningAdapter>,
        library_worker: Arc<LibraryAdapter>,
        probe_worker: ProbeScheduler,
    ) -> Self {
        Self {
            learning,
            requests,
            analysis_worker,
            learning_worker,
            library_worker,
            probe_worker,
        }
    }
}

impl AiStudioOps for AiStudioAdapter {
    fn list_artifacts(
        &self,
        include_superseded: bool,
        limit: u32,
    ) -> BoxFuture<'_, Result<Vec<AiArtifactSummaryDto>, LearningErrorCode>> {
        Box::pin(async move {
            if limit == 0 || limit > 1000 {
                return Err(invalid_input("Choose between 1 and 1000 artifacts."));
            }
            self.learning
                .list_artifact_summaries(include_superseded, limit)
                .await
                .map_err(database_error)
                .map(|rows| {
                    rows.into_iter()
                        .map(|row| AiArtifactSummaryDto {
                            id: row.id,
                            media_id: row.media_id,
                            display_name: row.display_name,
                            transcript_id: row.transcript_id,
                            kind: row.kind,
                            model: row.model_id,
                            prompt_version: row.prompt_version,
                            created_at: row.created_at,
                            superseded_at: row.superseded_at,
                            stale: row.stale,
                        })
                        .collect()
                })
        })
    }

    fn list_request_activity(
        &self,
        limit: u32,
    ) -> BoxFuture<'_, Result<Vec<AiRequestEventDto>, LearningErrorCode>> {
        Box::pin(async move {
            if limit == 0 || limit > 500 {
                return Err(invalid_input("Choose between 1 and 500 AI requests."));
            }
            self.requests
                .list_provenance(limit)
                .await
                .map_err(database_error)
                .map(|rows| {
                    rows.into_iter()
                        .map(|row| AiRequestEventDto {
                            id: row.id,
                            provider: row.provider,
                            capability: row.capability,
                            prompt_id: row.prompt_id,
                            prompt_version: row.prompt_version,
                            requested_model: row.requested_model,
                            resolved_model: row.resolved_model,
                            request_bytes: row.request_bytes,
                            response_bytes: row.response_bytes,
                            duration_ms: row.duration_ms,
                            total_tokens: row.total_tokens,
                            result: row.result,
                            error_kind: row.error_kind,
                            consent_scope: row.consent_scope,
                            created_at: row.created_at,
                        })
                        .collect()
                })
        })
    }

    fn list_jobs(
        &self,
        limit: u32,
    ) -> BoxFuture<'_, Result<Vec<AnalysisJobDto>, LearningErrorCode>> {
        Box::pin(async move {
            if limit == 0 || limit > 500 {
                return Err(invalid_input("Choose between 1 and 500 jobs."));
            }
            let mut jobs = Vec::new();
            for kind in [
                "model_download",
                "transcribe",
                "lecture_understanding",
                "scan",
                "probe",
            ] {
                jobs.extend(
                    lectorbit_services::list_by_kind(self.learning.pool(), kind, limit)
                        .await
                        .map_err(|error| {
                            database_error(lectorbit_db::DbError::Pool(error.to_string()))
                        })?,
                );
            }
            jobs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            jobs.truncate(limit as usize);
            Ok(jobs.into_iter().map(job_dto).collect())
        })
    }

    fn cancel_job(
        &self,
        job_id: String,
    ) -> BoxFuture<'_, Result<AnalysisJobDto, LearningErrorCode>> {
        Box::pin(async move {
            validate_job_id(&job_id)?;
            cancel_pending(self.learning.pool(), &job_id)
                .await
                .map(job_dto)
                .map_err(|error| job_control_error(error, "Only queued work can be cancelled."))
        })
    }

    fn retry_job(
        &self,
        job_id: String,
    ) -> BoxFuture<'_, Result<AnalysisJobDto, LearningErrorCode>> {
        Box::pin(async move {
            validate_job_id(&job_id)?;
            let current = get_by_id(self.learning.pool(), &job_id)
                .await
                .map_err(|error| job_control_error(error, "The job could not be found."))?;
            if !matches!(
                current.kind.as_str(),
                "model_download" | "transcribe" | "lecture_understanding" | "scan" | "probe"
            ) {
                return Err(invalid_input("This job type cannot be retried."));
            }
            let job = retry_terminal(self.learning.pool(), &job_id)
                .await
                .map_err(|error| {
                    job_control_error(error, "Only failed or cancelled work can be retried.")
                })?;
            self.dispatch(job.clone())?;
            Ok(job_dto(job))
        })
    }
}

impl AiStudioAdapter {
    fn dispatch(&self, job: Job) -> Result<(), LearningErrorCode> {
        match job.kind.as_str() {
            "model_download" | "transcribe" => self
                .analysis_worker
                .resume_job(job)
                .map_err(|_| internal_job_error()),
            "lecture_understanding" => self.learning_worker.resume_job(job),
            "scan" => self
                .library_worker
                .resume_job(job)
                .map_err(|_| internal_job_error()),
            "probe" => self
                .probe_worker
                .resume_job(job)
                .map_err(|_| internal_job_error()),
            _ => Err(invalid_input("This job type cannot be retried.")),
        }
    }
}

fn job_dto(job: Job) -> AnalysisJobDto {
    AnalysisJobDto {
        id: job.id,
        kind: job.kind,
        status: job.status.as_str().into(),
        attempt: job.attempt,
        last_error: job.last_error,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}

fn validate_job_id(job_id: &str) -> Result<(), LearningErrorCode> {
    if job_id.trim().is_empty() || job_id.len() > 128 {
        return Err(invalid_input("Choose a valid job."));
    }
    Ok(())
}

fn invalid_input(message: &str) -> LearningErrorCode {
    LearningErrorCode::new(LearningErrorKind::InvalidInput, message)
}

fn database_error(error: lectorbit_db::DbError) -> LearningErrorCode {
    tracing::warn!(target: "ai_studio", %error, "AI Studio query failed");
    LearningErrorCode::new(
        LearningErrorKind::Database,
        "The local AI operations history could not be loaded.",
    )
}

fn job_control_error(error: lectorbit_services::JobError, message: &str) -> LearningErrorCode {
    tracing::warn!(target: "ai_studio", %error, "AI Studio job action rejected");
    LearningErrorCode::new(LearningErrorKind::InvalidInput, message)
}

fn internal_job_error() -> LearningErrorCode {
    LearningErrorCode::new(
        LearningErrorKind::Database,
        "The job was queued, but its worker could not be started.",
    )
}
