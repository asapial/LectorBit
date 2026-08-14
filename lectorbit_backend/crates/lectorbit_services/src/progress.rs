//! Playback orchestration, durable checkpoints, and study actions.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use lectorbit_db::{
    CheckpointResult, DbError, PlaybackItem, ProgressSnapshot, StudyActionKind, StudyRepo,
};
use lectorbit_playback::{
    EngineState, PlaybackEngine, PlaybackError, PlaybackSource, EXPECTED_MPV_VERSION,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use crate::{MediaError, MediaService};

const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(5);
const PLAYBACK_CLOCK_TOLERANCE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaybackCapability {
    pub available: bool,
    pub backend: String,
    pub expected_version: String,
    pub detected_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaybackView {
    pub plan_item_id: String,
    pub media_id: String,
    pub display_name: String,
    pub raw_start_ms: u64,
    pub raw_end_ms: u64,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub paused: bool,
    pub speed: f64,
    pub progress_version: u64,
    pub item_covered_ms: u64,
    pub item_duration_ms: u64,
    pub completed: bool,
}

pub struct EmbeddedPlaybackOpen {
    pub view: PlaybackView,
    pub canonical_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "event", content = "data")]
pub enum PlaybackUpdate {
    State(PlaybackView),
    Closed { plan_item_id: String },
    Failed { message: String },
}

#[derive(Debug, Error)]
pub enum ProgressError {
    #[error("the study block is unavailable")]
    ItemUnavailable,
    #[error("playback is not open")]
    NotOpen,
    #[error("the playback request is invalid")]
    InvalidInput,
    #[error("playback is unavailable")]
    PlaybackUnavailable,
    #[error("playback progress could not be saved")]
    Database,
}

impl From<DbError> for ProgressError {
    fn from(error: DbError) -> Self {
        tracing::error!(error = %error, "playback database operation failed");
        Self::Database
    }
}

impl From<MediaError> for ProgressError {
    fn from(error: MediaError) -> Self {
        tracing::warn!(error = %error, "playback media authorization failed");
        Self::ItemUnavailable
    }
}

impl From<PlaybackError> for ProgressError {
    fn from(error: PlaybackError) -> Self {
        tracing::warn!(error = %error, "playback adapter operation failed");
        Self::PlaybackUnavailable
    }
}

#[derive(Clone)]
pub struct PlaybackService {
    engine: Arc<dyn PlaybackEngine>,
    media: MediaService,
    study: StudyRepo,
    session: Arc<Mutex<Option<ActiveSession>>>,
    checkpoint_lock: Arc<Mutex<()>>,
    updates: broadcast::Sender<PlaybackUpdate>,
}

struct ActiveSession {
    generation: String,
    item: PlaybackItem,
    progress_version: u64,
    last_position_ms: u64,
    last_paused: bool,
    last_checkpoint: Instant,
    backend: ActiveBackend,
}

enum ActiveBackend {
    External,
    Embedded(EngineState),
}

impl PlaybackService {
    pub fn new(engine: Arc<dyn PlaybackEngine>, media: MediaService, study: StudyRepo) -> Self {
        let (updates, _) = broadcast::channel(64);
        Self {
            engine,
            media,
            study,
            session: Arc::new(Mutex::new(None)),
            checkpoint_lock: Arc::new(Mutex::new(())),
            updates,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PlaybackUpdate> {
        self.updates.subscribe()
    }

    pub async fn capability(&self) -> PlaybackCapability {
        match self.engine.probe().await {
            Ok(version) => PlaybackCapability {
                available: true,
                backend: "mpv-json-ipc".into(),
                expected_version: EXPECTED_MPV_VERSION.into(),
                detected_version: Some(version),
            },
            Err(_) => PlaybackCapability {
                available: false,
                backend: "mpv-json-ipc".into(),
                expected_version: EXPECTED_MPV_VERSION.into(),
                detected_version: None,
            },
        }
    }

    pub async fn open(&self, plan_item_id: &str) -> Result<PlaybackView, ProgressError> {
        if self.session.lock().await.is_some() {
            self.close().await?;
        }
        let item = self
            .study
            .resolve_active_item(plan_item_id)
            .await?
            .ok_or(ProgressError::ItemUnavailable)?;
        let media = self.media.resolve_authorized_media(&item.media_id).await?;
        let progress = self.study.snapshot_for_item(&item).await?;
        let resume_position =
            if (item.raw_start_ms..item.raw_end_ms).contains(&progress.position_ms) {
                progress.position_ms
            } else {
                item.raw_start_ms
            };
        let state = self
            .engine
            .open(PlaybackSource {
                media_id: item.media_id.clone(),
                canonical_path: media.canonical_path,
                start_ms: resume_position,
                end_ms: item.raw_end_ms,
            })
            .await?;
        if !progress.completed {
            self.study
                .record_action(&item, StudyActionKind::Started, None)
                .await?;
        }
        let generation = Uuid::now_v7().to_string();
        *self.session.lock().await = Some(ActiveSession {
            generation: generation.clone(),
            item: item.clone(),
            progress_version: progress.version,
            last_position_ms: state.position_ms,
            last_paused: state.paused,
            last_checkpoint: Instant::now(),
            backend: ActiveBackend::External,
        });
        let view = to_view(&item, &state, &progress);
        let _ = self.updates.send(PlaybackUpdate::State(view.clone()));
        let service = self.clone();
        tokio::spawn(async move { service.monitor(generation).await });
        Ok(view)
    }

    pub async fn open_embedded(
        &self,
        plan_item_id: &str,
    ) -> Result<EmbeddedPlaybackOpen, ProgressError> {
        if self.session.lock().await.is_some() {
            self.close().await?;
        }
        let item = self
            .study
            .resolve_active_item(plan_item_id)
            .await?
            .ok_or(ProgressError::ItemUnavailable)?;
        let media = self.media.resolve_authorized_media(&item.media_id).await?;
        let progress = self.study.snapshot_for_item(&item).await?;
        let resume_position =
            if (item.raw_start_ms..item.raw_end_ms).contains(&progress.position_ms) {
                progress.position_ms
            } else {
                item.raw_start_ms
            };
        let state = EngineState {
            position_ms: resume_position,
            duration_ms: item.media_duration_ms,
            paused: true,
            speed: 1.0,
        };
        if !progress.completed {
            self.study
                .record_action(&item, StudyActionKind::Started, None)
                .await?;
        }
        *self.session.lock().await = Some(ActiveSession {
            generation: Uuid::now_v7().to_string(),
            item: item.clone(),
            progress_version: progress.version,
            last_position_ms: state.position_ms,
            last_paused: true,
            last_checkpoint: Instant::now(),
            backend: ActiveBackend::Embedded(state.clone()),
        });
        let view = to_view(&item, &state, &progress);
        Ok(EmbeddedPlaybackOpen {
            view,
            canonical_path: media.canonical_path,
        })
    }

    pub async fn play(&self) -> Result<PlaybackView, ProgressError> {
        self.require_open().await?;
        if self
            .update_embedded_state(|state| state.paused = false)
            .await
        {
            return self.state().await;
        }
        self.engine.play().await?;
        self.state().await
    }

    pub async fn pause(&self) -> Result<PlaybackView, ProgressError> {
        self.require_open().await?;
        let before = if let Some(state) = self.embedded_state().await {
            state
        } else {
            self.engine.state().await?
        };
        self.checkpoint(&before, true).await?;
        if !self
            .update_embedded_state(|state| state.paused = true)
            .await
        {
            self.engine.pause().await?;
        }
        let item = self.require_open().await?;
        self.study
            .record_action(&item, StudyActionKind::Paused, None)
            .await?;
        self.state().await
    }

    pub async fn seek(&self, position_ms: u64) -> Result<PlaybackView, ProgressError> {
        let item = self.require_open().await?;
        if position_ms < item.raw_start_ms || position_ms > item.raw_end_ms {
            return Err(ProgressError::InvalidInput);
        }
        let before = if let Some(state) = self.embedded_state().await {
            state
        } else {
            self.engine.state().await?
        };
        self.checkpoint(&before, true).await?;
        if !self
            .update_embedded_state(|state| state.position_ms = position_ms)
            .await
        {
            self.engine.seek(position_ms).await?;
        }
        if let Some(session) = self.session.lock().await.as_mut() {
            session.last_position_ms = position_ms;
        }
        self.state().await
    }

    pub async fn set_speed(&self, speed: f64) -> Result<PlaybackView, ProgressError> {
        if !(0.5..=2.0).contains(&speed) {
            return Err(ProgressError::InvalidInput);
        }
        self.require_open().await?;
        if !self
            .update_embedded_state(|state| state.speed = speed)
            .await
        {
            self.engine.set_speed(speed).await?;
        }
        self.state().await
    }

    pub async fn sync_embedded(
        &self,
        position_ms: u64,
        paused: bool,
        speed: f64,
    ) -> Result<PlaybackView, ProgressError> {
        let item = self.require_open().await?;
        if position_ms < item.raw_start_ms
            || position_ms > item.raw_end_ms
            || !(0.5..=2.0).contains(&speed)
        {
            return Err(ProgressError::InvalidInput);
        }
        let state = EngineState {
            position_ms,
            duration_ms: item.media_duration_ms,
            paused,
            speed,
        };
        let due = {
            let mut session = self.session.lock().await;
            let Some(session) = session.as_mut() else {
                return Err(ProgressError::NotOpen);
            };
            let ActiveBackend::Embedded(embedded) = &mut session.backend else {
                return Err(ProgressError::InvalidInput);
            };
            *embedded = state.clone();
            (!paused && session.last_checkpoint.elapsed() >= CHECKPOINT_INTERVAL)
                || paused != session.last_paused
                || (position_ms >= item.raw_end_ms && session.last_position_ms < item.raw_end_ms)
        };
        if due {
            self.checkpoint(&state, true).await?;
        }
        let view = self.state().await?;
        let _ = self.updates.send(PlaybackUpdate::State(view.clone()));
        Ok(view)
    }

    pub async fn state(&self) -> Result<PlaybackView, ProgressError> {
        let item = self.require_open().await?;
        let state = if let Some(state) = self.embedded_state().await {
            state
        } else {
            self.engine.state().await?
        };
        let progress = self.study.snapshot_for_item(&item).await?;
        Ok(to_view(&item, &state, &progress))
    }

    pub async fn close(&self) -> Result<(), ProgressError> {
        let item = match self.require_open().await {
            Ok(item) => item,
            Err(ProgressError::NotOpen) => return Ok(()),
            Err(error) => return Err(error),
        };
        let embedded = self.embedded_state().await;
        let state = match embedded.as_ref() {
            Some(state) => Ok(state.clone()),
            None => self.engine.state().await,
        };
        if let Ok(state) = state {
            self.checkpoint(&state, true).await?;
        }
        if embedded.is_none() {
            self.engine.close().await?;
        }
        self.session.lock().await.take();
        let _ = self.updates.send(PlaybackUpdate::Closed {
            plan_item_id: item.id,
        });
        Ok(())
    }

    pub async fn record_action(
        &self,
        plan_item_id: &str,
        kind: StudyActionKind,
        at_ms: Option<u64>,
    ) -> Result<(), ProgressError> {
        let item = self
            .study
            .resolve_active_item(plan_item_id)
            .await?
            .ok_or(ProgressError::ItemUnavailable)?;
        match (kind, at_ms) {
            (StudyActionKind::Split, Some(position))
                if position > item.raw_start_ms && position < item.raw_end_ms => {}
            (StudyActionKind::Split, _) | (_, Some(_)) => {
                return Err(ProgressError::InvalidInput);
            }
            _ => {}
        }
        self.study.record_action(&item, kind, at_ms).await?;
        Ok(())
    }

    async fn require_open(&self) -> Result<PlaybackItem, ProgressError> {
        self.session
            .lock()
            .await
            .as_ref()
            .map(|session| session.item.clone())
            .ok_or(ProgressError::NotOpen)
    }

    async fn embedded_state(&self) -> Option<EngineState> {
        self.session
            .lock()
            .await
            .as_ref()
            .and_then(|session| match &session.backend {
                ActiveBackend::Embedded(state) => Some(state.clone()),
                ActiveBackend::External => None,
            })
    }

    async fn update_embedded_state(&self, update: impl FnOnce(&mut EngineState)) -> bool {
        let mut session = self.session.lock().await;
        let Some(ActiveSession {
            backend: ActiveBackend::Embedded(state),
            ..
        }) = session.as_mut()
        else {
            return false;
        };
        update(state);
        true
    }

    async fn monitor(&self, generation: String) {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let is_current = self
                .session
                .lock()
                .await
                .as_ref()
                .is_some_and(|session| session.generation == generation);
            if !is_current {
                break;
            }
            let mut state = match self.engine.state().await {
                Ok(state) => state,
                Err(_) => {
                    let _ = self.updates.send(PlaybackUpdate::Failed {
                        message: "Playback stopped unexpectedly.".into(),
                    });
                    self.session.lock().await.take();
                    break;
                }
            };
            let reached_end = self
                .session
                .lock()
                .await
                .as_ref()
                .is_some_and(|session| state.position_ms >= session.item.raw_end_ms);
            if reached_end && !state.paused {
                if self.engine.pause().await.is_ok() {
                    state.paused = true;
                }
            }
            let due = self.session.lock().await.as_ref().is_some_and(|session| {
                (!state.paused && session.last_checkpoint.elapsed() >= CHECKPOINT_INTERVAL)
                    || state.paused != session.last_paused
                    || (state.position_ms >= session.item.raw_end_ms
                        && session.last_position_ms < session.item.raw_end_ms)
            });
            if due && self.checkpoint(&state, true).await.is_err() {
                let _ = self.updates.send(PlaybackUpdate::Failed {
                    message: "Progress could not be saved.".into(),
                });
            }
            if let Ok(view) = self.state().await {
                let _ = self.updates.send(PlaybackUpdate::State(view));
            }
        }
    }

    async fn checkpoint(&self, state: &EngineState, force: bool) -> Result<(), ProgressError> {
        let _checkpoint_guard = self.checkpoint_lock.lock().await;
        let (item, expected_version, watched) = {
            let guard = self.session.lock().await;
            let session = guard.as_ref().ok_or(ProgressError::NotOpen)?;
            if !force && session.last_checkpoint.elapsed() < CHECKPOINT_INTERVAL {
                return Ok(());
            }
            let watched = plausible_watched_range(
                session.last_position_ms,
                state.position_ms,
                session.last_paused,
                session.last_checkpoint.elapsed(),
                state.speed,
            );
            (session.item.clone(), session.progress_version, watched)
        };
        let mut expected = expected_version;
        let mut attempts = 0;
        let saved = loop {
            let result = self
                .study
                .checkpoint(&item, state.position_ms, Some(expected), watched)
                .await?;
            match result {
                CheckpointResult::Saved(snapshot) => break snapshot,
                CheckpointResult::Conflict(current) if attempts < 2 => {
                    expected = current.version;
                    attempts += 1;
                }
                CheckpointResult::Conflict(_) => return Err(ProgressError::Database),
            }
        };
        if let Some(session) = self.session.lock().await.as_mut() {
            if session.item.id == item.id {
                session.progress_version = saved.version;
                session.last_position_ms = state.position_ms;
                session.last_paused = state.paused;
                session.last_checkpoint = Instant::now();
            }
        }
        Ok(())
    }
}

fn plausible_watched_range(
    previous_ms: u64,
    current_ms: u64,
    was_paused: bool,
    elapsed: Duration,
    speed: f64,
) -> Option<(u64, u64)> {
    let delta = current_ms.checked_sub(previous_ms)?;
    if was_paused || delta == 0 {
        return None;
    }
    // Checkpoints normally arrive every five seconds, but a suspended WebView
    // or a slow IPC round-trip can legitimately take longer. Tie the accepted
    // playhead advance to real elapsed time instead of a fixed ten-second cap,
    // while retaining a small allowance for independent media/timer clocks.
    let plausible_ms = elapsed.as_secs_f64() * 1_000.0 * speed.clamp(0.5, 2.0)
        + PLAYBACK_CLOCK_TOLERANCE.as_millis() as f64;
    (delta <= plausible_ms.ceil() as u64).then_some((previous_ms, current_ms))
}

fn to_view(item: &PlaybackItem, state: &EngineState, progress: &ProgressSnapshot) -> PlaybackView {
    PlaybackView {
        plan_item_id: item.id.clone(),
        media_id: item.media_id.clone(),
        display_name: item.display_name.clone(),
        raw_start_ms: item.raw_start_ms,
        raw_end_ms: item.raw_end_ms,
        position_ms: state.position_ms,
        duration_ms: state.duration_ms.max(item.media_duration_ms),
        paused: state.paused,
        speed: state.speed,
        progress_version: progress.version,
        item_covered_ms: progress.item_covered_ms,
        item_duration_ms: progress.item_duration_ms,
        completed: progress.completed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_never_reports_less_than_indexed_duration() {
        let item = PlaybackItem {
            id: "item".into(),
            plan_version_id: "version".into(),
            media_id: "media".into(),
            display_name: "Lesson".into(),
            raw_start_ms: 0,
            raw_end_ms: 1_000,
            media_duration_ms: 2_000,
        };
        let view = to_view(
            &item,
            &EngineState {
                position_ms: 0,
                duration_ms: 0,
                paused: true,
                speed: 1.0,
            },
            &ProgressSnapshot {
                media_id: "media".into(),
                position_ms: 0,
                duration_ms: 2_000,
                version: 0,
                covered_ms: 0,
                item_covered_ms: 0,
                item_duration_ms: 1_000,
                completed: false,
                updated_at: "now".into(),
            },
        );
        assert_eq!(view.duration_ms, 2_000);
    }

    #[test]
    fn watched_range_uses_elapsed_time_instead_of_a_fixed_delta() {
        assert_eq!(
            plausible_watched_range(1_000, 31_000, false, Duration::from_secs(30), 1.0),
            Some((1_000, 31_000))
        );
        assert_eq!(
            plausible_watched_range(1_000, 31_000, false, Duration::from_secs(5), 1.0),
            None
        );
        assert_eq!(
            plausible_watched_range(1_000, 2_000, true, Duration::from_secs(30), 1.0),
            None
        );
    }
}
