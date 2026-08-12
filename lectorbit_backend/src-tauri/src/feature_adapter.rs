//! Adapter wiring the plugin's `FeatureOps` trait to the host app's pool.
//!
//! The plugin stays free of `lectorbit_services` (and its heavy SQLx dep) by
//! only knowing about the small `FeatureOps` trait + DTOs. This file is the
//! glue that implements that trait using the actual services the host app
//! already bootstraps in `lib.rs::run`.
//!
//! SQL schema references are pegged to migration 0001 + 0002 (see
//! `lectorbit_backend/migrations/`). Path redacting is a presentation concern
//! — we apply it in the adapter so the plugin never sees raw paths.

use std::pin::Box;
use std::sync::Arc;

use lectorbit_services::{
    AiModel, ConsentEntry, MediaFile, PlanItem, PlanItemStatus, SearchHit, SearchSource,
    StudyAction, StudyActionKind, StudyConstraints,
};
use sqlx::{Row, SqlitePool};
use tauri_plugin_lectorbit::features::{
    AiModelDto, ConsentEntryDto, FeatureError, FeatureOps, MediaFileDto, PlanCommitDto,
    PlanItemDto, ScanStartDto, SearchHitDto, StudyActionDto, StudyConstraintsDto,
};

#[derive(Clone)]
pub struct FeatureAdapter {
    pub library: Arc<lectorbit_services::LibraryService>,
    pub pool: SqlitePool,
}

impl FeatureAdapter {
    pub fn new(library: Arc<lectorbit_services::LibraryService>, pool: SqlitePool) -> Self {
        Self { library, pool }
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn map_sqlx_error(e: sqlx::Error) -> FeatureError {
    FeatureError::new("database", e.to_string())
}

fn map_service_error(e: impl std::fmt::Display) -> FeatureError {
    FeatureError::new("internal", e.to_string())
}

fn map_chunk_index_to_str(s: PlanItemStatus) -> &'static str {
    s.as_str()
}

/// Strip everything except the file basename + a 1-char prefix so the
/// renderer can show something descriptive without leaking directory layout.
/// Matches the behavior of `lectorbit_db::redaction::redact_path`.
fn redact_path(raw: &str) -> String {
    let trimmed = raw.trim_end_matches(['/', '\\']);
    let basename = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    if basename.is_empty() {
        return "[REDACTED]".into();
    }
    let prefix = if basename.len() >= 1 {
        basename.chars().next().unwrap_or('?')
    } else {
        '?'
    };
    format!("[REDACTED]/{prefix}/•••/{basename}")
}

fn plan_status_from_str(s: &str) -> PlanItemStatus {
    match s {
        "in_progress" => PlanItemStatus::InProgress,
        "done" => PlanItemStatus::Done,
        "skipped" => PlanItemStatus::Skipped,
        "postponed" => PlanItemStatus::Postponed,
        _ => PlanItemStatus::Pending,
    }
}

// ============================================================================
// FeatureOps
// ============================================================================

impl FeatureOps for FeatureAdapter {
    fn enqueue_scan(
        &self,
        root_id: String,
    ) -> Box<dyn std::future::Future<Output = Result<ScanStartDto, FeatureError>> + Send + '_> {
        let svc = self.library.clone();
        Box::pin(async move {
            let started = svc
                .enqueue_scan(&root_id)
                .await
                .map_err(map_service_error)?;
            Ok(ScanStartDto {
                root_id,
                job_id: started.job_id,
            })
        })
    }

    fn list_media(
        &self,
        root_id: Option<String>,
        limit: u32,
    ) -> Box<dyn std::future::Future<Output = Result<Vec<MediaFileDto>, FeatureError>> + Send + '_>
    {
        let pool = self.pool.clone();
        Box::pin(async move {
            let rows = match root_id {
                Some(rid) => sqlx::query(
                    "SELECT id, root_id, path, size_bytes, mtime, \
                                chunk_count, duration_ms \
                           FROM media_files \
                          WHERE root_id = ? \
                          ORDER BY path LIMIT ?",
                )
                .bind(&rid)
                .bind(limit as i64)
                .fetch_all(&pool)
                .await
                .map_err(map_sqlx_error)?,
                None => sqlx::query(
                    "SELECT id, root_id, path, size_bytes, mtime, \
                                chunk_count, duration_ms \
                           FROM media_files \
                          ORDER BY path LIMIT ?",
                )
                .bind(limit as i64)
                .fetch_all(&pool)
                .await
                .map_err(map_sqlx_error)?,
            };
            let mut out = Vec::with_capacity(rows.len());
            for r in rows {
                let raw_path: String = r.try_get("path").map_err(map_sqlx_error)?;
                out.push(MediaFileDto::from(&MediaFile {
                    id: r.try_get("id").map_err(map_sqlx_error)?,
                    root_id: r.try_get("root_id").map_err(map_sqlx_error)?,
                    path_redacted: redact_path(&raw_path),
                    size_bytes: r.try_get::<i64, _>("size_bytes").map_err(map_sqlx_error)? as u64,
                    mtime: r.try_get("mtime").map_err(map_sqlx_error)?,
                    chunk_count: r.try_get::<i64, _>("chunk_count").map_err(map_sqlx_error)? as u32,
                    duration_ms: r.try_get::<i64, _>("duration_ms").map_err(map_sqlx_error)? as u64,
                }));
            }
            Ok(out)
        })
    }

    fn plan_preview(
        &self,
        constraints: StudyConstraintsDto,
        horizon_days: u32,
    ) -> Box<dyn std::future::Future<Output = Result<PlanCommitDto, FeatureError>> + Send + '_>
    {
        let pool = self.pool.clone();
        let c: StudyConstraints = constraints.into();
        Box::pin(async move {
            c.validate()
                .map_err(|e| FeatureError::new("invalid_constraints", e))?;

            // 1. Read chunks for the active library and group by media_id.
            let chunk_rows = sqlx::query(
                "SELECT id, media_id, idx, start_ms, end_ms \
                   FROM chunks \
                  ORDER BY media_id, idx",
            )
            .fetch_all(&pool)
            .await
            .map_err(map_sqlx_error)?;
            let mut grouped: std::collections::BTreeMap<String, Vec<lectorbit_services::ChunkRef>> =
                std::collections::BTreeMap::new();
            for r in chunk_rows {
                let media_id: String = r.try_get("media_id").map_err(map_sqlx_error)?;
                grouped
                    .entry(media_id)
                    .or_default()
                    .push(lectorbit_services::ChunkRef {
                        id: r.try_get("id").map_err(map_sqlx_error)?,
                        start_ms: r.try_get::<i64, _>("start_ms").map_err(map_sqlx_error)? as u64,
                        end_ms: r.try_get::<i64, _>("end_ms").map_err(map_sqlx_error)? as u64,
                    });
            }
            let chunks_by_media: Vec<lectorbit_services::MediaChunkSet> = grouped
                .into_iter()
                .map(|(media_id, chunks)| lectorbit_services::MediaChunkSet { media_id, chunks })
                .collect();

            // 2. Run the deterministic planner. `today` is computed in UTC; the
            //    renderer should adjust to local timezone when displaying.
            let horizon_start = chrono::Utc::now().date_naive();
            let inputs = lectorbit_services::PlannerInputs {
                constraints: &c,
                chunks_by_media: &chunks_by_media,
                horizon_start,
                horizon_days,
            };
            let plan = lectorbit_services::plan(inputs).map_err(map_service_error)?;

            // 3. Persist: freeze a new constraints version, then the plan
            //    version, then the plan_days + plan_items rows.
            let constraints_id = uuid::Uuid::new_v4().to_string();
            let plan_version_id = plan.plan_version_id.clone();
            let plan_id = uuid::Uuid::new_v4().to_string(); // wraps via `plans`
            let mut tx = pool.begin().await.map_err(map_sqlx_error)?;

            // 3a. Freeze the constraints as a new version row.
            let payload = serde_json::to_string(&c)
                .map_err(|e| FeatureError::new("serialize", e.to_string()))?;
            sqlx::query(
                "INSERT INTO study_constraints_versions (id, user_id, payload, created_at, frozen) \
                 VALUES (?, ?, ?, ?, 1)",
            )
            .bind(&constraints_id)
            .bind(&c.user_id)
            .bind(&payload)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&mut *tx)
            .await
            .map_err(map_sqlx_error)?;
            sqlx::query(
                "INSERT INTO study_constraints_active (user_id, version_id, updated_at) \
                 VALUES (?, ?, ?) \
                 ON CONFLICT(user_id) DO UPDATE SET \
                    version_id = excluded.version_id, updated_at = excluded.updated_at",
            )
            .bind(&c.user_id)
            .bind(&constraints_id)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&mut *tx)
            .await
            .map_err(map_sqlx_error)?;

            // 3b. Insert a `plans` row (F1) so the existing FK from plan_days
            //     keeps working.
            sqlx::query("INSERT INTO plans (id, user_id, title, created_at) VALUES (?, ?, ?, ?)")
                .bind(&plan_id)
                .bind(&c.user_id)
                .bind(format!("Plan v{}", &plan_version_id[..8]))
                .bind(chrono::Utc::now().to_rfc3339())
                .execute(&mut *tx)
                .await
                .map_err(map_sqlx_error)?;

            // 3c. Insert one plan_days row per unique scheduled_for.
            let mut day_ids: Vec<(String, String)> = Vec::new();
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for item in &plan.items {
                if seen.insert(item.scheduled_for.clone()) {
                    let day_id = uuid::Uuid::new_v4().to_string();
                    sqlx::query("INSERT INTO plan_days (id, plan_id, date) VALUES (?, ?, ?)")
                        .bind(&day_id)
                        .bind(&plan_id)
                        .bind(&item.scheduled_for)
                        .execute(&mut *tx)
                        .await
                        .map_err(map_sqlx_error)?;
                    day_ids.push((item.scheduled_for.clone(), day_id));
                }
            }

            // 3d. Insert plan_items with `plan_version_id` populated (F4 col).
            let day_id_lookup = |scheduled_for: &str| -> String {
                day_ids
                    .iter()
                    .find(|(d, _)| d == scheduled_for)
                    .map(|(_, id)| id.clone())
                    .unwrap_or_default()
            };
            for item in &plan.items {
                let day_id = day_id_lookup(&item.scheduled_for);
                sqlx::query(
                    "INSERT INTO plan_items \
                        (id, plan_day_id, media_id, chunk_index, start_ms, end_ms, status, plan_version_id) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&item.id)
                .bind(&day_id)
                .bind(&item.media_id)
                .bind(item.seq as i64) // planner does not emit chunk_index; use seq
                .bind(item.start_ms as i64)
                .bind(item.end_ms as i64)
                .bind(map_chunk_index_to_str(item.status))
                .bind(&plan_version_id)
                .execute(&mut *tx)
                .await
                .map_err(map_sqlx_error)?;
            }

            // 3e. Persist the plan_version row (history).
            let summary = serde_json::json!({
                "items": plan.items.len(),
                "horizon_start": plan.horizon_start,
                "horizon_end": plan.horizon_end,
            })
            .to_string();
            sqlx::query(
                "INSERT INTO plan_versions (id, user_id, constraints_id, horizon_start, horizon_end, payload, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&plan_version_id)
            .bind(&c.user_id)
            .bind(&constraints_id)
            .bind(&plan.horizon_start)
            .bind(&plan.horizon_end)
            .bind(&summary)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&mut *tx)
            .await
            .map_err(map_sqlx_error)?;

            tx.commit().await.map_err(map_sqlx_error)?;

            Ok(PlanCommitDto {
                plan_version_id,
                horizon_start: plan.horizon_start,
                horizon_end: plan.horizon_end,
                items: plan.items.iter().map(PlanItemDto::from).collect(),
            })
        })
    }

    fn plan_today(
        &self,
        limit: u32,
    ) -> Box<dyn std::future::Future<Output = Result<Vec<PlanItemDto>, FeatureError>> + Send + '_>
    {
        let pool = self.pool.clone();
        Box::pin(async move {
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let rows = sqlx::query(
                "SELECT pi.id, pi.plan_version_id, pi.media_id, pi.chunk_index, \
                        pi.start_ms, pi.end_ms, pi.status, pd.date AS scheduled_for \
                   FROM plan_items pi \
                   JOIN plan_days pd ON pd.id = pi.plan_day_id \
                  WHERE pd.date = ? AND pi.status IN ('pending','in_progress') \
                  ORDER BY pi.plan_version_id, pi.chunk_index LIMIT ?",
            )
            .bind(&today)
            .bind(limit as i64)
            .fetch_all(&pool)
            .await
            .map_err(map_sqlx_error)?;
            let mut out = Vec::with_capacity(rows.len());
            for r in rows {
                let status_str: String = r.try_get("status").map_err(map_sqlx_error)?;
                let plan_version_id: Option<String> =
                    r.try_get("plan_version_id").map_err(map_sqlx_error)?;
                out.push(PlanItemDto {
                    id: r.try_get("id").map_err(map_sqlx_error)?,
                    plan_version_id: plan_version_id.unwrap_or_default(),
                    media_id: r.try_get("media_id").map_err(map_sqlx_error)?,
                    chunk_id: r
                        .try_get::<i64, _>("chunk_index")
                        .map_err(map_sqlx_error)?
                        .to_string(),
                    scheduled_for: r.try_get("scheduled_for").map_err(map_sqlx_error)?,
                    start_ms: r.try_get::<i64, _>("start_ms").map_err(map_sqlx_error)? as u64,
                    end_ms: r.try_get::<i64, _>("end_ms").map_err(map_sqlx_error)? as u64,
                    status: status_str,
                    seq: r.try_get::<i64, _>("chunk_index").map_err(map_sqlx_error)? as u32,
                });
            }
            Ok(out)
        })
    }

    fn record_study_action(
        &self,
        action: StudyActionDto,
    ) -> Box<dyn std::future::Future<Output = Result<(), FeatureError>> + Send + '_> {
        let pool = self.pool.clone();
        let kind = StudyActionKind::from_str(&action.kind);
        Box::pin(async move {
            let entry = StudyAction {
                id: uuid::Uuid::new_v4().to_string(),
                user_id: "local".to_string(),
                plan_item_id: action.plan_item_id,
                media_id: action.media_id,
                kind,
                payload: None,
                created_at: chrono::Utc::now(),
            };
            sqlx::query(
                "INSERT INTO study_actions \
                    (id, user_id, plan_item_id, media_id, kind, payload, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&entry.id)
            .bind(&entry.user_id)
            .bind(&entry.plan_item_id)
            .bind(&entry.media_id)
            .bind(entry.kind.as_str())
            .bind(&entry.payload)
            .bind(entry.created_at.to_rfc3339())
            .execute(&pool)
            .await
            .map_err(map_sqlx_error)?;
            Ok(())
        })
    }

    fn search(
        &self,
        query: String,
        limit: u32,
    ) -> Box<dyn std::future::Future<Output = Result<Vec<SearchHitDto>, FeatureError>> + Send + '_>
    {
        let pool = self.pool.clone();
        Box::pin(async move {
            let fts = lectorbit_services::build_fts_query(&query);
            if fts.is_empty() {
                return Ok(Vec::new());
            }
            // FTS5 ranked query against media_fts; resolve the path on demand
            // so we can redact it for the renderer.
            let rows = sqlx::query(
                "SELECT m.id AS media_id, m.path, m.display_name, \
                        snippet(media_fts, 2, '<b>', '</b>', '…', 12) AS snip, \
                        media_fts.rank AS rank, m.path_tokens \
                   FROM media_fts \
                   JOIN media_files m ON m.id = media_fts.media_id \
                  WHERE media_fts MATCH ? \
                  ORDER BY media_fts.rank LIMIT ?",
            )
            .bind(&fts)
            .bind(limit as i64)
            .fetch_all(&pool)
            .await
            .map_err(map_sqlx_error)?;
            let mut hits: Vec<SearchHit> = Vec::with_capacity(rows.len());
            for r in rows {
                let rank: f64 = r.try_get("rank").map_err(map_sqlx_error)?;
                let raw_path: String = r.try_get("path").map_err(map_sqlx_error)?;
                let snippet: String = r.try_get("snip").map_err(map_sqlx_error)?;
                hits.push(SearchHit {
                    media_id: r.try_get("media_id").map_err(map_sqlx_error)?,
                    path_redacted: redact_path(&raw_path),
                    snippet,
                    score: lectorbit_services::normalize_rank(rank, 10.0),
                    source: SearchSource::Media,
                });
            }
            Ok(hits.iter().map(SearchHitDto::from).collect())
        })
    }

    fn list_models(
        &self,
    ) -> Box<dyn std::future::Future<Output = Result<Vec<AiModelDto>, FeatureError>> + Send + '_>
    {
        let pool = self.pool.clone();
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT id, family, name, size_bytes, sha256, path, status, created_at \
                   FROM ai_models \
                  ORDER BY family, name",
            )
            .fetch_all(&pool)
            .await
            .map_err(map_sqlx_error)?;
            let mut out = Vec::with_capacity(rows.len());
            for r in rows {
                out.push(AiModelDto::from(&AiModel {
                    id: r.try_get("id").map_err(map_sqlx_error)?,
                    family: r.try_get("family").map_err(map_sqlx_error)?,
                    name: r.try_get("name").map_err(map_sqlx_error)?,
                    size_bytes: r.try_get::<i64, _>("size_bytes").map_err(map_sqlx_error)? as u64,
                    sha256: r.try_get("sha256").map_err(map_sqlx_error)?,
                    path: redact_path(&r.try_get::<String, _>("path").map_err(map_sqlx_error)?),
                    status: r.try_get("status").map_err(map_sqlx_error)?,
                    created_at: r.try_get("created_at").map_err(map_sqlx_error)?,
                }));
            }
            Ok(out)
        })
    }

    fn download_model(
        &self,
        id: String,
    ) -> Box<dyn std::future::Future<Output = Result<(), FeatureError>> + Send + '_> {
        let pool = self.pool.clone();
        Box::pin(async move {
            lectorbit_services::validate_id(&id)
                .map_err(|e| FeatureError::new("invalid_model_id", e.to_string()))?;
            sqlx::query("UPDATE ai_models SET status = 'downloading' WHERE id = ?")
                .bind(&id)
                .execute(&pool)
                .await
                .map_err(map_sqlx_error)?;
            Ok(())
        })
    }

    fn quarantine_model(
        &self,
        id: String,
    ) -> Box<dyn std::future::Future<Output = Result<(), FeatureError>> + Send + '_> {
        let pool = self.pool.clone();
        Box::pin(async move {
            sqlx::query("UPDATE ai_models SET status = 'quarantined' WHERE id = ?")
                .bind(&id)
                .execute(&pool)
                .await
                .map_err(map_sqlx_error)?;
            Ok(())
        })
    }

    fn consent_set(
        &self,
        feature: String,
        granted: bool,
    ) -> Box<dyn std::future::Future<Output = Result<(), FeatureError>> + Send + '_> {
        let pool = self.pool.clone();
        Box::pin(async move {
            let id = uuid::Uuid::new_v4().to_string();
            let payload = serde_json::json!({ "source": "renderer_toggle" }).to_string();
            sqlx::query(
                "INSERT INTO consent_events (id, user_id, scope, granted, payload, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind("local")
            .bind(&feature)
            .bind(granted as i64)
            .bind(&payload)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&pool)
            .await
            .map_err(map_sqlx_error)?;
            Ok(())
        })
    }

    fn consent_get(
        &self,
        feature: String,
    ) -> Box<dyn std::future::Future<Output = Result<bool, FeatureError>> + Send + '_> {
        let pool = self.pool.clone();
        Box::pin(async move {
            let row = sqlx::query(
                "SELECT granted FROM consent_latest WHERE user_id = 'local' AND scope = ?",
            )
            .bind(&feature)
            .fetch_optional(&pool)
            .await
            .map_err(map_sqlx_error)?;
            match row {
                Some(r) => Ok(r.try_get::<i64, _>("granted").map_err(map_sqlx_error)? != 0),
                None => Ok(false),
            }
        })
    }

    fn export_diagnostics_bundle(
        &self,
    ) -> Box<dyn std::future::Future<Output = Result<String, FeatureError>> + Send + '_> {
        let pool = self.pool.clone();
        Box::pin(async move {
            // Load all media rows so the bundle manifest can name them.
            let rows = sqlx::query(
                "SELECT id, root_id, path, size_bytes, mtime, \
                        chunk_count, duration_ms \
                   FROM media_files \
                  ORDER BY path",
            )
            .fetch_all(&pool)
            .await
            .map_err(map_sqlx_error)?;
            let mut media: Vec<MediaFile> = Vec::with_capacity(rows.len());
            for r in rows {
                let raw_path: String = r.try_get("path").map_err(map_sqlx_error)?;
                media.push(MediaFile {
                    id: r.try_get("id").map_err(map_sqlx_error)?,
                    root_id: r.try_get("root_id").map_err(map_sqlx_error)?,
                    path_redacted: redact_path(&raw_path),
                    size_bytes: r.try_get::<i64, _>("size_bytes").map_err(map_sqlx_error)? as u64,
                    mtime: r.try_get("mtime").map_err(map_sqlx_error)?,
                    chunk_count: r.try_get::<i64, _>("chunk_count").map_err(map_sqlx_error)? as u32,
                    duration_ms: r.try_get::<i64, _>("duration_ms").map_err(map_sqlx_error)? as u64,
                });
            }

            // Count audit rows so the manifest can size the bundle.
            let audit_row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events")
                .fetch_one(&pool)
                .await
                .map_err(map_sqlx_error)
                .unwrap_or((0,));

            let dir = std::env::temp_dir().join("lectorbit-diagnostics");
            std::fs::create_dir_all(&dir)
                .map_err(|e| FeatureError::new("bundle_io", e.to_string()))?;
            let path = dir.join(format!(
                "diagnostics-{}.json",
                chrono::Utc::now().format("%Y%m%dT%H%M%S")
            ));
            let entries =
                lectorbit_services::default_bundle_entries(&media, audit_row.0.max(0) as u64);
            let payload = serde_json::to_string_pretty(&entries)
                .map_err(|e| FeatureError::new("bundle_serialize", e.to_string()))?;
            std::fs::write(&path, payload)
                .map_err(|e| FeatureError::new("bundle_io", e.to_string()))?;
            Ok(path.to_string_lossy().to_string())
        })
    }
}

// ============================================================================
// Conversion markers (compile-time gate)
// ============================================================================

#[allow(dead_code)]
fn _assert_conversions_compile() {
    let _: StudyConstraints = StudyConstraintsDto {
        user_id: "local".into(),
        daily_minutes: 30,
        allowed_weekdays: vec![0, 1, 2, 3, 4, 5, 6],
        max_continuous_min: 25,
        catch_up_mode: true,
        playback_speed: 1.0,
    }
    .into();
    let _: PlanItemDto = PlanItemDto::from(&PlanItem {
        id: String::new(),
        plan_version_id: String::new(),
        plan_day_id: None,
        media_id: String::new(),
        chunk_id: String::new(),
        scheduled_for: String::new(),
        start_ms: 0,
        end_ms: 0,
        status: PlanItemStatus::Pending,
        seq: 0,
    });
    let _: AiModelDto = AiModelDto::from(&AiModel {
        id: String::new(),
        family: String::new(),
        name: String::new(),
        size_bytes: 0,
        sha256: String::new(),
        path: String::new(),
        status: "available".into(),
        created_at: String::new(),
    });
    let _: ConsentEntryDto = ConsentEntryDto::from(&ConsentEntry {
        id: String::new(),
        user_id: String::new(),
        feature: String::new(),
        granted: false,
        at: chrono::Utc::now(),
        payload: None,
    });
    let _: SearchHitDto = SearchHitDto::from(&SearchHit {
        media_id: String::new(),
        path_redacted: String::new(),
        snippet: String::new(),
        score: 0,
        source: SearchSource::Media,
    });
    let _: MediaFileDto = MediaFileDto::from(&MediaFile {
        id: String::new(),
        root_id: String::new(),
        path_redacted: String::new(),
        size_bytes: 0,
        mtime: String::new(),
        chunk_count: 0,
        duration_ms: 0,
    });
    let _ = plan_status_from_str("pending");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversion_markers_compile() {
        _assert_conversions_compile();
    }

    #[test]
    fn redact_path_keeps_basename() {
        let r = redact_path("/Users/alice/Videos/lecture.mp4");
        assert!(r.contains("lecture.mp4"));
        assert!(r.contains("[REDACTED]"));
    }

    #[test]
    fn redact_path_handles_bare_filename() {
        let r = redact_path("notes.txt");
        assert!(r.contains("notes.txt"));
    }

    #[test]
    fn redact_path_handles_trailing_slash() {
        let r = redact_path("/var/data/");
        assert!(r.starts_with("[REDACTED]"));
    }

    #[test]
    fn plan_status_round_trip() {
        assert_eq!(plan_status_from_str("pending"), PlanItemStatus::Pending);
        assert_eq!(
            plan_status_from_str("in_progress"),
            PlanItemStatus::InProgress
        );
        assert_eq!(plan_status_from_str("done"), PlanItemStatus::Done);
        assert_eq!(plan_status_from_str("skipped"), PlanItemStatus::Skipped);
        assert_eq!(plan_status_from_str("postponed"), PlanItemStatus::Postponed);
        assert_eq!(plan_status_from_str("garbage"), PlanItemStatus::Pending);
    }
}
