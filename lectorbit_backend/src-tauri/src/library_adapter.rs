use std::sync::Arc;

use lectorbit_services::{Job, JobStatus, LibraryService, ScanJobPayload};
use sqlx::SqlitePool;
use tauri_plugin_lectorbit::{
    BoxFuture, LibraryErrorCode, LibraryErrorKind, LibraryOps, LibraryRootDto, ScanEventSink,
    ScanJobDto, ScanProgressDto,
};

#[derive(Clone)]
pub struct LibraryAdapter {
    service: LibraryService,
    pool: SqlitePool,
}

impl LibraryAdapter {
    pub fn new(service: LibraryService, pool: SqlitePool) -> Self {
        Self { service, pool }
    }

    pub async fn recover_and_resume(&self) -> Result<(), String> {
        let recovered = lectorbit_services::recover_interrupted(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        if recovered > 0 {
            tracing::info!(recovered, "requeued interrupted jobs");
        }
        for job in lectorbit_services::list_by_kind(&self.pool, "scan", 500)
            .await
            .map_err(|error| error.to_string())?
        {
            if job.status == JobStatus::Queued {
                let sink: ScanEventSink = Arc::new(|_| {});
                self.spawn_scan(job, sink);
            }
        }
        Ok(())
    }

    fn spawn_scan(&self, job: Job, sink: ScanEventSink) {
        let adapter = self.clone();
        tauri::async_runtime::spawn(async move {
            let job_id = job.id.clone();
            if let Err(detail) = adapter.run_scan(job, sink.clone()).await {
                tracing::error!(job_id, error = %detail, "library scan failed");
                let message = "The scan could not be completed.".to_string();
                let _ = lectorbit_services::mark_failed(&adapter.pool, &job_id, &message).await;
                sink(ScanProgressDto::Failed { job_id, message });
            }
        });
    }

    async fn run_scan(&self, job: Job, sink: ScanEventSink) -> Result<(), String> {
        let payload: ScanJobPayload = serde_json::from_str(&job.payload)
            .map_err(|_| "scan payload is invalid".to_string())?;
        lectorbit_services::mark_running(&self.pool, &job.id)
            .await
            .map_err(|error| error.to_string())?;
        let root = self
            .service
            .resolve_active_root(&payload.root_id)
            .await
            .map_err(|_| "authorized library root is unavailable".to_string())?;

        sink(ScanProgressDto::Started {
            job_id: job.id.clone(),
            root_id: root.id.clone(),
        });

        let job_id = job.id.clone();
        let progress_sink = sink.clone();
        let crawl = tokio::task::spawn_blocking(move || {
            lectorbit_media::crawl_library(&root.canonical_path, |progress| {
                progress_sink(ScanProgressDto::Discovering {
                    job_id: job_id.clone(),
                    visited_entries: progress.visited_entries,
                    media_candidates: progress.media_candidates,
                });
            })
        })
        .await
        .map_err(|error| format!("scan worker stopped: {error}"))?
        .map_err(|error| error.to_string())?;

        let total = crawl.candidates.len() as u64;
        let mut transaction = self.pool.begin().await.map_err(safe_database_error)?;
        for (index, candidate) in crawl.candidates.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            let modified =
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(candidate.modified_unix_ms)
                    .unwrap_or_else(chrono::Utc::now)
                    .to_rfc3339();
            sqlx::query(
                "INSERT INTO media_files \
                 (id, root_id, folder_id, path, size_bytes, mtime, discovered_at) \
                 VALUES (?, ?, NULL, ?, ?, ?, ?) \
                 ON CONFLICT(root_id, path) DO UPDATE SET \
                   size_bytes = excluded.size_bytes, mtime = excluded.mtime, \
                   discovered_at = excluded.discovered_at",
            )
            .bind(id)
            .bind(&payload.root_id)
            .bind(candidate.absolute_path.to_string_lossy().into_owned())
            .bind(i64::try_from(candidate.size_bytes).unwrap_or(i64::MAX))
            .bind(modified)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&mut *transaction)
            .await
            .map_err(safe_database_error)?;

            let current = (index + 1) as u64;
            if current == total || current % 25 == 0 {
                sink(ScanProgressDto::Indexing {
                    job_id: job.id.clone(),
                    current,
                    total,
                });
            }
        }
        transaction.commit().await.map_err(safe_database_error)?;
        lectorbit_services::mark_completed(&self.pool, &job.id)
            .await
            .map_err(|error| error.to_string())?;
        sink(ScanProgressDto::Completed {
            job_id: job.id,
            indexed: total,
            issues: crawl.issues.len() as u64,
        });
        Ok(())
    }
}

impl LibraryOps for LibraryAdapter {
    fn list_roots(&self) -> BoxFuture<'_, Result<Vec<LibraryRootDto>, LibraryErrorCode>> {
        Box::pin(async move {
            self.service
                .list_roots()
                .await
                .map(|roots| roots.into_iter().map(to_root_dto).collect())
                .map_err(map_library_error)
        })
    }

    fn register_selected_root(
        &self,
        selected_path: String,
    ) -> BoxFuture<'_, Result<LibraryRootDto, LibraryErrorCode>> {
        Box::pin(async move {
            self.service
                .register_root(&selected_path, None)
                .await
                .map(to_root_dto)
                .map_err(map_library_error)
        })
    }

    fn revoke_root(&self, id: String) -> BoxFuture<'_, Result<LibraryRootDto, LibraryErrorCode>> {
        Box::pin(async move {
            self.service
                .revoke_root(&id)
                .await
                .map(to_root_dto)
                .map_err(map_library_error)
        })
    }

    fn enqueue_scan(
        &self,
        root_id: String,
        sink: ScanEventSink,
    ) -> BoxFuture<'_, Result<ScanJobDto, LibraryErrorCode>> {
        Box::pin(async move {
            let enqueued = self
                .service
                .enqueue_scan(&root_id)
                .await
                .map_err(map_library_error)?;
            if enqueued.is_new {
                self.spawn_scan(enqueued.job.clone(), sink);
            }
            to_scan_job_dto(enqueued.job)
                .map_err(|message| LibraryErrorCode::new(LibraryErrorKind::Internal, message))
        })
    }

    fn list_scan_jobs(
        &self,
        root_id: Option<String>,
    ) -> BoxFuture<'_, Result<Vec<ScanJobDto>, LibraryErrorCode>> {
        Box::pin(async move {
            let jobs = lectorbit_services::list_by_kind(&self.pool, "scan", 100)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "list scan jobs failed");
                    LibraryErrorCode::new(LibraryErrorKind::Database, "Could not load scan jobs.")
                })?;
            jobs.into_iter()
                .filter_map(|job| {
                    let payload = serde_json::from_str::<ScanJobPayload>(&job.payload).ok()?;
                    if root_id.as_ref().is_some_and(|id| id != &payload.root_id) {
                        return None;
                    }
                    Some(to_scan_job_dto_with_root(job, payload.root_id))
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|message| LibraryErrorCode::new(LibraryErrorKind::Internal, message))
        })
    }
}

fn to_root_dto(root: lectorbit_services::LibraryRootView) -> LibraryRootDto {
    LibraryRootDto {
        id: root.id,
        display_name: root.display_name,
        path_redacted: root.path_redacted,
        registered_at: root.registered_at,
        revoked_at: root.revoked_at,
        is_active: root.is_active,
    }
}

fn to_scan_job_dto(job: Job) -> Result<ScanJobDto, String> {
    let payload: ScanJobPayload =
        serde_json::from_str(&job.payload).map_err(|_| "scan payload is invalid".to_string())?;
    to_scan_job_dto_with_root(job, payload.root_id)
}

fn to_scan_job_dto_with_root(job: Job, root_id: String) -> Result<ScanJobDto, String> {
    Ok(ScanJobDto {
        id: job.id,
        root_id,
        status: job.status.as_str().to_string(),
        attempt: job.attempt,
        last_error: job.last_error,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    })
}

fn map_library_error(error: lectorbit_services::LibraryError) -> LibraryErrorCode {
    use lectorbit_services::LibraryError;
    tracing::warn!(%error, "library operation failed");
    match error {
        LibraryError::EmptyPath => {
            LibraryErrorCode::new(LibraryErrorKind::EmptyPath, "No folder was selected.")
        }
        LibraryError::NotADirectory => LibraryErrorCode::new(
            LibraryErrorKind::NotADirectory,
            "The selected location is not an available folder.",
        ),
        LibraryError::NotFound => LibraryErrorCode::new(
            LibraryErrorKind::NotFound,
            "That library root is unavailable.",
        ),
        LibraryError::Io(_) => LibraryErrorCode::new(
            LibraryErrorKind::Io,
            "Could not access the selected folder.",
        ),
        LibraryError::Database(_) => LibraryErrorCode::new(
            LibraryErrorKind::Database,
            "The library database operation failed.",
        ),
    }
}

fn safe_database_error(error: sqlx::Error) -> String {
    tracing::error!(%error, "scan database operation failed");
    "Could not update the media index.".to_string()
}
