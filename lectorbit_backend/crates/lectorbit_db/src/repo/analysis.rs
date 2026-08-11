//! Persistence for local model installs, versioned transcripts, and FTS search.

use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{DbError, DbResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelManifestRow {
    pub id: String,
    pub version: String,
    pub provider: String,
    pub source_url: String,
    pub expected_size_bytes: u64,
    pub sha256: String,
    pub architecture: String,
    pub analyzer_compatibility: String,
    pub license: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInstallRow {
    pub manifest: ModelManifestRow,
    pub state: String,
    pub bytes_downloaded: u64,
    pub installed_path: Option<String>,
    pub verified_at: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptSegmentInput {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchRow {
    pub media_id: String,
    pub display_name: String,
    pub plan_item_id: Option<String>,
    pub source: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub snippet: String,
    pub rank: f64,
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

    pub async fn sync_manifests(&self, manifests: &[ModelManifestRow]) -> DbResult<()> {
        let mut transaction = self.pool.begin().await?;
        let now = Utc::now().to_rfc3339();
        for model in manifests {
            sqlx::query(
                "INSERT INTO models (id, version, provider, source_url, expected_size_bytes, \
                 sha256, architecture, analyzer_compatibility, license) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET version = excluded.version, \
                 provider = excluded.provider, source_url = excluded.source_url, \
                 expected_size_bytes = excluded.expected_size_bytes, sha256 = excluded.sha256, \
                 architecture = excluded.architecture, \
                 analyzer_compatibility = excluded.analyzer_compatibility, license = excluded.license",
            )
            .bind(&model.id)
            .bind(&model.version)
            .bind(&model.provider)
            .bind(&model.source_url)
            .bind(to_i64(model.expected_size_bytes))
            .bind(&model.sha256)
            .bind(&model.architecture)
            .bind(&model.analyzer_compatibility)
            .bind(&model.license)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "INSERT INTO model_installs \
                 (model_id, state, bytes_downloaded, installed_path, verified_at, last_error, updated_at) \
                 VALUES (?, 'available', 0, NULL, NULL, NULL, ?) ON CONFLICT(model_id) DO NOTHING",
            )
            .bind(&model.id)
            .bind(&now)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn list_models(&self) -> DbResult<Vec<ModelInstallRow>> {
        let rows = sqlx::query(
            "SELECT m.id, m.version, m.provider, m.source_url, m.expected_size_bytes, \
                    m.sha256, m.architecture, m.analyzer_compatibility, m.license, \
                    i.state, i.bytes_downloaded, i.installed_path, i.verified_at, \
                    i.last_error, i.updated_at \
             FROM models m JOIN model_installs i ON i.model_id = m.id ORDER BY m.expected_size_bytes, m.id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(model_from_row).collect()
    }

    pub async fn get_model(&self, id: &str) -> DbResult<Option<ModelInstallRow>> {
        let row = sqlx::query(
            "SELECT m.id, m.version, m.provider, m.source_url, m.expected_size_bytes, \
                    m.sha256, m.architecture, m.analyzer_compatibility, m.license, \
                    i.state, i.bytes_downloaded, i.installed_path, i.verified_at, \
                    i.last_error, i.updated_at \
             FROM models m JOIN model_installs i ON i.model_id = m.id WHERE m.id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(model_from_row).transpose()
    }

    pub async fn update_install(
        &self,
        id: &str,
        state: &str,
        bytes_downloaded: u64,
        installed_path: Option<&str>,
        verified_at: Option<&str>,
        last_error: Option<&str>,
    ) -> DbResult<()> {
        let result = sqlx::query(
            "UPDATE model_installs SET state = ?, bytes_downloaded = ?, installed_path = ?, \
             verified_at = ?, last_error = ?, updated_at = ? WHERE model_id = ?",
        )
        .bind(state)
        .bind(to_i64(bytes_downloaded))
        .bind(installed_path)
        .bind(verified_at)
        .bind(last_error)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(DbError::Pool("model not found".into()));
        }
        Ok(())
    }

    pub async fn update_download_progress(&self, id: &str, bytes_downloaded: u64) -> DbResult<()> {
        sqlx::query(
            "UPDATE model_installs SET bytes_downloaded = MAX(bytes_downloaded, ?), updated_at = ? \
             WHERE model_id = ? AND state = 'downloading'",
        )
        .bind(to_i64(bytes_downloaded))
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn save_transcript(
        &self,
        media_id: &str,
        model_id: &str,
        analyzer_version: &str,
        language: &str,
        segments: &[TranscriptSegmentInput],
    ) -> DbResult<String> {
        if segments.is_empty() {
            return Err(DbError::Pool("transcript has no segments".into()));
        }
        let mut transaction = self.pool.begin().await?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE transcripts SET superseded_at = ? WHERE media_id = ? AND superseded_at IS NULL",
        )
        .bind(&now)
        .bind(media_id)
        .execute(&mut *transaction)
        .await?;
        let transcript_id = Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO transcripts \
             (id, media_id, model_id, analyzer_version, language, created_at, superseded_at) \
             VALUES (?, ?, ?, ?, ?, ?, NULL)",
        )
        .bind(&transcript_id)
        .bind(media_id)
        .bind(model_id)
        .bind(analyzer_version)
        .bind(language)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        for (ordinal, segment) in segments.iter().enumerate() {
            sqlx::query(
                "INSERT INTO transcript_segments \
                 (transcript_id, media_id, ordinal, start_ms, end_ms, text) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&transcript_id)
            .bind(media_id)
            .bind(ordinal as i64)
            .bind(to_i64(segment.start_ms))
            .bind(to_i64(segment.end_ms))
            .bind(segment.text.trim())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(transcript_id)
    }

    pub async fn transcript_state(&self, media_id: &str) -> DbResult<Option<(String, u64)>> {
        let row = sqlx::query(
            "SELECT t.created_at, COUNT(s.id) AS segment_count \
             FROM transcripts t JOIN transcript_segments s ON s.transcript_id = t.id \
             WHERE t.media_id = ? AND t.superseded_at IS NULL GROUP BY t.id",
        )
        .bind(media_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok((
                row.try_get("created_at")?,
                row.try_get::<i64, _>("segment_count")?.max(0) as u64,
            ))
        })
        .transpose()
    }

    pub async fn search(&self, query: &str, limit: u32) -> DbResult<Vec<SearchRow>> {
        let limit = i64::from(limit.clamp(1, 100));
        let rows = sqlx::query(
            "SELECT media_id, display_name, plan_item_id, source, start_ms, end_ms, snippet, rank FROM ( \
               SELECT m.id AS media_id, m.display_name, \
                      (SELECT item.id FROM plan_version_items item \
                       JOIN plans p ON p.active_version_id = item.plan_version_id \
                       WHERE item.media_id = m.id AND p.user_id = 'local' AND p.archived_at IS NULL \
                       ORDER BY item.sequence LIMIT 1) AS plan_item_id, 'media' AS source, \
                      NULL AS start_ms, NULL AS end_ms, \
                      snippet(media_fts, 1, '<mark>', '</mark>', ' … ', 18) AS snippet, \
                      bm25(media_fts, 8.0) AS rank \
               FROM media_fts JOIN media_files m ON m.id = media_fts.media_id \
               WHERE media_fts MATCH ? \
               UNION ALL \
               SELECT m.id, m.display_name, \
                      (SELECT item.id FROM plan_version_items item \
                       JOIN plans p ON p.active_version_id = item.plan_version_id \
                       WHERE item.media_id = m.id AND p.user_id = 'local' AND p.archived_at IS NULL \
                         AND item.raw_start_ms <= s.start_ms AND item.raw_end_ms >= s.start_ms \
                       ORDER BY item.sequence LIMIT 1), \
                      'transcript', s.start_ms, s.end_ms, \
                      snippet(transcript_fts, 3, '<mark>', '</mark>', ' … ', 24), \
                      bm25(transcript_fts, 4.0) \
               FROM transcript_fts \
               JOIN transcript_segments s ON s.id = CAST(transcript_fts.segment_id AS INTEGER) \
               JOIN transcripts t ON t.id = s.transcript_id AND t.superseded_at IS NULL \
               JOIN media_files m ON m.id = s.media_id \
               WHERE transcript_fts MATCH ? \
               UNION ALL \
               SELECT m.id, m.display_name, \
                      (SELECT item.id FROM plan_version_items item \
                       JOIN plans p ON p.active_version_id = item.plan_version_id \
                       WHERE item.media_id = m.id AND p.user_id = 'local' AND p.archived_at IS NULL \
                         AND item.raw_start_ms <= a.at_ms AND item.raw_end_ms >= a.at_ms \
                       ORDER BY item.sequence LIMIT 1), \
                      'annotation', a.at_ms, a.at_ms, \
                      snippet(annotation_fts, 2, '<mark>', '</mark>', ' … ', 24), \
                      bm25(annotation_fts, 5.0) \
               FROM annotation_fts \
               JOIN annotations a ON a.id = annotation_fts.annotation_id \
               JOIN media_files m ON m.id = a.media_id \
               WHERE annotation_fts MATCH ? \
             ) ORDER BY rank ASC LIMIT ?",
        )
        .bind(query)
        .bind(query)
        .bind(query)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(SearchRow {
                    media_id: row.try_get("media_id")?,
                    display_name: row.try_get("display_name")?,
                    plan_item_id: row.try_get("plan_item_id")?,
                    source: row.try_get("source")?,
                    start_ms: row
                        .try_get::<Option<i64>, _>("start_ms")?
                        .map(|value| value.max(0) as u64),
                    end_ms: row
                        .try_get::<Option<i64>, _>("end_ms")?
                        .map(|value| value.max(0) as u64),
                    snippet: row.try_get("snippet")?,
                    rank: row.try_get("rank")?,
                })
            })
            .collect()
    }
}

fn model_from_row(row: sqlx::sqlite::SqliteRow) -> DbResult<ModelInstallRow> {
    Ok(ModelInstallRow {
        manifest: ModelManifestRow {
            id: row.try_get("id")?,
            version: row.try_get("version")?,
            provider: row.try_get("provider")?,
            source_url: row.try_get("source_url")?,
            expected_size_bytes: row.try_get::<i64, _>("expected_size_bytes")?.max(0) as u64,
            sha256: row.try_get("sha256")?,
            architecture: row.try_get("architecture")?,
            analyzer_compatibility: row.try_get("analyzer_compatibility")?,
            license: row.try_get("license")?,
        },
        state: row.try_get("state")?,
        bytes_downloaded: row.try_get::<i64, _>("bytes_downloaded")?.max(0) as u64,
        installed_path: row.try_get("installed_path")?,
        verified_at: row.try_get("verified_at")?,
        last_error: row.try_get("last_error")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn to_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}
