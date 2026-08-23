//! Narrow desktop adapter for device-local learning-trail annotations.

use lectorbit_services::{Annotation, AnnotationError, AnnotationKind, AnnotationService};
use tauri_plugin_lectorbit::{
    AnnotationDto, AnnotationErrorCode, AnnotationErrorKind, AnnotationOps, BoxFuture,
};

#[derive(Clone)]
pub struct AnnotationAdapter {
    service: AnnotationService,
}

impl AnnotationAdapter {
    pub fn new(service: AnnotationService) -> Self {
        Self { service }
    }
}

impl AnnotationOps for AnnotationAdapter {
    fn list(
        &self,
        media_id: String,
    ) -> BoxFuture<'_, Result<Vec<AnnotationDto>, AnnotationErrorCode>> {
        Box::pin(async move {
            self.service
                .list(&media_id)
                .await
                .map(|annotations| annotations.into_iter().map(annotation_dto).collect())
                .map_err(map_annotation_error)
        })
    }

    fn create(
        &self,
        media_id: String,
        at_ms: u64,
        kind: String,
        text: String,
    ) -> BoxFuture<'_, Result<AnnotationDto, AnnotationErrorCode>> {
        Box::pin(async move {
            let kind = parse_kind(&kind)?;
            self.service
                .create(&media_id, at_ms, kind, &text)
                .await
                .map(annotation_dto)
                .map_err(map_annotation_error)
        })
    }

    fn set_reviewed(
        &self,
        media_id: String,
        annotation_id: String,
        reviewed: bool,
    ) -> BoxFuture<'_, Result<AnnotationDto, AnnotationErrorCode>> {
        Box::pin(async move {
            self.service
                .set_reviewed(&media_id, &annotation_id, reviewed)
                .await
                .map(annotation_dto)
                .map_err(map_annotation_error)
        })
    }

    fn remove(
        &self,
        media_id: String,
        annotation_id: String,
    ) -> BoxFuture<'_, Result<(), AnnotationErrorCode>> {
        Box::pin(async move {
            self.service
                .remove(&media_id, &annotation_id)
                .await
                .map_err(map_annotation_error)
        })
    }
}

fn parse_kind(value: &str) -> Result<AnnotationKind, AnnotationErrorCode> {
    match value {
        "question" => Ok(AnnotationKind::Question),
        "takeaway" => Ok(AnnotationKind::Takeaway),
        _ => Err(AnnotationErrorCode::new(
            AnnotationErrorKind::InvalidInput,
            "Choose question or takeaway for this learning marker.",
        )),
    }
}

fn annotation_dto(annotation: Annotation) -> AnnotationDto {
    AnnotationDto {
        id: annotation.id,
        media_id: annotation.media_id,
        at_ms: annotation.at_ms,
        kind: match annotation.kind {
            AnnotationKind::Question => "question",
            AnnotationKind::Takeaway => "takeaway",
        }
        .into(),
        text: annotation.text,
        reviewed: annotation.reviewed,
        created_at: annotation.created_at,
        updated_at: annotation.updated_at,
    }
}

fn map_annotation_error(error: AnnotationError) -> AnnotationErrorCode {
    let (kind, message) = match error {
        AnnotationError::InvalidInput => (
            AnnotationErrorKind::InvalidInput,
            "That learning marker is invalid. Keep it under 240 characters and inside the lecture.",
        ),
        AnnotationError::MediaUnavailable => (
            AnnotationErrorKind::MediaUnavailable,
            "That lecture is no longer available in the local library.",
        ),
        AnnotationError::NotFound => (
            AnnotationErrorKind::NotFound,
            "That learning marker is no longer available.",
        ),
        AnnotationError::LimitReached => (
            AnnotationErrorKind::LimitReached,
            "This lecture already has 100 learning markers. Remove an older marker before adding another.",
        ),
        AnnotationError::Database(_) => (
            AnnotationErrorKind::Database,
            "The local database could not save this learning marker.",
        ),
    };
    AnnotationErrorCode::new(kind, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_learning_trail_annotation_kinds() {
        assert_eq!(
            parse_kind("question").expect("question"),
            AnnotationKind::Question
        );
        assert_eq!(
            parse_kind("takeaway").expect("takeaway"),
            AnnotationKind::Takeaway
        );
        assert!(parse_kind("note").is_err());
    }

    #[test]
    fn capacity_error_explains_the_action_that_frees_space() {
        let error = map_annotation_error(AnnotationError::LimitReached);
        assert_eq!(error.kind, AnnotationErrorKind::LimitReached);
        assert!(error.message.contains("Remove an older marker"));
        assert!(!error.message.contains("Review or remove"));
    }
}
