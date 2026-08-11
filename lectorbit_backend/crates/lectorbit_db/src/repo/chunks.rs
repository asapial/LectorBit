//! Read access to rebuildable timestamp chunks.

use sqlx::{Row, SqlitePool};

use crate::{DbResult, MediaListItem};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredChunk {
    pub id: String,
    pub media_id: String,
    pub ordinal: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub source: String,
    pub analyzer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulableMedia {
    pub media: MediaListItem,
    pub chunks: Vec<StoredChunk>,
}

#[derive(Clone)]
pub struct Repo {
    pool: SqlitePool,
}

impl Repo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list_for_media(&self, media_id: &str) -> DbResult<Vec<StoredChunk>> {
        let rows = sqlx::query(
            "SELECT id, media_id, ordinal, start_ms, end_ms, source, analyzer_version \
             FROM chunks WHERE media_id = ? ORDER BY start_ms, ordinal",
        )
        .bind(media_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_chunk).collect()
    }

    /// Prefer deterministic scene boundaries, then transcript boundaries, and
    /// fall back to coarse windows. Only one source enters a plan, preventing
    /// overlapping derived generations from duplicating study work.
    pub async fn list_preferred_for_media(&self, media_id: &str) -> DbResult<Vec<StoredChunk>> {
        let rows = sqlx::query(
            "SELECT id, media_id, ordinal, start_ms, end_ms, source, analyzer_version \
             FROM chunks WHERE media_id = ? AND source = ( \
                 SELECT source FROM chunks WHERE media_id = ? \
                 ORDER BY CASE source \
                     WHEN 'scene' THEN 0 WHEN 'transcript' THEN 1 ELSE 2 END \
                 LIMIT 1 \
             ) ORDER BY start_ms, ordinal",
        )
        .bind(media_id)
        .bind(media_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_chunk).collect()
    }

    /// Load only metadata-ready media. Missing, failed, or currently probing
    /// files retain historical chunks but cannot enter a new plan.
    pub async fn list_schedulable(&self) -> DbResult<Vec<SchedulableMedia>> {
        let media_rows = sqlx::query(
            "SELECT id, root_id, display_name, media_kind, size_bytes, duration_ms, \
                    container, video_codec, audio_codec, width, height, audio_streams, \
                    subtitle_streams, probe_status, probe_error, discovered_at \
             FROM media_files WHERE probe_status = 'ready' \
             ORDER BY display_name COLLATE NOCASE, id",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut result = Vec::with_capacity(media_rows.len());
        for row in media_rows {
            let display_name: String = row.try_get("display_name")?;
            let media_id: String = row.try_get("id")?;
            let media = MediaListItem {
                id: media_id.clone(),
                root_id: row.try_get("root_id")?,
                path_redacted: format!("[REDACTED]/{display_name}"),
                display_name,
                media_kind: row.try_get("media_kind")?,
                size_bytes: nonnegative_u64(row.try_get("size_bytes")?),
                duration_ms: row
                    .try_get::<Option<i64>, _>("duration_ms")?
                    .map(nonnegative_u64),
                container: row.try_get("container")?,
                video_codec: row.try_get("video_codec")?,
                audio_codec: row.try_get("audio_codec")?,
                width: row.try_get::<Option<i64>, _>("width")?.map(nonnegative_u32),
                height: row
                    .try_get::<Option<i64>, _>("height")?
                    .map(nonnegative_u32),
                audio_streams: nonnegative_u32(row.try_get("audio_streams")?),
                subtitle_streams: nonnegative_u32(row.try_get("subtitle_streams")?),
                probe_status: row.try_get("probe_status")?,
                probe_error: row.try_get("probe_error")?,
                discovered_at: row.try_get("discovered_at")?,
            };
            result.push(SchedulableMedia {
                chunks: self.list_preferred_for_media(&media_id).await?,
                media,
            });
        }
        Ok(result)
    }
}

fn row_to_chunk(row: sqlx::sqlite::SqliteRow) -> DbResult<StoredChunk> {
    Ok(StoredChunk {
        id: row.try_get("id")?,
        media_id: row.try_get("media_id")?,
        ordinal: nonnegative_u32(row.try_get("ordinal")?),
        start_ms: nonnegative_u64(row.try_get("start_ms")?),
        end_ms: nonnegative_u64(row.try_get("end_ms")?),
        source: row.try_get("source")?,
        analyzer_version: row.try_get("analyzer_version")?,
    })
}

fn nonnegative_u64(value: i64) -> u64 {
    u64::try_from(value.max(0)).unwrap_or_default()
}

fn nonnegative_u32(value: i64) -> u32 {
    u32::try_from(value.max(0)).unwrap_or(u32::MAX)
}
