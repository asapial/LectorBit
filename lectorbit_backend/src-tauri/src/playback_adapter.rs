//! Safe plugin mapping for playback, progress, and study actions.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use lectorbit_db::StudyActionKind;
use lectorbit_services::{PlaybackService, PlaybackUpdate, PlaybackView, ProgressError};
use tauri_plugin_lectorbit::{
    BoxFuture, CaptionTrackDto, PlaybackCapabilityDto, PlaybackErrorCode, PlaybackErrorKind,
    PlaybackEventDto, PlaybackEventSink, PlaybackOps, PlaybackViewDto,
};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;
use uuid::Uuid;

use crate::embedded_media::EmbeddedMediaRegistry;

const REMUX_TIMEOUT: Duration = Duration::from_secs(120);
const CAPTION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct PlaybackAdapter {
    service: PlaybackService,
    media: EmbeddedMediaRegistry,
    grant: std::sync::Arc<Mutex<Option<ActiveGrant>>>,
    ffmpeg_path: Option<PathBuf>,
    work_dir: PathBuf,
}

struct ActiveGrant {
    token: String,
    url: String,
    cleanup_path: Option<PathBuf>,
    caption: Option<ActiveCaptionGrant>,
}

struct ActiveCaptionGrant {
    token: String,
    track: CaptionTrackDto,
    cleanup_path: PathBuf,
}

struct PreparedMedia {
    path: PathBuf,
    cleanup_path: Option<PathBuf>,
    caption_path: Option<PathBuf>,
}

impl PlaybackAdapter {
    pub fn new(
        service: PlaybackService,
        media: EmbeddedMediaRegistry,
        ffmpeg_path: Option<PathBuf>,
        work_dir: PathBuf,
    ) -> Self {
        Self {
            service,
            media,
            grant: std::sync::Arc::new(Mutex::new(None)),
            ffmpeg_path,
            work_dir,
        }
    }

    async fn active_streams(&self) -> Result<(String, Vec<CaptionTrackDto>), PlaybackErrorCode> {
        let grant = self.grant.lock().await;
        let grant = grant
            .as_ref()
            .ok_or_else(|| map_error(ProgressError::NotOpen))?;
        let captions = grant
            .caption
            .as_ref()
            .map(|caption| vec![caption.track.clone()])
            .unwrap_or_default();
        Ok((grant.url.clone(), captions))
    }

    async fn view(&self, view: PlaybackView) -> Result<PlaybackViewDto, PlaybackErrorCode> {
        let (stream_url, caption_tracks) = self.active_streams().await?;
        Ok(to_view(view, &stream_url, &caption_tracks))
    }

    async fn prepare_media(&self, source: PathBuf) -> Result<PreparedMedia, PlaybackErrorCode> {
        let mut prepared = if !requires_mp4_remux(&source) {
            PreparedMedia {
                path: source.clone(),
                cleanup_path: None,
                caption_path: None,
            }
        } else {
            let ffmpeg = self.ffmpeg_path.as_ref().ok_or_else(|| {
                playback_unavailable(
                    "This video needs the local FFmpeg helper before it can play in this window.",
                )
            })?;
            let identifier = Uuid::now_v7().simple().to_string();
            let partial = self
                .work_dir
                .join(format!("stream-{identifier}.partial.mp4"));
            let output = self.work_dir.join(format!("stream-{identifier}.mp4"));
            let mut command = Command::new(ffmpeg);
            command
                .kill_on_drop(true)
                .arg("-hide_banner")
                .arg("-loglevel")
                .arg("error")
                .arg("-nostdin")
                .arg("-y")
                .arg("-i")
                .arg(&source)
                .arg("-map")
                .arg("0:v:0?")
                .arg("-map")
                .arg("0:a:0?")
                .arg("-c")
                .arg("copy")
                .arg("-movflags")
                .arg("+faststart")
                .arg(&partial);
            let status = timeout(REMUX_TIMEOUT, command.status()).await;
            let succeeded = matches!(status, Ok(Ok(status)) if status.success())
                && partial.metadata().is_ok_and(|metadata| metadata.len() > 0)
                && std::fs::rename(&partial, &output).is_ok();
            if !succeeded {
                let _ = std::fs::remove_file(&partial);
                let _ = std::fs::remove_file(&output);
                tracing::warn!("browser-compatible media remux failed");
                return Err(playback_unavailable(
                    "This video's container could not be prepared for the in-app player.",
                ));
            }
            PreparedMedia {
                path: output.clone(),
                cleanup_path: Some(output),
                caption_path: None,
            }
        };
        prepared.caption_path = self.prepare_caption(&source).await;
        Ok(prepared)
    }

    /// Extract the first embedded text subtitle as WebVTT. Caption preparation
    /// is best-effort: bitmap subtitles and files without subtitle streams keep
    /// playing normally, while supported text tracks appear in native controls.
    async fn prepare_caption(&self, source: &Path) -> Option<PathBuf> {
        let ffmpeg = self.ffmpeg_path.as_ref()?;
        let identifier = Uuid::now_v7().simple().to_string();
        let partial = self
            .work_dir
            .join(format!("caption-{identifier}.partial.vtt"));
        let output = self.work_dir.join(format!("caption-{identifier}.vtt"));
        let mut command = Command::new(ffmpeg);
        command
            .kill_on_drop(true)
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-nostdin")
            .arg("-y")
            .arg("-i")
            .arg(source)
            .arg("-map")
            .arg("0:s:0?")
            .arg("-c:s")
            .arg("webvtt")
            .arg(&partial);
        let status = timeout(CAPTION_TIMEOUT, command.status()).await;
        let succeeded = matches!(status, Ok(Ok(status)) if status.success())
            && partial.metadata().is_ok_and(|metadata| metadata.len() > 6)
            && std::fs::rename(&partial, &output).is_ok();
        if succeeded {
            Some(output)
        } else {
            let _ = std::fs::remove_file(&partial);
            let _ = std::fs::remove_file(&output);
            None
        }
    }
}

impl PlaybackOps for PlaybackAdapter {
    fn capability(&self) -> BoxFuture<'_, Result<PlaybackCapabilityDto, PlaybackErrorCode>> {
        Box::pin(async move {
            Ok(PlaybackCapabilityDto {
                available: true,
                backend: "lectorbit-media".into(),
                expected_version: "built-in".into(),
                detected_version: Some("WebView media".into()),
            })
        })
    }

    fn open(
        &self,
        plan_item_id: String,
        sink: PlaybackEventSink,
    ) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            // An open request replaces the previous session. Revoke its opaque
            // URL up front so a failed resolve/remux cannot leave stale media
            // readable from the loopback server after the service has closed.
            if let Some(previous) = self.grant.lock().await.take() {
                cleanup_grant(&self.media, previous);
            }
            let opened_item_id = plan_item_id.clone();
            let opened = self
                .service
                .open_embedded(&plan_item_id)
                .await
                .map_err(map_error)?;
            let prepared = match self.prepare_media(opened.canonical_path).await {
                Ok(prepared) => prepared,
                Err(error) => {
                    let _ = self.service.close().await;
                    return Err(error);
                }
            };
            let Some((token, url)) = self.media.grant(prepared.path) else {
                if let Some(path) = prepared.cleanup_path {
                    let _ = std::fs::remove_file(path);
                }
                if let Some(path) = prepared.caption_path {
                    let _ = std::fs::remove_file(path);
                }
                let _ = self.service.close().await;
                return Err(map_error(ProgressError::PlaybackUnavailable));
            };
            let caption = prepared.caption_path.and_then(|path| {
                let granted = self.media.grant(path.clone());
                match granted {
                    Some((caption_token, caption_url)) => Some(ActiveCaptionGrant {
                        token: caption_token,
                        track: CaptionTrackDto {
                            label: "Captions".into(),
                            language: "und".into(),
                            url: caption_url,
                        },
                        cleanup_path: path,
                    }),
                    None => {
                        let _ = std::fs::remove_file(path);
                        None
                    }
                }
            });
            if let Some(previous) = self.grant.lock().await.replace(ActiveGrant {
                token: token.clone(),
                url: url.clone(),
                cleanup_path: prepared.cleanup_path,
                caption,
            }) {
                cleanup_grant(&self.media, previous);
            }
            let caption_tracks = self
                .grant
                .lock()
                .await
                .as_ref()
                .and_then(|grant| grant.caption.as_ref())
                .map(|caption| vec![caption.track.clone()])
                .unwrap_or_default();
            let view = to_view(opened.view, &url, &caption_tracks);
            let mut updates = self.service.subscribe();
            tauri::async_runtime::spawn(async move {
                while let Ok(update) = updates.recv().await {
                    let finished = matches!(
                        &update,
                        PlaybackUpdate::Closed { plan_item_id }
                            if plan_item_id == &opened_item_id
                    ) || matches!(&update, PlaybackUpdate::Failed { .. });
                    sink(to_event(update, &url, &caption_tracks));
                    if finished {
                        break;
                    }
                }
            });
            Ok(view)
        })
    }

    fn play(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            let view = self.service.play().await.map_err(map_error)?;
            self.view(view).await
        })
    }

    fn pause(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            let view = self.service.pause().await.map_err(map_error)?;
            self.view(view).await
        })
    }

    fn seek(&self, position_ms: u64) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            let view = self.service.seek(position_ms).await.map_err(map_error)?;
            self.view(view).await
        })
    }

    fn set_speed(&self, speed: f64) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            let view = self.service.set_speed(speed).await.map_err(map_error)?;
            self.view(view).await
        })
    }

    fn state(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            let view = self.service.state().await.map_err(map_error)?;
            self.view(view).await
        })
    }

    fn sync(
        &self,
        position_ms: u64,
        paused: bool,
        speed: f64,
    ) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            let view = self
                .service
                .sync_embedded(position_ms, paused, speed)
                .await
                .map_err(map_error)?;
            self.view(view).await
        })
    }

    fn close(&self) -> BoxFuture<'_, Result<(), PlaybackErrorCode>> {
        Box::pin(async move {
            let result = self.service.close().await.map_err(map_error);
            if let Some(grant) = self.grant.lock().await.take() {
                cleanup_grant(&self.media, grant);
            }
            result
        })
    }

    fn record_action(
        &self,
        plan_item_id: String,
        kind: String,
        at_ms: Option<u64>,
    ) -> BoxFuture<'_, Result<(), PlaybackErrorCode>> {
        Box::pin(async move {
            let kind = parse_action(&kind)?;
            self.service
                .record_action(&plan_item_id, kind, at_ms)
                .await
                .map_err(map_error)
        })
    }
}

fn requires_mp4_remux(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" | "mov" => !has_iso_bmff_signature(path),
        "mkv" | "avi" | "wmv" | "mpg" | "mpeg" | "ts" | "m2ts" => true,
        _ => false,
    }
}

fn has_iso_bmff_signature(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0_u8; 12];
    file.read_exact(&mut header).is_ok() && &header[4..8] == b"ftyp"
}

fn cleanup_grant(media: &EmbeddedMediaRegistry, grant: ActiveGrant) {
    media.revoke(&grant.token);
    if let Some(path) = grant.cleanup_path {
        let _ = std::fs::remove_file(path);
    }
    if let Some(caption) = grant.caption {
        media.revoke(&caption.token);
        let _ = std::fs::remove_file(caption.cleanup_path);
    }
}

fn playback_unavailable(message: &str) -> PlaybackErrorCode {
    PlaybackErrorCode::new(PlaybackErrorKind::PlaybackUnavailable, message)
}

fn parse_action(kind: &str) -> Result<StudyActionKind, PlaybackErrorCode> {
    match kind {
        "complete" => Ok(StudyActionKind::Complete),
        "skip" => Ok(StudyActionKind::Skip),
        "postpone" => Ok(StudyActionKind::Postpone),
        "split" => Ok(StudyActionKind::Split),
        "repeat" => Ok(StudyActionKind::Repeat),
        "must_watch" => Ok(StudyActionKind::MustWatch),
        _ => Err(PlaybackErrorCode::new(
            PlaybackErrorKind::InvalidInput,
            "Choose a supported study action.",
        )),
    }
}

fn to_view(
    view: PlaybackView,
    stream_url: &str,
    caption_tracks: &[CaptionTrackDto],
) -> PlaybackViewDto {
    PlaybackViewDto {
        plan_item_id: view.plan_item_id,
        media_id: view.media_id,
        display_name: view.display_name,
        raw_start_ms: view.raw_start_ms,
        raw_end_ms: view.raw_end_ms,
        position_ms: view.position_ms,
        duration_ms: view.duration_ms,
        paused: view.paused,
        speed: view.speed,
        progress_version: view.progress_version,
        item_covered_ms: view.item_covered_ms,
        item_duration_ms: view.item_duration_ms,
        completed: view.completed,
        stream_url: stream_url.into(),
        caption_tracks: caption_tracks.to_vec(),
    }
}

fn to_event(
    update: PlaybackUpdate,
    stream_url: &str,
    caption_tracks: &[CaptionTrackDto],
) -> PlaybackEventDto {
    match update {
        PlaybackUpdate::State(view) => {
            PlaybackEventDto::State(to_view(view, stream_url, caption_tracks))
        }
        PlaybackUpdate::Closed { plan_item_id } => PlaybackEventDto::Closed { plan_item_id },
        PlaybackUpdate::Failed { message } => PlaybackEventDto::Failed { message },
    }
}

fn map_error(error: ProgressError) -> PlaybackErrorCode {
    let (kind, message) = match error {
        ProgressError::ItemUnavailable => (
            PlaybackErrorKind::ItemUnavailable,
            "This study block is no longer available.",
        ),
        ProgressError::NotOpen => (
            PlaybackErrorKind::NotOpen,
            "Open a study block before using playback controls.",
        ),
        ProgressError::InvalidInput => (
            PlaybackErrorKind::InvalidInput,
            "The playback value is outside this study block.",
        ),
        ProgressError::PlaybackUnavailable => (
            PlaybackErrorKind::PlaybackUnavailable,
            "The in-app media player could not open this video.",
        ),
        ProgressError::Database => (
            PlaybackErrorKind::Database,
            "Progress could not be saved. Your last checkpoint is unchanged.",
        ),
    };
    PlaybackErrorCode::new(kind, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn action_parser_is_closed_to_unknown_values() {
        assert_eq!(
            parse_action("must_watch").unwrap(),
            StudyActionKind::MustWatch
        );
        assert_eq!(
            parse_action("delete").unwrap_err().kind,
            PlaybackErrorKind::InvalidInput
        );
    }

    #[test]
    fn mismatched_mp4_container_requires_remux() {
        let mut file = tempfile::Builder::new()
            .suffix(".mp4")
            .tempfile()
            .expect("temporary media");
        file.write_all(&[0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])
            .expect("write Matroska signature");
        assert!(requires_mp4_remux(file.path()));
    }

    #[test]
    fn real_mp4_container_streams_without_remux() {
        let mut file = tempfile::Builder::new()
            .suffix(".mp4")
            .tempfile()
            .expect("temporary media");
        file.write_all(&[0, 0, 0, 24, b'f', b't', b'y', b'p', 0, 0, 0, 0])
            .expect("write MP4 signature");
        assert!(!requires_mp4_remux(file.path()));
    }
}
