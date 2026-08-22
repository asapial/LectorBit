//! Persistence for versioned AI learning artifacts and deterministic reviews.

use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{DbError, DbResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptEvidenceRow {
    pub segment_id: i64,
    pub ordinal: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptContextRow {
    pub transcript_id: String,
    pub media_id: String,
    pub display_name: String,
    pub language: String,
    pub segments: Vec<TranscriptEvidenceRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LearningArtifactRow {
    pub id: String,
    pub media_id: String,
    pub transcript_id: Option<String>,
    pub kind: String,
    pub model_id: String,
    pub prompt_version: String,
    pub schema_version: u32,
    pub input_hash: String,
    pub payload_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplanationNoteRow {
    pub id: String,
    pub media_id: String,
    pub transcript_id: Option<String>,
    pub at_ms: u64,
    pub title: String,
    pub body_markdown: String,
    pub evidence_json: String,
    pub model_id: String,
    pub prompt_version: String,
    pub frame_sha256: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewStateRow {
    pub study_item_id: String,
    pub due_at: String,
    pub interval_days: u32,
    pub repetitions: u32,
    pub ease_milli: u32,
    pub last_quality: Option<u8>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StudyItemInput {
    pub kind: String,
    pub prompt: String,
    pub answer: String,
    pub hint: Option<String>,
    pub options_json: Option<String>,
    pub evidence_json: String,
    pub chapter_start_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StudyItemRow {
    pub id: String,
    pub media_id: String,
    pub chapter_start_ms: Option<u64>,
    pub kind: String,
    pub prompt: String,
    pub answer: String,
    pub hint: Option<String>,
    pub options_json: Option<String>,
    pub evidence_json: String,
    pub due_at: String,
    pub interval_days: u32,
    pub repetitions: u32,
    pub ease_milli: u32,
    pub last_quality: Option<u8>,
}

#[derive(Clone)]
pub struct Repo {
    pool: SqlitePool,
}

impl Repo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn active_transcript(
        &self,
        media_id: &str,
    ) -> DbResult<Option<TranscriptContextRow>> {
        let transcript = sqlx::query(
            "SELECT t.id, t.media_id, t.language, m.display_name \
             FROM transcripts t JOIN media_files m ON m.id = t.media_id \
             WHERE t.media_id = ? AND t.superseded_at IS NULL \
             ORDER BY t.created_at DESC LIMIT 1",
        )
        .bind(media_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(transcript) = transcript else {
            return Ok(None);
        };
        let transcript_id: String = transcript.try_get("id")?;
        let rows = sqlx::query(
            "SELECT id, ordinal, start_ms, end_ms, text FROM transcript_segments \
             WHERE transcript_id = ? ORDER BY ordinal",
        )
        .bind(&transcript_id)
        .fetch_all(&self.pool)
        .await?;
        let segments = rows
            .into_iter()
            .map(|row| {
                Ok(TranscriptEvidenceRow {
                    segment_id: row.try_get("id")?,
                    ordinal: nonnegative_u32(row.try_get("ordinal")?),
                    start_ms: nonnegative_u64(row.try_get("start_ms")?),
                    end_ms: nonnegative_u64(row.try_get("end_ms")?),
                    text: row.try_get("text")?,
                })
            })
            .collect::<DbResult<Vec<_>>>()?;
        Ok(Some(TranscriptContextRow {
            transcript_id,
            media_id: transcript.try_get("media_id")?,
            display_name: transcript.try_get("display_name")?,
            language: transcript.try_get("language")?,
            segments,
        }))
    }

    pub async fn transcript_window(
        &self,
        media_id: &str,
        at_ms: u64,
        before_ms: u64,
        after_ms: u64,
        limit: u32,
    ) -> DbResult<Option<TranscriptContextRow>> {
        let Some(mut context) = self.active_transcript(media_id).await? else {
            return Ok(None);
        };
        let window_start = at_ms.saturating_sub(before_ms);
        let window_end = at_ms.saturating_add(after_ms);
        context
            .segments
            .retain(|segment| segment.end_ms >= window_start && segment.start_ms <= window_end);
        let limit = usize::try_from(limit.clamp(1, 500)).unwrap_or(500);
        if context.segments.len() > limit {
            let nearest = context
                .segments
                .iter()
                .position(|segment| segment.start_ms <= at_ms && segment.end_ms >= at_ms)
                .unwrap_or(context.segments.len() / 2);
            let start = nearest
                .saturating_sub(limit / 2)
                .min(context.segments.len() - limit);
            context.segments = context.segments[start..start + limit].to_vec();
        }
        Ok(Some(context))
    }

    pub async fn active_artifact(
        &self,
        media_id: &str,
        kind: &str,
    ) -> DbResult<Option<LearningArtifactRow>> {
        let row = sqlx::query(
            "SELECT id, media_id, transcript_id, kind, model_id, prompt_version, \
                    schema_version, input_hash, payload_json, created_at \
             FROM learning_artifacts WHERE media_id = ? AND kind = ? \
               AND superseded_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(media_id)
        .bind(kind)
        .fetch_optional(&self.pool)
        .await?;
        row.map(artifact_from_row).transpose()
    }

    pub async fn save_artifact(
        &self,
        media_id: &str,
        transcript_id: Option<&str>,
        kind: &str,
        model_id: &str,
        prompt_version: &str,
        schema_version: u32,
        input_hash: &str,
        payload_json: &str,
    ) -> DbResult<LearningArtifactRow> {
        if input_hash.len() != 64
            || serde_json::from_str::<serde_json::Value>(payload_json).is_err()
        {
            return Err(DbError::Pool("invalid learning artifact".into()));
        }
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        if let Some(existing) = sqlx::query(
            "SELECT id, media_id, transcript_id, kind, model_id, prompt_version, \
                    schema_version, input_hash, payload_json, created_at \
             FROM learning_artifacts WHERE media_id = ? AND kind = ? AND input_hash = ? \
               AND superseded_at IS NULL LIMIT 1",
        )
        .bind(media_id)
        .bind(kind)
        .bind(input_hash)
        .fetch_optional(&mut *transaction)
        .await?
        {
            transaction.commit().await?;
            return artifact_from_row(existing);
        }
        sqlx::query(
            "UPDATE learning_artifacts SET superseded_at = ? \
             WHERE media_id = ? AND kind = ? AND superseded_at IS NULL",
        )
        .bind(&now)
        .bind(media_id)
        .bind(kind)
        .execute(&mut *transaction)
        .await?;
        let id = Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO learning_artifacts \
             (id, media_id, transcript_id, kind, model_id, prompt_version, schema_version, \
              input_hash, payload_json, created_at, superseded_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .bind(&id)
        .bind(media_id)
        .bind(transcript_id)
        .bind(kind)
        .bind(model_id)
        .bind(prompt_version)
        .bind(i64::from(schema_version))
        .bind(input_hash)
        .bind(payload_json)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(LearningArtifactRow {
            id,
            media_id: media_id.into(),
            transcript_id: transcript_id.map(str::to_owned),
            kind: kind.into(),
            model_id: model_id.into(),
            prompt_version: prompt_version.into(),
            schema_version,
            input_hash: input_hash.into(),
            payload_json: payload_json.into(),
            created_at: now,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn save_explanation_note(
        &self,
        media_id: &str,
        transcript_id: Option<&str>,
        at_ms: u64,
        title: &str,
        body_markdown: &str,
        evidence_json: &str,
        model_id: &str,
        prompt_version: &str,
        frame_sha256: Option<&str>,
    ) -> DbResult<ExplanationNoteRow> {
        if title.trim().is_empty()
            || body_markdown.trim().is_empty()
            || serde_json::from_str::<serde_json::Value>(evidence_json).is_err()
        {
            return Err(DbError::Pool("invalid explanation note".into()));
        }
        let row = ExplanationNoteRow {
            id: Uuid::now_v7().to_string(),
            media_id: media_id.into(),
            transcript_id: transcript_id.map(str::to_owned),
            at_ms,
            title: title.trim().into(),
            body_markdown: body_markdown.trim().into(),
            evidence_json: evidence_json.into(),
            model_id: model_id.into(),
            prompt_version: prompt_version.into(),
            frame_sha256: frame_sha256.map(str::to_owned),
            created_at: Utc::now().to_rfc3339(),
        };
        sqlx::query(
            "INSERT INTO explanation_notes \
             (id, media_id, transcript_id, at_ms, title, body_markdown, evidence_json, \
              model_id, prompt_version, frame_sha256, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&row.id)
        .bind(&row.media_id)
        .bind(&row.transcript_id)
        .bind(to_i64(row.at_ms))
        .bind(&row.title)
        .bind(&row.body_markdown)
        .bind(&row.evidence_json)
        .bind(&row.model_id)
        .bind(&row.prompt_version)
        .bind(&row.frame_sha256)
        .bind(&row.created_at)
        .execute(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_explanation_notes(
        &self,
        media_id: &str,
        limit: u32,
    ) -> DbResult<Vec<ExplanationNoteRow>> {
        let rows = sqlx::query(
            "SELECT id, media_id, transcript_id, at_ms, title, body_markdown, evidence_json, \
                    model_id, prompt_version, frame_sha256, created_at \
             FROM explanation_notes WHERE media_id = ? \
             ORDER BY at_ms, created_at DESC LIMIT ?",
        )
        .bind(media_id)
        .bind(i64::from(limit.clamp(1, 500)))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(note_from_row).collect()
    }

    pub async fn replace_study_items(
        &self,
        artifact_id: &str,
        media_id: &str,
        items: &[StudyItemInput],
    ) -> DbResult<Vec<StudyItemRow>> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let old_ids = sqlx::query_scalar::<_, String>(
            "SELECT item.id FROM study_items item \
             JOIN learning_artifacts artifact ON artifact.id = item.artifact_id \
             WHERE item.media_id = ? AND artifact.kind = 'study_materials' \
               AND artifact.id != ?",
        )
        .bind(media_id)
        .bind(artifact_id)
        .fetch_all(&mut *transaction)
        .await?;
        for old_id in old_ids {
            sqlx::query("DELETE FROM study_items WHERE id = ?")
                .bind(old_id)
                .execute(&mut *transaction)
                .await?;
        }
        let mut result = Vec::with_capacity(items.len());
        for item in items {
            if !matches!(
                item.kind.as_str(),
                "flashcard" | "multiple_choice" | "short_answer" | "explain_own_words"
            ) || item.prompt.trim().is_empty()
                || item.answer.trim().is_empty()
                || serde_json::from_str::<serde_json::Value>(&item.evidence_json).is_err()
                || item
                    .options_json
                    .as_deref()
                    .is_some_and(|value| serde_json::from_str::<serde_json::Value>(value).is_err())
            {
                return Err(DbError::Pool("invalid generated study item".into()));
            }
            let id = Uuid::now_v7().to_string();
            sqlx::query(
                "INSERT INTO study_items \
                 (id, artifact_id, media_id, chapter_start_ms, kind, prompt, answer, hint, \
                  options_json, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(artifact_id)
            .bind(media_id)
            .bind(item.chapter_start_ms.map(to_i64))
            .bind(&item.kind)
            .bind(item.prompt.trim())
            .bind(item.answer.trim())
            .bind(item.hint.as_deref().map(str::trim))
            .bind(&item.options_json)
            .bind(&item.evidence_json)
            .bind(&now)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "INSERT INTO review_states \
                 (study_item_id, due_at, interval_days, repetitions, ease_milli, last_quality, updated_at) \
                 VALUES (?, ?, 0, 0, 2500, NULL, ?)",
            )
            .bind(&id)
            .bind(&now)
            .bind(&now)
            .execute(&mut *transaction)
            .await?;
            result.push(StudyItemRow {
                id,
                media_id: media_id.into(),
                chapter_start_ms: item.chapter_start_ms,
                kind: item.kind.clone(),
                prompt: item.prompt.trim().into(),
                answer: item.answer.trim().into(),
                hint: item.hint.as_deref().map(str::trim).map(str::to_owned),
                options_json: item.options_json.clone(),
                evidence_json: item.evidence_json.clone(),
                due_at: now.clone(),
                interval_days: 0,
                repetitions: 0,
                ease_milli: 2500,
                last_quality: None,
            });
        }
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn list_study_items(
        &self,
        media_id: &str,
        limit: u32,
    ) -> DbResult<Vec<StudyItemRow>> {
        let rows = sqlx::query(
            "SELECT item.id, item.media_id, item.chapter_start_ms, item.kind, item.prompt, \
                    item.answer, item.hint, item.options_json, item.evidence_json, state.due_at, \
                    state.interval_days, state.repetitions, state.ease_milli, state.last_quality \
             FROM study_items item \
             JOIN learning_artifacts artifact ON artifact.id = item.artifact_id \
             JOIN review_states state ON state.study_item_id = item.id \
             WHERE item.media_id = ? AND artifact.superseded_at IS NULL \
             ORDER BY state.due_at, item.created_at, item.id LIMIT ?",
        )
        .bind(media_id)
        .bind(i64::from(limit.clamp(1, 1000)))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(study_item_from_row).collect()
    }

    pub async fn list_due_study_items(
        &self,
        due_before: &str,
        limit: u32,
    ) -> DbResult<Vec<StudyItemRow>> {
        let rows = sqlx::query(
            "SELECT item.id, item.media_id, item.chapter_start_ms, item.kind, item.prompt, \
                    item.answer, item.hint, item.options_json, item.evidence_json, state.due_at, \
                    state.interval_days, state.repetitions, state.ease_milli, state.last_quality \
             FROM study_items item \
             JOIN learning_artifacts artifact ON artifact.id = item.artifact_id \
             JOIN review_states state ON state.study_item_id = item.id \
             WHERE julianday(state.due_at) <= julianday(?) AND artifact.superseded_at IS NULL \
             ORDER BY state.due_at, item.created_at, item.id LIMIT ?",
        )
        .bind(due_before)
        .bind(i64::from(limit.clamp(1, 500)))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(study_item_from_row).collect()
    }

    /// Deterministic SM-2 update. The model never selects review dates.
    pub async fn record_review(
        &self,
        study_item_id: &str,
        quality: u8,
        confidence: u8,
        response_time_ms: u64,
        answer_text: Option<&str>,
    ) -> DbResult<ReviewStateRow> {
        if quality > 5 || !(1..=5).contains(&confidence) {
            return Err(DbError::Pool("invalid review score".into()));
        }
        let now = Utc::now();
        let current = sqlx::query(
            "SELECT interval_days, repetitions, ease_milli FROM review_states \
             WHERE study_item_id = ?",
        )
        .bind(study_item_id)
        .fetch_optional(&self.pool)
        .await?;
        let (mut interval, mut repetitions, mut ease) =
            current.map_or((0_u32, 0_u32, 2500_i32), |row| {
                (
                    nonnegative_u32(row.try_get("interval_days").unwrap_or(0)),
                    nonnegative_u32(row.try_get("repetitions").unwrap_or(0)),
                    row.try_get::<i64, _>("ease_milli").unwrap_or(2500) as i32,
                )
            });
        if quality < 3 {
            repetitions = 0;
            interval = 1;
        } else {
            interval = match repetitions {
                0 => 1,
                1 => 6,
                _ => ((u64::from(interval) * u64::try_from(ease).unwrap_or(2500)) / 1000)
                    .clamp(1, u64::from(u32::MAX)) as u32,
            };
            repetitions = repetitions.saturating_add(1);
        }
        let q = i32::from(quality);
        ease = (ease + 100 - (5 - q) * (80 + (5 - q) * 20)).clamp(1300, 3000);
        let due_at = now
            .checked_add_signed(Duration::days(i64::from(interval)))
            .unwrap_or(now)
            .to_rfc3339();
        let updated_at = now.to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO review_attempts \
             (id, study_item_id, quality, confidence, response_time_ms, answer_text, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(study_item_id)
        .bind(i64::from(quality))
        .bind(i64::from(confidence))
        .bind(to_i64(response_time_ms))
        .bind(answer_text)
        .bind(&updated_at)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO review_states \
             (study_item_id, due_at, interval_days, repetitions, ease_milli, last_quality, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(study_item_id) DO UPDATE SET due_at = excluded.due_at, \
               interval_days = excluded.interval_days, repetitions = excluded.repetitions, \
               ease_milli = excluded.ease_milli, last_quality = excluded.last_quality, \
               updated_at = excluded.updated_at",
        )
        .bind(study_item_id)
        .bind(&due_at)
        .bind(i64::from(interval))
        .bind(i64::from(repetitions))
        .bind(i64::from(ease))
        .bind(i64::from(quality))
        .bind(&updated_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(ReviewStateRow {
            study_item_id: study_item_id.into(),
            due_at,
            interval_days: interval,
            repetitions,
            ease_milli: u32::try_from(ease).unwrap_or(1300),
            last_quality: Some(quality),
            updated_at,
        })
    }
}

fn artifact_from_row(row: sqlx::sqlite::SqliteRow) -> DbResult<LearningArtifactRow> {
    Ok(LearningArtifactRow {
        id: row.try_get("id")?,
        media_id: row.try_get("media_id")?,
        transcript_id: row.try_get("transcript_id")?,
        kind: row.try_get("kind")?,
        model_id: row.try_get("model_id")?,
        prompt_version: row.try_get("prompt_version")?,
        schema_version: nonnegative_u32(row.try_get("schema_version")?),
        input_hash: row.try_get("input_hash")?,
        payload_json: row.try_get("payload_json")?,
        created_at: row.try_get("created_at")?,
    })
}

fn note_from_row(row: sqlx::sqlite::SqliteRow) -> DbResult<ExplanationNoteRow> {
    Ok(ExplanationNoteRow {
        id: row.try_get("id")?,
        media_id: row.try_get("media_id")?,
        transcript_id: row.try_get("transcript_id")?,
        at_ms: nonnegative_u64(row.try_get("at_ms")?),
        title: row.try_get("title")?,
        body_markdown: row.try_get("body_markdown")?,
        evidence_json: row.try_get("evidence_json")?,
        model_id: row.try_get("model_id")?,
        prompt_version: row.try_get("prompt_version")?,
        frame_sha256: row.try_get("frame_sha256")?,
        created_at: row.try_get("created_at")?,
    })
}

fn study_item_from_row(row: sqlx::sqlite::SqliteRow) -> DbResult<StudyItemRow> {
    Ok(StudyItemRow {
        id: row.try_get("id")?,
        media_id: row.try_get("media_id")?,
        chapter_start_ms: row
            .try_get::<Option<i64>, _>("chapter_start_ms")?
            .map(nonnegative_u64),
        kind: row.try_get("kind")?,
        prompt: row.try_get("prompt")?,
        answer: row.try_get("answer")?,
        hint: row.try_get("hint")?,
        options_json: row.try_get("options_json")?,
        evidence_json: row.try_get("evidence_json")?,
        due_at: row.try_get("due_at")?,
        interval_days: nonnegative_u32(row.try_get("interval_days")?),
        repetitions: nonnegative_u32(row.try_get("repetitions")?),
        ease_milli: nonnegative_u32(row.try_get("ease_milli")?),
        last_quality: row
            .try_get::<Option<i64>, _>("last_quality")?
            .and_then(|value| u8::try_from(value).ok()),
    })
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn nonnegative_u64(value: i64) -> u64 {
    u64::try_from(value.max(0)).unwrap_or_default()
}

fn nonnegative_u32(value: i64) -> u32 {
    u32::try_from(value.max(0)).unwrap_or_default()
}
