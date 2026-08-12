use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use lectorbit_db::{ProbeCandidate, StoredProbe, StoredStream};
use lectorbit_media::{Ffprobe, ProbeError, ProbeMetadata, EXPECTED_FFPROBE_VERSION};
use lectorbit_services::{Job, JobStatus, MediaService, ProbeJobPayload};
use tauri_plugin_lectorbit::{ScanEventSink, ScanProgressDto};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct ProbeScheduler {
    service: MediaService,
    adapter: Option<Arc<Ffprobe>>,
    permits: Arc<Semaphore>,
}

impl ProbeScheduler {
    pub async fn new(service: MediaService, executable: Option<PathBuf>) -> Self {
        let adapter = match executable.and_then(|path| Ffprobe::new(path).ok()) {
            Some(adapter) => match adapter.verify_version().await {
                Ok(()) => {
                    tracing::info!(
                        version = EXPECTED_FFPROBE_VERSION,
                        "verified ffprobe sidecar"
                    );
                    Some(Arc::new(adapter))
                }
                Err(error) => {
                    tracing::warn!(%error, "ffprobe sidecar verification failed");
                    None
                }
            },
            None => {
                tracing::warn!("ffprobe sidecar is not configured");
                None
            }
        };
        Self {
            service,
            adapter,
            permits: Arc::new(Semaphore::new(2)),
        }
    }

    pub async fn recover_and_resume(&self) -> Result<(), String> {
        let mut jobs = self
            .service
            .list_probe_jobs(50_000)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|job| job.status == JobStatus::Queued)
            .collect::<Vec<_>>();
        if self.adapter.is_some() {
            let candidates = self
                .service
                .list_unavailable_probe_candidates(50_000)
                .await
                .map_err(|error| error.to_string())?;
            let mut recovered = 0_u64;
            for candidate in candidates {
                let enqueued = self
                    .service
                    .enqueue_probe(&candidate)
                    .await
                    .map_err(|error| error.to_string())?;
                if enqueued.is_new {
                    jobs.push(enqueued.job);
                    recovered = recovered.saturating_add(1);
                }
            }
            if recovered > 0 {
                tracing::info!(
                    recovered,
                    "requeued metadata after ffprobe became available"
                );
            }
        }
        let total = jobs.len() as u64;
        let completed = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(AtomicU64::new(0));
        for job in jobs {
            self.spawn_probe(
                job,
                Arc::new(|_| {}),
                total,
                completed.clone(),
                failed.clone(),
            );
        }
        Ok(())
    }

    pub async fn enqueue_candidates(
        &self,
        candidates: Vec<ProbeCandidate>,
        sink: ScanEventSink,
    ) -> Result<(), String> {
        let mut jobs = Vec::new();
        for candidate in candidates {
            let enqueued = self
                .service
                .enqueue_probe(&candidate)
                .await
                .map_err(|error| error.to_string())?;
            if enqueued.is_new {
                jobs.push(enqueued.job);
            }
        }
        let total = jobs.len() as u64;
        let completed = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(AtomicU64::new(0));
        for job in jobs {
            self.spawn_probe(job, sink.clone(), total, completed.clone(), failed.clone());
        }
        Ok(())
    }

    fn spawn_probe(
        &self,
        job: Job,
        sink: ScanEventSink,
        total: u64,
        completed: Arc<AtomicU64>,
        failed: Arc<AtomicU64>,
    ) {
        let scheduler = self.clone();
        tauri::async_runtime::spawn(async move {
            let job_id = job.id.clone();
            let outcome = scheduler.run_probe(job).await;
            if let Err(detail) = &outcome {
                tracing::error!(job_id, error = %detail, "probe job failed");
                let message = "Media inspection could not be completed.";
                let _ = scheduler
                    .service
                    .mark_probe_job_failed(&job_id, message)
                    .await;
            }
            if !outcome.unwrap_or(false) {
                failed.fetch_add(1, Ordering::Relaxed);
            }
            let current = completed.fetch_add(1, Ordering::Relaxed) + 1;
            sink(ScanProgressDto::Metadata {
                job_id,
                completed: current,
                total,
                failed: failed.load(Ordering::Relaxed),
            });
        });
    }

    async fn run_probe(&self, job: Job) -> Result<bool, String> {
        let _permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "probe worker stopped".to_string())?;
        self.service
            .mark_probe_job_running(&job.id)
            .await
            .map_err(|error| error.to_string())?;
        let payload: ProbeJobPayload = serde_json::from_str(&job.payload)
            .map_err(|_| "probe payload is invalid".to_string())?;
        self.service
            .mark_probing(&payload.media_id)
            .await
            .map_err(|error| error.to_string())?;

        let media = match self
            .service
            .resolve_authorized_media(&payload.media_id)
            .await
        {
            Ok(media) => media,
            Err(error) => {
                tracing::warn!(media_id = payload.media_id, %error, "media authorization failed");
                self.service
                    .save_probe_failure(
                        &payload.media_id,
                        "failed",
                        "This file is no longer available.",
                        EXPECTED_FFPROBE_VERSION,
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                self.service
                    .mark_probe_job_completed(&job.id)
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(false);
            }
        };

        let result = match &self.adapter {
            Some(adapter) => adapter.probe(&media.canonical_path).await,
            None => Err(lectorbit_media::ProbeError::Unavailable),
        };
        match result {
            Ok(metadata) => {
                self.service
                    .save_probe_success(
                        &payload.media_id,
                        EXPECTED_FFPROBE_VERSION,
                        &to_stored_probe(metadata),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                self.service
                    .mark_probe_job_completed(&job.id)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(true)
            }
            Err(error) => {
                if !matches!(error, ProbeError::Unavailable) {
                    tracing::warn!(media_id = payload.media_id, %error, "ffprobe rejected media");
                }
                self.service
                    .save_probe_failure(
                        &payload.media_id,
                        error.status(),
                        error.safe_message(),
                        EXPECTED_FFPROBE_VERSION,
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                self.service
                    .mark_probe_job_completed(&job.id)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(false)
            }
        }
    }
}

fn to_stored_probe(metadata: ProbeMetadata) -> StoredProbe {
    StoredProbe {
        duration_ms: metadata.duration_ms,
        container: metadata.container,
        video_codec: metadata.video_codec,
        audio_codec: metadata.audio_codec,
        width: metadata.width,
        height: metadata.height,
        audio_streams: metadata.audio_streams,
        subtitle_streams: metadata.subtitle_streams,
        streams: metadata
            .streams
            .into_iter()
            .map(|stream| StoredStream {
                index: stream.index,
                kind: stream.kind,
                codec: stream.codec,
                language: stream.language,
                width: stream.width,
                height: stream.height,
                bitrate: stream.bitrate,
                duration_ms: stream.duration_ms,
                channels: stream.channels,
                sample_rate: stream.sample_rate,
                is_default: stream.is_default,
            })
            .collect(),
    }
}
