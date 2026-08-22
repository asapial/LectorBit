use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use lectorbit_ai::{
    install_model, supported_languages_for_model, AiError, TranscriptionLanguage, WhisperCpp,
    EXPECTED_WHISPER_VERSION,
};
use lectorbit_services::{
    AnalysisError, AnalysisService, Job, JobStatus, ModelDownloadPayload, SearchError,
    SearchService, TranscriptionPayload,
};
use tauri_plugin_lectorbit::{
    AnalysisCapabilityDto, AnalysisErrorCode, AnalysisErrorKind, AnalysisEventSink, AnalysisJobDto,
    AnalysisOps, AnalysisProgressDto, BoxFuture, ModelDto, SearchErrorCode, SearchErrorKind,
    SearchHitDto, SearchOps, TranscriptStateDto,
};
use tokio::sync::{Mutex, RwLock, Semaphore};

type EnginePathResolver = dyn Fn() -> (Option<PathBuf>, Option<PathBuf>) + Send + Sync + 'static;

#[derive(Clone)]
struct AnalysisEngine {
    state: Arc<RwLock<AnalysisEngineState>>,
    probe_lock: Arc<Mutex<()>>,
    resolve_paths: Arc<EnginePathResolver>,
}

struct AnalysisEngineState {
    whisper: Option<Arc<WhisperCpp>>,
    capability: AnalysisCapabilityDto,
    probe_generation: u64,
}

impl AnalysisEngine {
    async fn new<F>(resolve_paths: F) -> Self
    where
        F: Fn() -> (Option<PathBuf>, Option<PathBuf>) + Send + Sync + 'static,
    {
        let resolve_paths: Arc<EnginePathResolver> = Arc::new(resolve_paths);
        let (whisper_path, ffmpeg_path) = resolve_paths();
        let (whisper, capability) = initialize_whisper(whisper_path, ffmpeg_path).await;
        Self {
            state: Arc::new(RwLock::new(AnalysisEngineState {
                whisper,
                capability,
                probe_generation: 1,
            })),
            probe_lock: Arc::new(Mutex::new(())),
            resolve_paths,
        }
    }

    async fn refresh_if_unavailable(&self) {
        let observed_generation = {
            let state = self.state.read().await;
            if state.whisper.is_some() {
                return;
            }
            state.probe_generation
        };

        // Capability and transcription requests can arrive together. Only one of
        // them should launch the external version probes; the others reuse its
        // result after acquiring this lock.
        let _probe_guard = self.probe_lock.lock().await;
        {
            let state = self.state.read().await;
            if state.whisper.is_some() || state.probe_generation != observed_generation {
                return;
            }
        }

        let (whisper_path, ffmpeg_path) = (self.resolve_paths)();
        let (whisper, capability) = initialize_whisper(whisper_path, ffmpeg_path).await;
        *self.state.write().await = AnalysisEngineState {
            whisper,
            capability,
            probe_generation: observed_generation.saturating_add(1),
        };
    }

    async fn capability(&self) -> AnalysisCapabilityDto {
        self.refresh_if_unavailable().await;
        self.state.read().await.capability.clone()
    }

    async fn whisper(&self) -> Result<Arc<WhisperCpp>, AnalysisErrorCode> {
        self.refresh_if_unavailable().await;
        let state = self.state.read().await;
        state.whisper.clone().ok_or_else(|| {
            AnalysisErrorCode::new(
                AnalysisErrorKind::SidecarUnavailable,
                state.capability.message.clone(),
            )
        })
    }
}

#[derive(Clone)]
pub struct AnalysisAdapter {
    service: AnalysisService,
    search: SearchService,
    engine: AnalysisEngine,
    client: reqwest::Client,
    work_root: PathBuf,
    model_permits: Arc<Semaphore>,
    transcription_permits: Arc<Semaphore>,
}

impl AnalysisAdapter {
    pub async fn new<F>(
        service: AnalysisService,
        search: SearchService,
        resolve_engine_paths: F,
        work_root: PathBuf,
    ) -> Self
    where
        F: Fn() -> (Option<PathBuf>, Option<PathBuf>) + Send + Sync + 'static,
    {
        let engine = AnalysisEngine::new(resolve_engine_paths).await;
        Self {
            service,
            search,
            engine,
            client: reqwest::Client::builder()
                .https_only(true)
                .user_agent("LectorBit/0.1 model-manager")
                .build()
                .expect("static HTTP client configuration"),
            work_root,
            model_permits: Arc::new(Semaphore::new(1)),
            transcription_permits: Arc::new(Semaphore::new(1)),
        }
    }

    pub async fn recover_and_resume(&self) -> Result<(), String> {
        for job in self
            .service
            .list_jobs("model_download", 50_000)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|job| job.status == JobStatus::Queued)
        {
            self.spawn_model_download(job, Arc::new(|_| {}));
        }
        for job in self
            .service
            .list_jobs("transcribe", 50_000)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|job| job.status == JobStatus::Queued)
        {
            self.spawn_transcription(job, Arc::new(|_| {}));
        }
        Ok(())
    }

    fn spawn_model_download(&self, job: Job, sink: AnalysisEventSink) {
        let adapter = self.clone();
        tauri::async_runtime::spawn(async move {
            let job_id = job.id.clone();
            if let Err(error) = adapter.run_model_download(job, sink.clone()).await {
                tracing::error!(job_id, message = %error.message, "model download failed");
                let message = safe_analysis_message(&error);
                let _ = adapter.service.mark_job_failed(&job_id, message).await;
                sink(AnalysisProgressDto::Failed {
                    job_id,
                    message: message.into(),
                });
            }
        });
    }

    async fn run_model_download(
        &self,
        job: Job,
        sink: AnalysisEventSink,
    ) -> Result<(), AnalysisErrorCode> {
        let _permit = self
            .model_permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| internal_analysis_error())?;
        self.service
            .mark_job_running(&job.id)
            .await
            .map_err(map_analysis_error)?;
        let payload: ModelDownloadPayload =
            serde_json::from_str(&job.payload).map_err(|_| invalid_analysis_error())?;
        let manifest = self
            .service
            .model_manifest(&payload.model_id)
            .await
            .map_err(map_analysis_error)?;
        let downloaded = Arc::new(AtomicU64::new(0));
        self.service
            .mark_model_downloading(&payload.model_id, 0)
            .await
            .map_err(map_analysis_error)?;
        let progress_bytes = downloaded.clone();
        let progress_service = self.service.clone();
        let progress_model = payload.model_id.clone();
        let last_persisted = Arc::new(AtomicU64::new(0));
        let progress_persisted = last_persisted.clone();
        let progress_job = job.id.clone();
        let progress_sink = sink.clone();
        let result = install_model(
            &self.client,
            &manifest,
            self.service.models_dir(),
            move |progress| {
                progress_bytes.store(progress.downloaded_bytes, Ordering::Relaxed);
                let previous = progress_persisted.load(Ordering::Relaxed);
                if progress.downloaded_bytes.saturating_sub(previous) >= 4 * 1024 * 1024
                    || progress.downloaded_bytes == progress.total_bytes
                {
                    progress_persisted.store(progress.downloaded_bytes, Ordering::Relaxed);
                    let service = progress_service.clone();
                    let model_id = progress_model.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = service
                            .update_model_download_progress(&model_id, progress.downloaded_bytes)
                            .await;
                    });
                }
                progress_sink(AnalysisProgressDto::Downloading {
                    job_id: progress_job.clone(),
                    downloaded_bytes: progress.downloaded_bytes,
                    total_bytes: progress.total_bytes,
                });
            },
        )
        .await;
        match result {
            Ok(path) => {
                self.service
                    .mark_model_ready(&payload.model_id, manifest.expected_size_bytes, &path)
                    .await
                    .map_err(map_analysis_error)?;
                self.service
                    .mark_job_completed(&job.id)
                    .await
                    .map_err(map_analysis_error)?;
                sink(AnalysisProgressDto::Completed { job_id: job.id });
                Ok(())
            }
            Err(error) => {
                let message = safe_ai_message(&error);
                self.service
                    .mark_model_failed(
                        &payload.model_id,
                        downloaded.load(Ordering::Relaxed),
                        message,
                    )
                    .await
                    .map_err(map_analysis_error)?;
                Err(AnalysisErrorCode::new(AnalysisErrorKind::Internal, message))
            }
        }
    }

    fn spawn_transcription(&self, job: Job, sink: AnalysisEventSink) {
        let adapter = self.clone();
        tauri::async_runtime::spawn(async move {
            let job_id = job.id.clone();
            if let Err(error) = adapter.run_transcription(job, sink.clone()).await {
                tracing::error!(job_id, message = %error.message, "transcription failed");
                let message = safe_analysis_message(&error);
                let _ = adapter.service.mark_job_failed(&job_id, message).await;
                sink(AnalysisProgressDto::Failed {
                    job_id,
                    message: message.into(),
                });
            }
        });
    }

    async fn run_transcription(
        &self,
        job: Job,
        sink: AnalysisEventSink,
    ) -> Result<(), AnalysisErrorCode> {
        let _permit = self
            .transcription_permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| internal_analysis_error())?;
        self.service
            .mark_job_running(&job.id)
            .await
            .map_err(map_analysis_error)?;
        let whisper = self.engine.whisper().await?;
        let payload: TranscriptionPayload =
            serde_json::from_str(&job.payload).map_err(|_| invalid_analysis_error())?;
        let media = self
            .service
            .resolve_media(&payload.media_id)
            .await
            .map_err(map_analysis_error)?;
        let model = self
            .service
            .ready_model_path(&payload.model_id)
            .await
            .map_err(map_analysis_error)?;
        let work_dir = safe_work_dir(&self.work_root, &job.id)?;
        sink(AnalysisProgressDto::Extracting {
            job_id: job.id.clone(),
        });
        sink(AnalysisProgressDto::Transcribing {
            job_id: job.id.clone(),
        });
        let output = whisper
            .transcribe(&media, &model, &work_dir, payload.language)
            .await
            .map_err(|error| {
                AnalysisErrorCode::new(AnalysisErrorKind::Internal, safe_ai_message(&error))
            });
        let _ = remove_owned_work_dir(&self.work_root, &work_dir).await;
        let output = output?;
        let segment_count = output.segments.len() as u64;
        sink(AnalysisProgressDto::Indexing {
            job_id: job.id.clone(),
            segments: segment_count,
        });
        self.service
            .save_transcript(&payload.media_id, &payload.model_id, output)
            .await
            .map_err(map_analysis_error)?;
        self.service
            .mark_job_completed(&job.id)
            .await
            .map_err(map_analysis_error)?;
        sink(AnalysisProgressDto::Completed { job_id: job.id });
        Ok(())
    }
}

async fn initialize_whisper(
    whisper_path: Option<PathBuf>,
    ffmpeg_path: Option<PathBuf>,
) -> (Option<Arc<WhisperCpp>>, AnalysisCapabilityDto) {
    let Some(whisper_path) = whisper_path else {
        tracing::warn!("whisper.cpp sidecar is not configured");
        return (
            None,
            unavailable_capability(
                "whisper_missing",
                "Install the local whisper.cpp 1.9.2 engine, then try again.",
            ),
        );
    };
    let Some(ffmpeg_path) = ffmpeg_path else {
        tracing::warn!("ffmpeg sidecar is not configured for transcription");
        return (
            None,
            unavailable_capability("ffmpeg_missing", "Install FFmpeg 8.1.2, then try again."),
        );
    };
    let adapter = match WhisperCpp::new(whisper_path, ffmpeg_path) {
        Ok(adapter) => adapter,
        Err(error) => {
            tracing::warn!(%error, "whisper.cpp sidecar could not be opened");
            return (
                None,
                unavailable_capability(
                    "whisper_unavailable",
                    "The local transcription engine could not be opened. Repair it, then try again.",
                ),
            );
        }
    };
    if let Err(error) = adapter.verify_version().await {
        tracing::warn!(%error, "whisper.cpp sidecar verification failed");
        let (reason, message) = match error {
                AiError::UnsupportedVersion => (
                    "version_mismatch",
                    "The local transcription engine version is incompatible. Install whisper.cpp 1.9.2, then try again.",
                ),
                _ => (
                    "whisper_unavailable",
                    "The local transcription engine could not be verified. Repair it, then try again.",
                ),
            };
        return (None, unavailable_capability(reason, message));
    }
    if let Err(error) = adapter.verify_ffmpeg_version().await {
        tracing::warn!(%error, "FFmpeg sidecar verification failed for transcription");
        let (reason, message) = match error {
            AiError::UnsupportedFfmpegVersion => (
                "ffmpeg_version_mismatch",
                "The audio extractor version is incompatible. Install FFmpeg 8.1.2, then try again.",
            ),
            _ => (
                "ffmpeg_unavailable",
                "The audio extractor could not be verified. Repair FFmpeg, then try again.",
            ),
        };
        return (None, unavailable_capability(reason, message));
    }
    (
        Some(Arc::new(adapter)),
        AnalysisCapabilityDto {
            available: true,
            engine: "whisper.cpp".into(),
            expected_version: EXPECTED_WHISPER_VERSION.into(),
            unavailable_reason: None,
            message: "Local English and Bangla transcription is ready.".into(),
            supported_languages: vec!["en".into(), "bn".into()],
        },
    )
}

fn unavailable_capability(reason: &str, message: &str) -> AnalysisCapabilityDto {
    AnalysisCapabilityDto {
        available: false,
        engine: "whisper.cpp".into(),
        expected_version: EXPECTED_WHISPER_VERSION.into(),
        unavailable_reason: Some(reason.into()),
        message: message.into(),
        supported_languages: vec!["en".into(), "bn".into()],
    }
}

fn model_display_name(model_id: &str) -> &'static str {
    match model_id {
        "whisper-base" => "Whisper base multilingual (বাংলা + English)",
        "whisper-base.en" => "Whisper base English",
        _ => "Whisper local model",
    }
}

impl AnalysisOps for AnalysisAdapter {
    fn capability(&self) -> BoxFuture<'_, Result<AnalysisCapabilityDto, AnalysisErrorCode>> {
        Box::pin(async move { Ok(self.engine.capability().await) })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelDto>, AnalysisErrorCode>> {
        Box::pin(async move {
            self.service
                .list_models()
                .await
                .map(|models| {
                    models
                        .into_iter()
                        .map(|model| ModelDto {
                            display_name: model_display_name(&model.id).into(),
                            supported_languages: supported_languages_for_model(&model.id)
                                .iter()
                                .map(|language| (*language).into())
                                .collect(),
                            id: model.id,
                            version: model.version,
                            provider: model.provider,
                            expected_size_bytes: model.expected_size_bytes,
                            architecture: model.architecture,
                            analyzer_compatibility: model.analyzer_compatibility,
                            license: model.license,
                            state: model.state,
                            bytes_downloaded: model.bytes_downloaded,
                            verified_at: model.verified_at,
                            last_error: model.last_error,
                        })
                        .collect()
                })
                .map_err(map_analysis_error)
        })
    }

    fn install_model(
        &self,
        model_id: String,
        sink: AnalysisEventSink,
    ) -> BoxFuture<'_, Result<AnalysisJobDto, AnalysisErrorCode>> {
        Box::pin(async move {
            let enqueued = self
                .service
                .enqueue_model_download(&model_id)
                .await
                .map_err(map_analysis_error)?;
            let dto = job_dto(&enqueued.job);
            sink(AnalysisProgressDto::Queued {
                job_id: enqueued.job.id.clone(),
            });
            if enqueued.is_new {
                self.spawn_model_download(enqueued.job, sink);
            }
            Ok(dto)
        })
    }

    fn remove_model(&self, model_id: String) -> BoxFuture<'_, Result<(), AnalysisErrorCode>> {
        Box::pin(async move {
            self.service
                .remove_model(&model_id)
                .await
                .map_err(map_analysis_error)
        })
    }

    fn start_transcription(
        &self,
        media_id: String,
        model_id: String,
        language: String,
        sink: AnalysisEventSink,
    ) -> BoxFuture<'_, Result<AnalysisJobDto, AnalysisErrorCode>> {
        Box::pin(async move {
            self.engine.whisper().await?;
            let language = TranscriptionLanguage::try_from(language.as_str()).map_err(|_| {
                AnalysisErrorCode::new(
                    AnalysisErrorKind::LanguageNotSupported,
                    "Choose English or Bangla for local transcription.",
                )
            })?;
            let enqueued = self
                .service
                .enqueue_transcription(&media_id, &model_id, language)
                .await
                .map_err(map_analysis_error)?;
            let dto = job_dto(&enqueued.job);
            sink(AnalysisProgressDto::Queued {
                job_id: enqueued.job.id.clone(),
            });
            if enqueued.is_new {
                self.spawn_transcription(enqueued.job, sink);
            }
            Ok(dto)
        })
    }

    fn transcript_state(
        &self,
        media_id: String,
    ) -> BoxFuture<'_, Result<TranscriptStateDto, AnalysisErrorCode>> {
        Box::pin(async move {
            self.service
                .transcript_state(&media_id)
                .await
                .map(|state| TranscriptStateDto {
                    media_id: state.media_id,
                    status: state.status,
                    segment_count: state.segment_count,
                    updated_at: state.updated_at,
                    language: state.language,
                    model_id: state.model_id,
                    job: state.job.as_ref().map(job_dto),
                })
                .map_err(map_analysis_error)
        })
    }

    fn list_jobs(
        &self,
        kind: String,
    ) -> BoxFuture<'_, Result<Vec<AnalysisJobDto>, AnalysisErrorCode>> {
        Box::pin(async move {
            self.service
                .list_jobs(&kind, 500)
                .await
                .map(|jobs| jobs.iter().map(job_dto).collect())
                .map_err(map_analysis_error)
        })
    }
}

impl SearchOps for AnalysisAdapter {
    fn search(
        &self,
        text: String,
        limit: u32,
    ) -> BoxFuture<'_, Result<Vec<SearchHitDto>, SearchErrorCode>> {
        Box::pin(async move {
            self.search
                .search(&text, limit)
                .await
                .map(|hits| {
                    hits.into_iter()
                        .map(|hit| SearchHitDto {
                            media_id: hit.media_id,
                            display_name: hit.display_name,
                            plan_item_id: hit.plan_item_id,
                            source: match hit.source {
                                lectorbit_services::SearchSource::Media => "media",
                                lectorbit_services::SearchSource::Transcript => "transcript",
                                lectorbit_services::SearchSource::Annotation => "annotation",
                            }
                            .into(),
                            start_ms: hit.start_ms,
                            end_ms: hit.end_ms,
                            snippet: hit.snippet,
                            score: hit.score,
                        })
                        .collect()
                })
                .map_err(map_search_error)
        })
    }
}

fn job_dto(job: &Job) -> AnalysisJobDto {
    AnalysisJobDto {
        id: job.id.clone(),
        kind: job.kind.clone(),
        status: job.status.as_str().into(),
        attempt: job.attempt,
        last_error: job.last_error.clone(),
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}

fn map_analysis_error(error: AnalysisError) -> AnalysisErrorCode {
    let (kind, message) = match error {
        AnalysisError::ModelNotFound => (
            AnalysisErrorKind::ModelNotFound,
            "That model is unavailable.",
        ),
        AnalysisError::ModelNotReady => (
            AnalysisErrorKind::ModelNotReady,
            "Install and verify a model first.",
        ),
        AnalysisError::ModelLanguageUnsupported => (
            AnalysisErrorKind::LanguageNotSupported,
            "Install the multilingual Whisper model to transcribe Bangla.",
        ),
        AnalysisError::TranscriptionBusy => (
            AnalysisErrorKind::TranscriptionBusy,
            "Another transcription is already running for this lecture. Wait for it to finish before changing the language or model.",
        ),
        AnalysisError::MediaUnavailable => (
            AnalysisErrorKind::MediaUnavailable,
            "That media file is no longer available.",
        ),
        AnalysisError::InvalidInput => (
            AnalysisErrorKind::InvalidInput,
            "The analysis request is invalid.",
        ),
        AnalysisError::Database(_) => (
            AnalysisErrorKind::Database,
            "The local database could not save this change.",
        ),
        AnalysisError::Filesystem => (
            AnalysisErrorKind::Internal,
            "The local model file could not be accessed safely.",
        ),
    };
    AnalysisErrorCode::new(kind, message)
}

fn map_search_error(error: SearchError) -> SearchErrorCode {
    match error {
        SearchError::EmptyQuery => SearchErrorCode::new(
            SearchErrorKind::InvalidInput,
            "Enter at least one searchable word.",
        ),
        SearchError::Database(_) => SearchErrorCode::new(
            SearchErrorKind::Database,
            "The local search index is unavailable.",
        ),
    }
}

fn safe_ai_message(error: &lectorbit_ai::AiError) -> &'static str {
    match error {
        lectorbit_ai::AiError::InsufficientDiskSpace => {
            "Not enough disk space to install this model."
        }
        lectorbit_ai::AiError::VerificationFailed => {
            "The downloaded model did not pass verification."
        }
        lectorbit_ai::AiError::SidecarUnavailable
        | lectorbit_ai::AiError::UnsupportedVersion
        | lectorbit_ai::AiError::FfmpegUnavailable
        | lectorbit_ai::AiError::UnsupportedFfmpegVersion => {
            "Local transcription is unavailable on this installation."
        }
        lectorbit_ai::AiError::UnsupportedLanguage => {
            "Choose English or Bangla for local transcription."
        }
        lectorbit_ai::AiError::ExtractionFailed => "Audio could not be extracted from this media.",
        lectorbit_ai::AiError::TranscriptionFailed | lectorbit_ai::AiError::InvalidOutput => {
            "This media could not be transcribed locally."
        }
        lectorbit_ai::AiError::InvalidManifest | lectorbit_ai::AiError::DownloadFailed => {
            "The model download could not be completed."
        }
    }
}

fn safe_analysis_message(error: &AnalysisErrorCode) -> &str {
    &error.message
}

fn invalid_analysis_error() -> AnalysisErrorCode {
    AnalysisErrorCode::new(
        AnalysisErrorKind::InvalidInput,
        "The saved analysis job is invalid.",
    )
}

fn internal_analysis_error() -> AnalysisErrorCode {
    AnalysisErrorCode::new(AnalysisErrorKind::Internal, "The analysis worker stopped.")
}

fn safe_work_dir(root: &std::path::Path, job_id: &str) -> Result<PathBuf, AnalysisErrorCode> {
    if job_id.is_empty()
        || job_id.len() > 64
        || !job_id
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
    {
        return Err(invalid_analysis_error());
    }
    Ok(root.join(job_id))
}

async fn remove_owned_work_dir(root: &std::path::Path, target: &std::path::Path) -> Result<(), ()> {
    let root = tokio::fs::canonicalize(root).await.map_err(|_| ())?;
    let target = tokio::fs::canonicalize(target).await.map_err(|_| ())?;
    if target == root || !target.starts_with(&root) {
        return Err(());
    }
    tokio::fs::remove_dir_all(target).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_directory_rejects_path_input() {
        assert!(safe_work_dir(std::path::Path::new("C:/cache"), "../escape").is_err());
        assert!(safe_work_dir(std::path::Path::new("C:/cache"), "job/escape").is_err());
    }

    #[tokio::test]
    async fn unavailable_engine_re_resolves_sidecar_paths() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let whisper_path = directory.path().join("whisper-fixture");
        let ffmpeg_path = directory.path().join("ffmpeg-fixture");
        let resolver_whisper = whisper_path.clone();
        let resolver_ffmpeg = ffmpeg_path.clone();
        let calls = Arc::new(AtomicU64::new(0));
        let resolver_calls = calls.clone();

        let engine = AnalysisEngine::new(move || {
            resolver_calls.fetch_add(1, Ordering::Relaxed);
            (
                resolver_whisper.is_file().then(|| resolver_whisper.clone()),
                resolver_ffmpeg.is_file().then(|| resolver_ffmpeg.clone()),
            )
        })
        .await;

        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            engine
                .state
                .read()
                .await
                .capability
                .unavailable_reason
                .as_deref(),
            Some("whisper_missing")
        );

        std::fs::write(&whisper_path, b"fixture").expect("create whisper fixture");
        std::fs::write(&ffmpeg_path, b"fixture").expect("create ffmpeg fixture");

        let capability = engine.capability().await;
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        assert_eq!(
            capability.unavailable_reason.as_deref(),
            Some("whisper_unavailable")
        );
    }
}
