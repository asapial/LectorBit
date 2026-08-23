//! Device-local learning-trail annotations with strict input validation.

use chrono::Utc;
use lectorbit_db::{AnnotationRow, AnnotationsRepo, DbError};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const MAX_ANNOTATION_TEXT_CHARS: usize = 240;
pub const MAX_LEARNING_TRAIL_ITEMS: u32 = 100;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationKind {
    Question,
    Takeaway,
}

impl AnnotationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Takeaway => "takeaway",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Annotation {
    pub id: String,
    pub media_id: String,
    pub at_ms: u64,
    pub kind: AnnotationKind,
    pub text: String,
    pub reviewed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Error)]
pub enum AnnotationError {
    #[error("invalid annotation input")]
    InvalidInput,
    #[error("media is unavailable")]
    MediaUnavailable,
    #[error("annotation is unavailable")]
    NotFound,
    #[error("learning trail reached its local item limit")]
    LimitReached,
    #[error("database error: {0}")]
    Database(String),
}

impl From<DbError> for AnnotationError {
    fn from(error: DbError) -> Self {
        tracing::error!(error = %error, "learning-trail database operation failed");
        Self::Database(error.to_string())
    }
}

#[derive(Clone)]
pub struct AnnotationService {
    repo: AnnotationsRepo,
}

impl AnnotationService {
    pub fn new(repo: AnnotationsRepo) -> Self {
        Self { repo }
    }

    pub async fn list(&self, media_id: &str) -> Result<Vec<Annotation>, AnnotationError> {
        self.authorized_duration(media_id).await?;
        self.repo
            .list_learning_trail(media_id, MAX_LEARNING_TRAIL_ITEMS)
            .await?
            .into_iter()
            .map(annotation_from_row)
            .collect()
    }

    pub async fn create(
        &self,
        media_id: &str,
        at_ms: u64,
        kind: AnnotationKind,
        text: &str,
    ) -> Result<Annotation, AnnotationError> {
        let duration_ms = self.authorized_duration(media_id).await?;
        if at_ms > i64::MAX as u64 || duration_ms.is_some_and(|duration| at_ms > duration) {
            return Err(AnnotationError::InvalidInput);
        }
        let text = validate_text(text)?;
        let now = Utc::now().to_rfc3339();
        let row = AnnotationRow {
            id: Uuid::now_v7().to_string(),
            media_id: media_id.into(),
            at_ms,
            kind: kind.as_str().into(),
            text,
            reviewed: false,
            created_at: now.clone(),
            updated_at: now,
        };
        if !self
            .repo
            .insert_learning_trail_bounded(&row, MAX_LEARNING_TRAIL_ITEMS)
            .await?
        {
            return Err(AnnotationError::LimitReached);
        }
        annotation_from_row(row)
    }

    pub async fn set_reviewed(
        &self,
        media_id: &str,
        annotation_id: &str,
        reviewed: bool,
    ) -> Result<Annotation, AnnotationError> {
        self.authorized_duration(media_id).await?;
        validate_identifier(annotation_id)?;
        let updated_at = Utc::now().to_rfc3339();
        self.repo
            .set_reviewed(media_id, annotation_id, reviewed, &updated_at)
            .await?
            .ok_or(AnnotationError::NotFound)
            .and_then(annotation_from_row)
    }

    pub async fn remove(&self, media_id: &str, annotation_id: &str) -> Result<(), AnnotationError> {
        self.authorized_duration(media_id).await?;
        validate_identifier(annotation_id)?;
        self.repo
            .remove(media_id, annotation_id)
            .await?
            .then_some(())
            .ok_or(AnnotationError::NotFound)
    }

    async fn authorized_duration(&self, media_id: &str) -> Result<Option<u64>, AnnotationError> {
        validate_identifier(media_id)?;
        self.repo
            .media_duration_ms(media_id)
            .await?
            .ok_or(AnnotationError::MediaUnavailable)
    }
}

fn annotation_from_row(row: AnnotationRow) -> Result<Annotation, AnnotationError> {
    let kind = match row.kind.as_str() {
        "question" => AnnotationKind::Question,
        "takeaway" => AnnotationKind::Takeaway,
        _ => {
            return Err(AnnotationError::Database(
                "unsupported annotation kind".into(),
            ))
        }
    };
    Ok(Annotation {
        id: row.id,
        media_id: row.media_id,
        at_ms: row.at_ms,
        kind,
        text: row.text,
        reviewed: row.reviewed,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn validate_identifier(value: &str) -> Result<(), AnnotationError> {
    if value.is_empty()
        || value.len() > 128
        || value.contains(['/', '\\'])
        || value.chars().any(char::is_control)
    {
        return Err(AnnotationError::InvalidInput);
    }
    Ok(())
}

fn validate_text(value: &str) -> Result<String, AnnotationError> {
    let value = value.trim();
    let valid_control_characters = |character: &char| matches!(character, '\n' | '\r' | '\t');
    if value.is_empty()
        || value.chars().count() > MAX_ANNOTATION_TEXT_CHARS
        || value
            .chars()
            .any(|character| character.is_control() && !valid_control_characters(&character))
    {
        return Err(AnnotationError::InvalidInput);
    }
    Ok(value.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seeded_service() -> AnnotationService {
        let db = lectorbit_db::Db::open_in_memory().await.expect("database");
        sqlx::query(
            "INSERT INTO library_roots \
             (id, display_name, canonical_path, registered_at, revoked_at) \
             VALUES ('root', 'Lectures', 'C:/lectures', '2026-08-23T00:00:00Z', NULL)",
        )
        .execute(db.pool())
        .await
        .expect("root");
        sqlx::query(
            "INSERT INTO media_files \
             (id, root_id, folder_id, path, size_bytes, mtime, discovered_at, display_name, duration_ms) \
             VALUES ('media', 'root', NULL, 'C:/lectures/demo.mp4', 1, \
                     '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z', 'demo.mp4', 300000)",
        )
        .execute(db.pool())
        .await
        .expect("media");
        AnnotationService::new(AnnotationsRepo::new(db.pool().clone()))
    }

    #[tokio::test]
    async fn creates_reviews_lists_and_removes_a_private_marker() {
        let service = seeded_service().await;
        let created = service
            .create(
                "media",
                245_000,
                AnnotationKind::Question,
                "  Why is this the shortest path?  ",
            )
            .await
            .expect("create marker");
        assert_eq!(created.text, "Why is this the shortest path?");
        assert!(!created.reviewed);

        let reviewed = service
            .set_reviewed("media", &created.id, true)
            .await
            .expect("review marker");
        assert!(reviewed.reviewed);
        assert_eq!(
            service.list("media").await.expect("list markers"),
            vec![reviewed]
        );

        service
            .remove("media", &created.id)
            .await
            .expect("remove marker");
        assert!(service
            .list("media")
            .await
            .expect("list markers")
            .is_empty());
    }

    #[tokio::test]
    async fn rejects_empty_oversized_and_out_of_range_markers() {
        let service = seeded_service().await;
        assert!(matches!(
            service
                .create("media", 0, AnnotationKind::Takeaway, "   ")
                .await,
            Err(AnnotationError::InvalidInput)
        ));
        assert!(matches!(
            service
                .create(
                    "media",
                    0,
                    AnnotationKind::Takeaway,
                    &"x".repeat(MAX_ANNOTATION_TEXT_CHARS + 1),
                )
                .await,
            Err(AnnotationError::InvalidInput)
        ));
        assert!(matches!(
            service
                .create("media", 300_001, AnnotationKind::Takeaway, "Remember this")
                .await,
            Err(AnnotationError::InvalidInput)
        ));
    }

    #[tokio::test]
    async fn keeps_every_saved_marker_reachable_with_a_deterministic_limit() {
        let service = seeded_service().await;
        for index in 0..MAX_LEARNING_TRAIL_ITEMS - 1 {
            service
                .create(
                    "media",
                    u64::from(index),
                    AnnotationKind::Takeaway,
                    &format!("Takeaway {index}"),
                )
                .await
                .expect("create marker within limit");
        }
        let first = service.create(
            "media",
            100,
            AnnotationKind::Question,
            "Concurrent question A",
        );
        let second = service.create(
            "media",
            101,
            AnnotationKind::Question,
            "Concurrent question B",
        );
        let (first, second) = tokio::join!(first, second);
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        assert_eq!(
            usize::from(matches!(first, Err(AnnotationError::LimitReached)))
                + usize::from(matches!(second, Err(AnnotationError::LimitReached))),
            1
        );
        assert_eq!(
            service
                .list("media")
                .await
                .expect("list every marker")
                .len(),
            MAX_LEARNING_TRAIL_ITEMS as usize
        );
    }
}
