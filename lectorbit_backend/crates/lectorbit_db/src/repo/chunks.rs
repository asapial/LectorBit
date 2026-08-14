//! Read access to rebuildable timestamp chunks.

use lectorbit_core::natural_cmp;
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannerCandidateRow {
    pub media_id: String,
    pub module_id: String,
    pub module_name: String,
    pub display_name: String,
    pub path_redacted: String,
    pub duration_ms: u64,
    pub chunk_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannerCandidatePage {
    pub items: Vec<PlannerCandidateRow>,
    pub next_cursor: Option<String>,
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
            "SELECT m.id, m.root_id, m.display_name, m.media_kind, m.size_bytes, m.duration_ms, \
                    container, video_codec, audio_codec, width, height, audio_streams, \
                    subtitle_streams, probe_status, probe_error, discovered_at \
             FROM media_files m \
             JOIN library_roots r ON r.id = m.root_id AND r.revoked_at IS NULL \
             WHERE m.probe_status = 'ready' \
             ORDER BY lower(r.display_name), r.id, m.display_name COLLATE NOCASE, m.id",
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
        result.sort_by(|left, right| {
            natural_cmp(&left.media.display_name, &right.media.display_name)
                .then_with(|| left.media.id.cmp(&right.media.id))
        });
        Ok(result)
    }

    pub async fn list_candidate_page(
        &self,
        module_id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> DbResult<PlannerCandidatePage> {
        let page_size = limit.clamp(1, 200);
        let rows = sqlx::query(
            "WITH ordered_media AS ( \
                SELECT m.id, m.root_id, r.display_name AS module_name, \
                    lower(r.display_name) AS module_key, m.display_name, m.duration_ms, \
                    CASE WHEN m.display_name GLOB '[0-9]*' \
                        THEN CAST(m.display_name AS INTEGER) ELSE 9223372036854775807 END \
                        AS numeric_prefix, \
                    lower(m.display_name) AS name_key, \
                    (SELECT COUNT(*) FROM chunks c WHERE c.media_id = m.id AND c.source = ( \
                        SELECT source FROM chunks preferred WHERE preferred.media_id = m.id \
                        ORDER BY CASE source \
                            WHEN 'scene' THEN 0 WHEN 'transcript' THEN 1 ELSE 2 END LIMIT 1 \
                    )) AS chunk_count \
                FROM media_files m \
                JOIN library_roots r ON r.id = m.root_id AND r.revoked_at IS NULL \
                WHERE m.probe_status = 'ready' \
                    AND (? IS NULL OR m.root_id = ?) \
                    AND EXISTS (SELECT 1 FROM chunks existing WHERE existing.media_id = m.id) \
             ), cursor_row AS ( \
                SELECT module_key, root_id, numeric_prefix, name_key, id \
                FROM ordered_media WHERE id = ? \
             ) \
             SELECT o.id, o.root_id, o.module_name, o.display_name, o.duration_ms, o.chunk_count \
             FROM ordered_media o WHERE \
               (? IS NULL OR EXISTS (SELECT 1 FROM cursor_row c WHERE \
                  o.module_key > c.module_key OR \
                  (o.module_key = c.module_key AND o.root_id > c.root_id) OR \
                  (o.module_key = c.module_key AND o.root_id = c.root_id AND o.numeric_prefix > c.numeric_prefix) OR \
                  (o.module_key = c.module_key AND o.root_id = c.root_id AND o.numeric_prefix = c.numeric_prefix AND o.name_key > c.name_key) OR \
                  (o.module_key = c.module_key AND o.root_id = c.root_id AND o.numeric_prefix = c.numeric_prefix AND o.name_key = c.name_key AND o.id > c.id))) \
             ORDER BY o.module_key, o.root_id, o.numeric_prefix, o.name_key, o.id LIMIT ?",
        )
        .bind(module_id)
        .bind(module_id)
        .bind(cursor)
        .bind(cursor)
        .bind(i64::from(page_size + 1))
        .fetch_all(&self.pool)
        .await?;
        let mut items = rows
            .into_iter()
            .map(row_to_candidate)
            .collect::<DbResult<Vec<_>>>()?;
        let next_cursor = if items.len() > page_size as usize {
            items.truncate(page_size as usize);
            items.last().map(|item| item.media_id.clone())
        } else {
            None
        };
        Ok(PlannerCandidatePage { items, next_cursor })
    }

    /// Resolve a bounded set of planner selections directly instead of paging
    /// through the entire library. The caller still owns input validation and
    /// order; this query only returns selections that remain metadata-ready,
    /// chunked, and inside an active folder module.
    pub async fn list_candidates_by_ids(
        &self,
        media_ids: &[String],
    ) -> DbResult<Vec<PlannerCandidateRow>> {
        if media_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT m.id, m.root_id, r.display_name AS module_name, m.display_name, \
                    m.duration_ms, \
                    (SELECT COUNT(*) FROM chunks c WHERE c.media_id = m.id AND c.source = ( \
                        SELECT source FROM chunks preferred WHERE preferred.media_id = m.id \
                        ORDER BY CASE source \
                            WHEN 'scene' THEN 0 WHEN 'transcript' THEN 1 ELSE 2 END LIMIT 1 \
                    )) AS chunk_count \
             FROM media_files m \
             JOIN library_roots r ON r.id = m.root_id AND r.revoked_at IS NULL \
             WHERE m.probe_status = 'ready' \
               AND EXISTS (SELECT 1 FROM chunks existing WHERE existing.media_id = m.id) \
               AND m.id IN (",
        );
        {
            let mut ids = query.separated(", ");
            for media_id in media_ids {
                ids.push_bind(media_id);
            }
        }
        query.push(") ORDER BY lower(r.display_name), r.id, lower(m.display_name), m.id");
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(row_to_candidate)
            .collect()
    }
}

fn row_to_candidate(row: sqlx::sqlite::SqliteRow) -> DbResult<PlannerCandidateRow> {
    let display_name: String = row.try_get("display_name")?;
    let module_name: String = row.try_get("module_name")?;
    Ok(PlannerCandidateRow {
        media_id: row.try_get("id")?,
        module_id: row.try_get("root_id")?,
        path_redacted: format!("[REDACTED]/{module_name}/{display_name}"),
        module_name,
        display_name,
        duration_ms: row
            .try_get::<Option<i64>, _>("duration_ms")?
            .map(nonnegative_u64)
            .unwrap_or_default(),
        chunk_count: nonnegative_u32(row.try_get("chunk_count")?),
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[tokio::test]
    async fn candidate_pages_use_natural_numeric_order() {
        let db = Db::open_in_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO library_roots (id, display_name, canonical_path, registered_at) \
             VALUES ('root', 'Course', 'C:/Course', 'now')",
        )
        .execute(db.pool())
        .await
        .unwrap();
        for (id, name) in [
            ("ten", "10 - Feature Scaling.mp4"),
            ("two", "2 - Machine Learning Demo Get Excited.mp4"),
        ] {
            sqlx::query(
                "INSERT INTO media_files \
                 (id, root_id, path, size_bytes, mtime, discovered_at, display_name, \
                  media_kind, duration_ms, probe_status) \
                 VALUES (?, 'root', ?, 1, 'now', 'now', ?, 'video', 60000, 'ready')",
            )
            .bind(id)
            .bind(format!("C:/Course/{name}"))
            .bind(name)
            .execute(db.pool())
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO chunks \
                 (id, media_id, ordinal, start_ms, end_ms, source, analyzer_version, created_at) \
                 VALUES (?, ?, 0, 0, 60000, 'coarse', 'test', 'now')",
            )
            .bind(format!("chunk-{id}"))
            .bind(id)
            .execute(db.pool())
            .await
            .unwrap();
        }

        let repo = Repo::new(db.pool().clone());
        let first = repo.list_candidate_page(None, None, 1).await.unwrap();
        assert_eq!(first.items[0].media_id, "two");
        assert_eq!(first.items[0].module_id, "root");
        assert_eq!(first.items[0].module_name, "Course");
        assert_eq!(
            first.items[0].path_redacted,
            "[REDACTED]/Course/2 - Machine Learning Demo Get Excited.mp4"
        );
        let second = repo
            .list_candidate_page(None, first.next_cursor.as_deref(), 1)
            .await
            .unwrap();
        assert_eq!(second.items[0].media_id, "ten");

        let direct = repo
            .list_candidates_by_ids(&["ten".to_owned()])
            .await
            .unwrap();
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].media_id, "ten");
        assert_eq!(direct[0].module_name, "Course");
    }

    #[tokio::test]
    async fn candidates_are_grouped_by_active_folder_module() {
        let db = Db::open_in_memory().await.unwrap();
        for (root_id, root_name, revoked_at) in [
            ("z-root", "Zoology", None),
            ("a-root", "Algorithms", None),
            ("old-root", "Archived", Some("now")),
        ] {
            sqlx::query(
                "INSERT INTO library_roots \
                 (id, display_name, canonical_path, registered_at, revoked_at) \
                 VALUES (?, ?, ?, 'now', ?)",
            )
            .bind(root_id)
            .bind(root_name)
            .bind(format!("C:/{root_name}"))
            .bind(revoked_at)
            .execute(db.pool())
            .await
            .unwrap();
            let media_id = format!("{root_id}-media");
            sqlx::query(
                "INSERT INTO media_files \
                 (id, root_id, path, size_bytes, mtime, discovered_at, display_name, \
                  media_kind, duration_ms, probe_status) \
                 VALUES (?, ?, ?, 1, 'now', 'now', '1 - Lesson.mp4', 'video', 60000, 'ready')",
            )
            .bind(&media_id)
            .bind(root_id)
            .bind(format!("C:/{root_name}/1 - Lesson.mp4"))
            .execute(db.pool())
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO chunks \
                 (id, media_id, ordinal, start_ms, end_ms, source, analyzer_version, created_at) \
                 VALUES (?, ?, 0, 0, 60000, 'coarse', 'test', 'now')",
            )
            .bind(format!("chunk-{media_id}"))
            .bind(&media_id)
            .execute(db.pool())
            .await
            .unwrap();
        }

        let page = Repo::new(db.pool().clone())
            .list_candidate_page(None, None, 10)
            .await
            .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.module_name.as_str())
                .collect::<Vec<_>>(),
            ["Algorithms", "Zoology"]
        );
    }

    #[tokio::test]
    async fn candidate_pages_can_be_scoped_to_one_folder_module() {
        let db = Db::open_in_memory().await.unwrap();
        for (root_id, root_name) in [("module-a", "Algebra"), ("module-b", "Biology")] {
            sqlx::query(
                "INSERT INTO library_roots \
                 (id, display_name, canonical_path, registered_at) \
                 VALUES (?, ?, ?, 'now')",
            )
            .bind(root_id)
            .bind(root_name)
            .bind(format!("C:/{root_name}"))
            .execute(db.pool())
            .await
            .unwrap();
            for ordinal in 1..=2 {
                let media_id = format!("{root_id}-{ordinal}");
                let display_name = format!("{ordinal} - Lesson.mp4");
                sqlx::query(
                    "INSERT INTO media_files \
                     (id, root_id, path, size_bytes, mtime, discovered_at, display_name, \
                      media_kind, duration_ms, probe_status) \
                     VALUES (?, ?, ?, 1, 'now', 'now', ?, 'video', 60000, 'ready')",
                )
                .bind(&media_id)
                .bind(root_id)
                .bind(format!("C:/{root_name}/{display_name}"))
                .bind(&display_name)
                .execute(db.pool())
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO chunks \
                     (id, media_id, ordinal, start_ms, end_ms, source, analyzer_version, created_at) \
                     VALUES (?, ?, 0, 0, 60000, 'coarse', 'test', 'now')",
                )
                .bind(format!("chunk-{media_id}"))
                .bind(&media_id)
                .execute(db.pool())
                .await
                .unwrap();
            }
        }

        let repo = Repo::new(db.pool().clone());
        let first = repo
            .list_candidate_page(Some("module-b"), None, 1)
            .await
            .unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].module_id, "module-b");
        assert!(first.next_cursor.is_some());
        let second = repo
            .list_candidate_page(Some("module-b"), first.next_cursor.as_deref(), 1)
            .await
            .unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].module_id, "module-b");
        assert!(second.next_cursor.is_none());
    }
}
