//! Media discovery and ffprobe metadata persistence.

use chrono::Utc;
use lectorbit_core::planning::derive_coarse_chunks;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{DbError, DbResult};

#[derive(Debug, Clone)]
pub struct DiscoveredMedia {
    pub path: String,
    pub display_name: String,
    pub media_kind: String,
    pub size_bytes: i64,
    pub mtime: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeCandidate {
    pub media_id: String,
    pub root_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeTarget {
    pub media_id: String,
    pub root_id: String,
    pub canonical_root: String,
    pub absolute_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredStream {
    pub index: u32,
    pub kind: String,
    pub codec: Option<String>,
    pub language: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bitrate: Option<u64>,
    pub duration_ms: Option<u64>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredProbe {
    pub duration_ms: u64,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub audio_streams: u32,
    pub subtitle_streams: u32,
    pub streams: Vec<StoredStream>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaListItem {
    pub id: String,
    pub root_id: String,
    pub display_name: String,
    pub path_redacted: String,
    pub media_kind: String,
    pub size_bytes: u64,
    pub duration_ms: Option<u64>,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub audio_streams: u32,
    pub subtitle_streams: u32,
    pub probe_status: String,
    pub probe_error: Option<String>,
    pub discovered_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaSummary {
    pub total_items: u64,
    pub ready_items: u64,
    pub attention_items: u64,
    pub known_duration_ms: u64,
    pub duration_known_items: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPage {
    pub items: Vec<MediaListItem>,
    pub next_cursor: Option<String>,
    pub summary: MediaSummary,
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

    pub async fn reconcile_discovery(
        &self,
        root_id: &str,
        discovered: &[DiscoveredMedia],
        reconcile_missing: bool,
    ) -> DbResult<Vec<ProbeCandidate>> {
        let mut transaction = self.pool.begin().await?;
        let now = Utc::now().to_rfc3339();
        let mut candidates = Vec::new();

        for media in discovered {
            let existing = sqlx::query(
                "SELECT id, size_bytes, mtime, probe_status FROM media_files \
                 WHERE root_id = ? AND path = ?",
            )
            .bind(root_id)
            .bind(&media.path)
            .fetch_optional(&mut *transaction)
            .await?;

            match existing {
                Some(row) => {
                    let media_id: String = row.try_get("id")?;
                    let old_size: i64 = row.try_get("size_bytes")?;
                    let old_mtime: String = row.try_get("mtime")?;
                    let status: String = row.try_get("probe_status")?;
                    let changed = old_size != media.size_bytes || old_mtime != media.mtime;

                    if changed {
                        sqlx::query(
                            "UPDATE media_files SET display_name = ?, media_kind = ?, \
                             size_bytes = ?, mtime = ?, discovered_at = ?, \
                             duration_ms = NULL, container = NULL, video_codec = NULL, \
                             audio_codec = NULL, width = NULL, height = NULL, \
                             audio_streams = 0, subtitle_streams = 0, \
                             probe_status = 'queued', probe_error = NULL, \
                             probe_version = NULL, probed_at = NULL WHERE id = ?",
                        )
                        .bind(&media.display_name)
                        .bind(&media.media_kind)
                        .bind(media.size_bytes)
                        .bind(&media.mtime)
                        .bind(&now)
                        .bind(&media_id)
                        .execute(&mut *transaction)
                        .await?;
                        sqlx::query("DELETE FROM media_streams WHERE media_id = ?")
                            .bind(&media_id)
                            .execute(&mut *transaction)
                            .await?;
                        sqlx::query("DELETE FROM chunks WHERE media_id = ?")
                            .bind(&media_id)
                            .execute(&mut *transaction)
                            .await?;
                    } else {
                        sqlx::query(
                            "UPDATE media_files SET display_name = ?, media_kind = ?, \
                             discovered_at = ? WHERE id = ?",
                        )
                        .bind(&media.display_name)
                        .bind(&media.media_kind)
                        .bind(&now)
                        .bind(&media_id)
                        .execute(&mut *transaction)
                        .await?;
                    }

                    if changed
                        || matches!(
                            status.as_str(),
                            "queued" | "failed" | "unavailable" | "missing"
                        )
                    {
                        candidates.push(ProbeCandidate {
                            media_id,
                            root_id: root_id.to_string(),
                        });
                    }
                }
                None => {
                    let media_id = Uuid::new_v4().to_string();
                    sqlx::query(
                        "INSERT INTO media_files \
                         (id, root_id, folder_id, path, size_bytes, mtime, discovered_at, \
                          display_name, media_kind, probe_status) \
                         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'queued')",
                    )
                    .bind(&media_id)
                    .bind(root_id)
                    .bind(&media.path)
                    .bind(media.size_bytes)
                    .bind(&media.mtime)
                    .bind(&now)
                    .bind(&media.display_name)
                    .bind(&media.media_kind)
                    .execute(&mut *transaction)
                    .await?;
                    candidates.push(ProbeCandidate {
                        media_id,
                        root_id: root_id.to_string(),
                    });
                }
            }
        }

        if reconcile_missing {
            sqlx::query(
                "UPDATE media_files SET probe_status = 'missing', \
                 probe_error = 'File not found during the latest scan.' \
                 WHERE root_id = ? AND discovered_at <> ?",
            )
            .bind(root_id)
            .bind(&now)
            .execute(&mut *transaction)
            .await?;
        }

        transaction.commit().await?;
        Ok(candidates)
    }

    pub async fn resolve_probe_target(&self, media_id: &str) -> DbResult<Option<ProbeTarget>> {
        let row = sqlx::query(
            "SELECT m.id, m.root_id, m.path, r.canonical_path \
             FROM media_files m JOIN library_roots r ON r.id = m.root_id \
             WHERE m.id = ? AND r.revoked_at IS NULL",
        )
        .bind(media_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| -> DbResult<ProbeTarget> {
            Ok(ProbeTarget {
                media_id: row.try_get("id")?,
                root_id: row.try_get("root_id")?,
                absolute_path: row.try_get("path")?,
                canonical_root: row.try_get("canonical_path")?,
            })
        })
        .transpose()
    }

    pub async fn list_unavailable_probe_candidates(
        &self,
        limit: u32,
    ) -> DbResult<Vec<ProbeCandidate>> {
        let rows = sqlx::query(
            "SELECT m.id AS media_id, m.root_id \
             FROM media_files m \
             JOIN library_roots r ON r.id = m.root_id \
             WHERE r.revoked_at IS NULL AND m.probe_status = 'unavailable' \
             ORDER BY m.discovered_at ASC, m.id ASC LIMIT ?",
        )
        .bind(i64::from(limit.clamp(1, 50_000)))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(ProbeCandidate {
                    media_id: row.try_get("media_id")?,
                    root_id: row.try_get("root_id")?,
                })
            })
            .collect()
    }

    pub async fn mark_probing(&self, media_id: &str) -> DbResult<()> {
        let result = sqlx::query(
            "UPDATE media_files SET probe_status = 'probing', probe_error = NULL WHERE id = ?",
        )
        .bind(media_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(DbError::Pool("media row not found".into()));
        }
        Ok(())
    }

    pub async fn mark_probe_queued(&self, media_id: &str) -> DbResult<()> {
        let result = sqlx::query(
            "UPDATE media_files SET probe_status = 'queued', probe_error = NULL WHERE id = ?",
        )
        .bind(media_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(DbError::Pool("media row not found".into()));
        }
        Ok(())
    }

    pub async fn save_probe_success(
        &self,
        media_id: &str,
        version: &str,
        probe: &StoredProbe,
    ) -> DbResult<()> {
        let mut transaction = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE media_files SET duration_ms = ?, container = ?, video_codec = ?, \
             audio_codec = ?, width = ?, height = ?, audio_streams = ?, \
             subtitle_streams = ?, probe_status = 'ready', probe_error = NULL, \
             probe_version = ?, probed_at = ? WHERE id = ?",
        )
        .bind(to_i64(probe.duration_ms))
        .bind(&probe.container)
        .bind(&probe.video_codec)
        .bind(&probe.audio_codec)
        .bind(probe.width.map(i64::from))
        .bind(probe.height.map(i64::from))
        .bind(i64::from(probe.audio_streams))
        .bind(i64::from(probe.subtitle_streams))
        .bind(version)
        .bind(Utc::now().to_rfc3339())
        .bind(media_id)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 0 {
            return Err(DbError::Pool("media row not found".into()));
        }

        sqlx::query("DELETE FROM media_streams WHERE media_id = ?")
            .bind(media_id)
            .execute(&mut *transaction)
            .await?;
        for stream in &probe.streams {
            sqlx::query(
                "INSERT INTO media_streams \
                 (media_id, idx, kind, codec, language, width, height, bitrate, \
                  duration_ms, channels, sample_rate, is_default) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(media_id)
            .bind(i64::from(stream.index))
            .bind(&stream.kind)
            .bind(&stream.codec)
            .bind(&stream.language)
            .bind(stream.width.map(i64::from))
            .bind(stream.height.map(i64::from))
            .bind(stream.bitrate.map(to_i64))
            .bind(stream.duration_ms.map(to_i64))
            .bind(stream.channels.map(i64::from))
            .bind(stream.sample_rate.map(i64::from))
            .bind(if stream.is_default { 1_i64 } else { 0_i64 })
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query("DELETE FROM chunks WHERE media_id = ? AND source = 'coarse'")
            .bind(media_id)
            .execute(&mut *transaction)
            .await?;
        let created_at = Utc::now().to_rfc3339();
        for chunk in derive_coarse_chunks(media_id, probe.duration_ms) {
            sqlx::query(
                "INSERT INTO chunks \
                 (id, media_id, ordinal, start_ms, end_ms, source, analyzer_version, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&chunk.id)
            .bind(&chunk.media_id)
            .bind(i64::from(chunk.ordinal))
            .bind(to_i64(chunk.start_ms))
            .bind(to_i64(chunk.end_ms))
            .bind(&chunk.source)
            .bind(&chunk.analyzer_version)
            .bind(&created_at)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn save_probe_failure(
        &self,
        media_id: &str,
        status: &str,
        safe_message: &str,
        version: &str,
    ) -> DbResult<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "UPDATE media_files SET probe_status = ?, probe_error = ?, probe_version = ?, \
             probed_at = ? WHERE id = ?",
        )
        .bind(status)
        .bind(safe_message)
        .bind(version)
        .bind(Utc::now().to_rfc3339())
        .bind(media_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("DELETE FROM chunks WHERE media_id = ?")
            .bind(media_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn list_page(
        &self,
        root_id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> DbResult<MediaPage> {
        let page_size = limit.clamp(1, 200);
        let summary_row = sqlx::query(
            "SELECT COUNT(*) AS total_items, \
                    COALESCE(SUM(CASE WHEN m.probe_status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_items, \
                    COALESCE(SUM(CASE WHEN m.probe_status IN ('failed', 'unavailable', 'missing') THEN 1 ELSE 0 END), 0) AS attention_items, \
                    COALESCE(SUM(m.duration_ms), 0) AS known_duration_ms, \
                    COUNT(m.duration_ms) AS duration_known_items \
             FROM media_files m \
             JOIN library_roots r ON r.id = m.root_id \
             WHERE r.revoked_at IS NULL AND (? IS NULL OR m.root_id = ?)",
        )
        .bind(root_id)
        .bind(root_id)
        .fetch_one(&self.pool)
        .await?;
        let summary = MediaSummary {
            total_items: nonnegative_u64(summary_row.try_get("total_items")?),
            ready_items: nonnegative_u64(summary_row.try_get("ready_items")?),
            attention_items: nonnegative_u64(summary_row.try_get("attention_items")?),
            known_duration_ms: nonnegative_u64(summary_row.try_get("known_duration_ms")?),
            duration_known_items: nonnegative_u64(summary_row.try_get("duration_known_items")?),
        };
        let rows = sqlx::query(
            "SELECT m.id, m.root_id, m.display_name, m.media_kind, m.size_bytes, m.duration_ms, \
                    m.container, m.video_codec, m.audio_codec, m.width, m.height, m.audio_streams, \
                    m.subtitle_streams, m.probe_status, m.probe_error, m.discovered_at \
             FROM media_files m \
             JOIN library_roots r ON r.id = m.root_id \
             WHERE r.revoked_at IS NULL \
               AND (? IS NULL OR m.root_id = ?) \
               AND (? IS NULL OR m.discovered_at < (SELECT discovered_at FROM media_files WHERE id = ?) \
                    OR (m.discovered_at = (SELECT discovered_at FROM media_files WHERE id = ?) AND m.id < ?)) \
             ORDER BY m.discovered_at DESC, m.id DESC LIMIT ?",
        )
        .bind(root_id)
        .bind(root_id)
        .bind(cursor)
        .bind(cursor)
        .bind(cursor)
        .bind(cursor)
        .bind(i64::from(page_size + 1))
        .fetch_all(&self.pool)
        .await?;

        let mut items = rows
            .into_iter()
            .map(row_to_list_item)
            .collect::<DbResult<Vec<_>>>()?;
        let next_cursor = if items.len() > page_size as usize {
            items.truncate(page_size as usize);
            items.last().map(|item| item.id.clone())
        } else {
            None
        };
        Ok(MediaPage {
            items,
            next_cursor,
            summary,
        })
    }
}

fn row_to_list_item(row: sqlx::sqlite::SqliteRow) -> DbResult<MediaListItem> {
    let display_name: String = row.try_get("display_name")?;
    Ok(MediaListItem {
        id: row.try_get("id")?,
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
    })
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
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
    use crate::{ChunksRepo, Db, LibraryRootsRepo};

    async fn fixture() -> (Db, Repo, String) {
        let db = Db::open_in_memory().await.expect("db");
        let roots = LibraryRootsRepo::new(db.pool().clone());
        let root = match roots
            .insert_root("/safe/library", Some("Library"))
            .await
            .expect("root")
        {
            crate::InsertOutcome::Inserted(root) => root,
            crate::InsertOutcome::AlreadyPresent(_) => panic!("new root"),
        };
        (db.clone(), Repo::new(db.pool().clone()), root.id)
    }

    fn discovered(name: &str) -> DiscoveredMedia {
        DiscoveredMedia {
            path: format!("/safe/library/{name}"),
            display_name: name.to_string(),
            media_kind: "video".into(),
            size_bytes: 42,
            mtime: "2026-08-08T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn discovery_is_stable_and_changed_files_requeue() {
        let (db, repo, root_id) = fixture().await;
        let first = repo
            .reconcile_discovery(&root_id, &[discovered("lesson.mp4")], true)
            .await
            .expect("first");
        assert_eq!(first.len(), 1);
        let second = repo
            .reconcile_discovery(&root_id, &[discovered("lesson.mp4")], true)
            .await
            .expect("second");
        assert_eq!(second.len(), 1, "queued files remain probe candidates");

        repo.save_probe_failure(&first[0].media_id, "failed", "Unreadable media.", "8.1.2")
            .await
            .expect("failure");
        let unchanged = repo
            .reconcile_discovery(&root_id, &[discovered("lesson.mp4")], true)
            .await
            .expect("unchanged");
        assert_eq!(
            unchanged.len(),
            1,
            "an explicit rescan retries metadata failures"
        );

        let mut changed = discovered("lesson.mp4");
        changed.size_bytes = 43;
        assert_eq!(
            repo.reconcile_discovery(&root_id, &[changed], true)
                .await
                .expect("changed")
                .len(),
            1
        );
        db.close().await;
    }

    #[tokio::test]
    async fn probe_metadata_is_transactional_and_renderer_safe() {
        let (db, repo, root_id) = fixture().await;
        let candidate = repo
            .reconcile_discovery(&root_id, &[discovered("lesson.mp4")], true)
            .await
            .expect("discover")
            .remove(0);
        repo.save_probe_success(
            &candidate.media_id,
            "8.1.2",
            &StoredProbe {
                duration_ms: 90_500,
                container: Some("matroska".into()),
                video_codec: Some("h264".into()),
                audio_codec: Some("aac".into()),
                width: Some(1920),
                height: Some(1080),
                audio_streams: 1,
                subtitle_streams: 1,
                streams: vec![StoredStream {
                    index: 0,
                    kind: "video".into(),
                    codec: Some("h264".into()),
                    language: None,
                    width: Some(1920),
                    height: Some(1080),
                    bitrate: Some(1_000_000),
                    duration_ms: Some(90_500),
                    channels: None,
                    sample_rate: None,
                    is_default: true,
                }],
            },
        )
        .await
        .expect("save probe");

        let page = repo.list_page(None, None, 20).await.expect("page");
        assert_eq!(page.items[0].duration_ms, Some(90_500));
        assert_eq!(page.items[0].probe_status, "ready");
        assert_eq!(page.items[0].path_redacted, "[REDACTED]/lesson.mp4");
        assert!(!format!("{:?}", page.items[0]).contains("/safe/library/"));
        let chunks = ChunksRepo::new(repo.pool().clone())
            .list_for_media(&candidate.media_id)
            .await
            .expect("chunks");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].start_ms, 0);
        assert_eq!(chunks[0].end_ms, 90_500);
        db.close().await;
    }

    #[tokio::test]
    async fn requeued_probe_is_visible_to_renderer_polling() {
        let (db, repo, root_id) = fixture().await;
        let candidate = repo
            .reconcile_discovery(&root_id, &[discovered("lesson.mp4")], true)
            .await
            .expect("discover")
            .remove(0);
        repo.save_probe_failure(
            &candidate.media_id,
            "unavailable",
            "Media inspection is unavailable.",
            "8.1.2",
        )
        .await
        .expect("failure");

        repo.mark_probe_queued(&candidate.media_id)
            .await
            .expect("requeue");
        let item = repo
            .list_page(Some(&root_id), None, 10)
            .await
            .expect("page")
            .items
            .remove(0);
        assert_eq!(item.probe_status, "queued");
        assert_eq!(item.probe_error, None);
        db.close().await;
    }

    #[tokio::test]
    async fn page_summary_is_exact_for_the_root_beyond_the_loaded_page() {
        let (db, repo, root_id) = fixture().await;
        repo.reconcile_discovery(
            &root_id,
            &[discovered("ready.mp4"), discovered("failed.mp4")],
            true,
        )
        .await
        .expect("discover");
        sqlx::query(
            "UPDATE media_files SET probe_status = 'ready', duration_ms = 120000 \
             WHERE root_id = ? AND display_name = 'ready.mp4'",
        )
        .bind(&root_id)
        .execute(repo.pool())
        .await
        .expect("ready metadata");
        sqlx::query(
            "UPDATE media_files SET probe_status = 'failed' \
             WHERE root_id = ? AND display_name = 'failed.mp4'",
        )
        .bind(&root_id)
        .execute(repo.pool())
        .await
        .expect("failed metadata");
        let other_root = match LibraryRootsRepo::new(db.pool().clone())
            .insert_root("/safe/other", Some("Other"))
            .await
            .expect("other root")
        {
            crate::InsertOutcome::Inserted(root) => root,
            crate::InsertOutcome::AlreadyPresent(_) => panic!("new other root"),
        };
        repo.reconcile_discovery(&other_root.id, &[discovered("other.mp4")], true)
            .await
            .expect("other media");

        let page = repo
            .list_page(Some(&root_id), None, 1)
            .await
            .expect("first page");
        assert_eq!(page.items.len(), 1);
        assert!(page.next_cursor.is_some());
        assert_eq!(page.summary.total_items, 2);
        assert_eq!(page.summary.ready_items, 1);
        assert_eq!(page.summary.attention_items, 1);
        assert_eq!(page.summary.known_duration_ms, 120_000);
        assert_eq!(page.summary.duration_known_items, 1);
        db.close().await;
    }

    #[tokio::test]
    async fn failed_reprobe_removes_stale_derived_chunks() {
        let (db, repo, root_id) = fixture().await;
        let candidate = repo
            .reconcile_discovery(&root_id, &[discovered("lesson.mp4")], true)
            .await
            .expect("discover")
            .remove(0);
        repo.save_probe_success(
            &candidate.media_id,
            "8.1.2",
            &StoredProbe {
                duration_ms: 61 * 60_000,
                container: None,
                video_codec: None,
                audio_codec: None,
                width: None,
                height: None,
                audio_streams: 0,
                subtitle_streams: 0,
                streams: Vec::new(),
            },
        )
        .await
        .expect("metadata");
        let chunks = ChunksRepo::new(repo.pool().clone());
        assert_eq!(
            chunks
                .list_for_media(&candidate.media_id)
                .await
                .unwrap()
                .len(),
            3
        );

        repo.save_probe_failure(&candidate.media_id, "failed", "Unreadable media.", "8.1.2")
            .await
            .expect("failure");
        assert!(chunks
            .list_for_media(&candidate.media_id)
            .await
            .unwrap()
            .is_empty());
        db.close().await;
    }

    #[tokio::test]
    async fn complete_reconciliation_marks_missing_files_without_deleting_history() {
        let (db, repo, root_id) = fixture().await;
        repo.reconcile_discovery(&root_id, &[discovered("gone.mp4")], true)
            .await
            .expect("discover");
        repo.reconcile_discovery(&root_id, &[], true)
            .await
            .expect("reconcile");

        let page = repo.list_page(None, None, 20).await.expect("page");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].probe_status, "missing");
        db.close().await;
    }

    #[tokio::test]
    async fn revoked_roots_are_removed_from_the_active_media_library() {
        let (db, repo, root_id) = fixture().await;
        repo.reconcile_discovery(&root_id, &[discovered("lesson.mp4")], true)
            .await
            .expect("discover");

        LibraryRootsRepo::new(db.pool().clone())
            .revoke_root(&root_id)
            .await
            .expect("revoke root");

        let page = repo.list_page(None, None, 20).await.expect("page");
        assert!(page.items.is_empty());
        db.close().await;
    }

    #[tokio::test]
    async fn unavailable_metadata_is_recoverable_only_for_active_roots() {
        let (db, repo, root_id) = fixture().await;
        let candidate = repo
            .reconcile_discovery(&root_id, &[discovered("lesson.mp4")], true)
            .await
            .expect("discover")
            .remove(0);
        repo.save_probe_failure(
            &candidate.media_id,
            "unavailable",
            "Media inspection is unavailable.",
            "8.1.2",
        )
        .await
        .expect("mark unavailable");

        assert_eq!(
            repo.list_unavailable_probe_candidates(20)
                .await
                .unwrap()
                .len(),
            1
        );

        LibraryRootsRepo::new(db.pool().clone())
            .revoke_root(&root_id)
            .await
            .expect("revoke root");
        assert!(repo
            .list_unavailable_probe_candidates(20)
            .await
            .unwrap()
            .is_empty());
        db.close().await;
    }
}
