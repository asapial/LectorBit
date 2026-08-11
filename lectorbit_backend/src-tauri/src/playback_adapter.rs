//! Safe plugin mapping for playback, progress, and study actions.

use lectorbit_db::StudyActionKind;
use lectorbit_services::{PlaybackService, PlaybackUpdate, PlaybackView, ProgressError};
use tauri_plugin_lectorbit::{
    BoxFuture, PlaybackCapabilityDto, PlaybackErrorCode, PlaybackErrorKind, PlaybackEventDto,
    PlaybackEventSink, PlaybackOps, PlaybackViewDto,
};

#[derive(Clone)]
pub struct PlaybackAdapter {
    service: PlaybackService,
}

impl PlaybackAdapter {
    pub fn new(service: PlaybackService) -> Self {
        Self { service }
    }
}

impl PlaybackOps for PlaybackAdapter {
    fn capability(&self) -> BoxFuture<'_, Result<PlaybackCapabilityDto, PlaybackErrorCode>> {
        Box::pin(async move {
            let capability = self.service.capability().await;
            Ok(PlaybackCapabilityDto {
                available: capability.available,
                backend: capability.backend,
                expected_version: capability.expected_version,
                detected_version: capability.detected_version,
            })
        })
    }

    fn open(
        &self,
        plan_item_id: String,
        sink: PlaybackEventSink,
    ) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            let opened_item_id = plan_item_id.clone();
            let view = self
                .service
                .open(&plan_item_id)
                .await
                .map(to_view)
                .map_err(map_error)?;
            let mut updates = self.service.subscribe();
            tauri::async_runtime::spawn(async move {
                while let Ok(update) = updates.recv().await {
                    let finished = matches!(
                        &update,
                        PlaybackUpdate::Closed { plan_item_id }
                            if plan_item_id == &opened_item_id
                    ) || matches!(&update, PlaybackUpdate::Failed { .. });
                    sink(to_event(update));
                    if finished {
                        break;
                    }
                }
            });
            Ok(view)
        })
    }

    fn play(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move { self.service.play().await.map(to_view).map_err(map_error) })
    }

    fn pause(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move { self.service.pause().await.map(to_view).map_err(map_error) })
    }

    fn seek(&self, position_ms: u64) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            self.service
                .seek(position_ms)
                .await
                .map(to_view)
                .map_err(map_error)
        })
    }

    fn set_speed(&self, speed: f64) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move {
            self.service
                .set_speed(speed)
                .await
                .map(to_view)
                .map_err(map_error)
        })
    }

    fn state(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>> {
        Box::pin(async move { self.service.state().await.map(to_view).map_err(map_error) })
    }

    fn close(&self) -> BoxFuture<'_, Result<(), PlaybackErrorCode>> {
        Box::pin(async move { self.service.close().await.map_err(map_error) })
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

fn to_view(view: PlaybackView) -> PlaybackViewDto {
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
    }
}

fn to_event(update: PlaybackUpdate) -> PlaybackEventDto {
    match update {
        PlaybackUpdate::State(view) => PlaybackEventDto::State(to_view(view)),
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
            "mpv playback is unavailable. Check the pinned sidecar in Diagnostics.",
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
}
