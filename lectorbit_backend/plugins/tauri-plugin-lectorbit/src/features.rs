//! F4–F13 plugin commands.
//!
//! The host application implements [`FeatureOps`] (one trait per area) and
//! registers it as managed state. The plugin's commands are thin adapters:
//! they validate args, call the trait, and serialize the result.
//!
//! Adding a new feature is a 3-step pattern:
//!   1. Add a method on [`FeatureOps`].
//!   2. Add a `#[tauri::command]` adapter here that calls it.
//!   3. Add the command name to `init`'s `invoke_handler` macro in `lib.rs`.
//!
//! The trait surface is intentionally narrow — one method per IPC intent.
//! Business rules stay in `lectorbit_services`.

#![allow(clippy::too_many_arguments)]

use std::pin::Box;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{command, State};

// ============================================================================
// Wire DTOs
// ============================================================================

/// Mirror of `lectorbit_services::StudyConstraints` so the renderer can edit
/// and submit a new version without pulling the typed model into the plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudyConstraintsDto {
    pub user_id: String,
    pub daily_minutes: u32,
    /// 0 = Monday … 6 = Sunday.
    pub allowed_weekdays: Vec<u8>,
    pub max_continuous_min: u32,
    pub catch_up_mode: bool,
    pub playback_speed: f32,
}

impl From<StudyConstraintsDto> for lectorbit_services::StudyConstraints {
    fn from(d: StudyConstraintsDto) -> Self {
        Self {
            user_id: d.user_id,
            daily_minutes: d.daily_minutes,
            allowed_weekdays: d.allowed_weekdays,
            max_continuous_min: d.max_continuous_min,
            catch_up_mode: d.catch_up_mode,
            playback_speed: d.playback_speed,
            updated_at: chrono::Utc::now(),
        }
    }
}

impl From<&lectorbit_services::StudyConstraints> for StudyConstraintsDto {
    fn from(c: &lectorbit_services::StudyConstraints) -> Self {
        Self {
            user_id: c.user_id.clone(),
            daily_minutes: c.daily_minutes,
            allowed_weekdays: c.allowed_weekdays.clone(),
            max_continuous_min: c.max_continuous_min,
            catch_up_mode: c.catch_up_mode,
            playback_speed: c.playback_speed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanItemDto {
    pub id: String,
    pub plan_version_id: String,
    pub media_id: String,
    pub chunk_id: String,
    pub scheduled_for: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: String,
    pub seq: u32,
}

impl From<&lectorbit_services::PlanItem> for PlanItemDto {
    fn from(p: &lectorbit_services::PlanItem) -> Self {
        Self {
            id: p.id.clone(),
            plan_version_id: p.plan_version_id.clone(),
            media_id: p.media_id.clone(),
            chunk_id: p.chunk_id.clone(),
            scheduled_for: p.scheduled_for.clone(),
            start_ms: p.start_ms,
            end_ms: p.end_ms,
            status: p.status.as_str().to_string(),
            seq: p.seq,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanCommitDto {
    pub plan_version_id: String,
    pub horizon_start: String,
    pub horizon_end: String,
    pub items: Vec<PlanItemDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanStartDto {
    pub root_id: String,
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFileDto {
    pub id: String,
    pub root_id: String,
    pub path_redacted: String,
    pub size_bytes: u64,
    pub mtime: String,
    pub duration_ms: u64,
    pub chunk_count: u32,
}

impl From<&lectorbit_services::MediaFile> for MediaFileDto {
    fn from(m: &lectorbit_services::MediaFile) -> Self {
        Self {
            id: m.id.clone(),
            root_id: m.root_id.clone(),
            path_redacted: m.path_redacted.clone(),
            size_bytes: m.size_bytes,
            mtime: m.mtime.clone(),
            duration_ms: m.duration_ms,
            chunk_count: m.chunk_count,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHitDto {
    pub media_id: String,
    pub path_redacted: String,
    pub snippet: String,
    pub score: u32,
    pub source: String,
}

impl From<&lectorbit_services::SearchHit> for SearchHitDto {
    fn from(h: &lectorbit_services::SearchHit) -> Self {
        Self {
            media_id: h.media_id.clone(),
            path_redacted: h.path_redacted.clone(),
            snippet: h.snippet.clone(),
            score: h.score,
            source: h.source.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelDto {
    pub id: String,
    pub family: String,
    pub name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub status: String,
    pub path: String,
}

impl From<&lectorbit_services::AiModel> for AiModelDto {
    fn from(m: &lectorbit_services::AiModel) -> Self {
        Self {
            id: m.id.clone(),
            family: m.family.clone(),
            name: m.name.clone(),
            size_bytes: m.size_bytes,
            sha256: m.sha256.clone(),
            status: m.status.clone(),
            path: m.path.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsentEntryDto {
    pub id: String,
    pub user_id: String,
    pub feature: String,
    pub granted: bool,
    pub at: String,
    pub payload: Option<String>,
}

impl From<&lectorbit_services::ConsentEntry> for ConsentEntryDto {
    fn from(c: &lectorbit_services::ConsentEntry) -> Self {
        Self {
            id: c.id.clone(),
            user_id: c.user_id.clone(),
            feature: c.feature.clone(),
            granted: c.granted,
            at: c.at.to_rfc3339(),
            payload: c.payload.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudyActionDto {
    pub plan_item_id: Option<String>,
    pub media_id: Option<String>,
    pub kind: String,
}

// ============================================================================
// Stable error type
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureError {
    pub code: String,
    pub message: String,
}

impl FeatureError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<String> for FeatureError {
    fn from(s: String) -> Self {
        Self::new("internal", s)
    }
}

// ============================================================================
// The trait the host app implements
// ============================================================================

pub trait FeatureOps: Send + Sync + 'static {
    // --- Library / scanner (F4) ---

    fn enqueue_scan(
        &self,
        root_id: String,
    ) -> Box<dyn std::future::Future<Output = Result<ScanStartDto, FeatureError>> + Send + '_>;

    fn list_media(
        &self,
        root_id: Option<String>,
        limit: u32,
    ) -> Box<dyn std::future::Future<Output = Result<Vec<MediaFileDto>, FeatureError>> + Send + '_>;

    // --- Planner (F7) ---

    fn plan_preview(
        &self,
        constraints: StudyConstraintsDto,
        horizon_days: u32,
    ) -> Box<dyn std::future::Future<Output = Result<PlanCommitDto, FeatureError>> + Send + '_>;

    fn plan_today(
        &self,
        limit: u32,
    ) -> Box<dyn std::future::Future<Output = Result<Vec<PlanItemDto>, FeatureError>> + Send + '_>;

    fn record_study_action(
        &self,
        action: StudyActionDto,
    ) -> Box<dyn std::future::Future<Output = Result<(), FeatureError>> + Send + '_>;

    // --- Search (F11) ---

    fn search(
        &self,
        query: String,
        limit: u32,
    ) -> Box<dyn std::future::Future<Output = Result<Vec<SearchHitDto>, FeatureError>> + Send + '_>;

    // --- AI models (F10) ---

    fn list_models(
        &self,
    ) -> Box<dyn std::future::Future<Output = Result<Vec<AiModelDto>, FeatureError>> + Send + '_>;

    fn download_model(
        &self,
        id: String,
    ) -> Box<dyn std::future::Future<Output = Result<(), FeatureError>> + Send + '_>;

    fn quarantine_model(
        &self,
        id: String,
    ) -> Box<dyn std::future::Future<Output = Result<(), FeatureError>> + Send + '_>;

    // --- Consent (F12) ---

    fn consent_set(
        &self,
        feature: String,
        granted: bool,
    ) -> Box<dyn std::future::Future<Output = Result<(), FeatureError>> + Send + '_>;

    fn consent_get(
        &self,
        feature: String,
    ) -> Box<dyn std::future::Future<Output = Result<bool, FeatureError>> + Send + '_>;

    // --- Audit / diagnostics bundle (F13) ---

    fn export_diagnostics_bundle(
        &self,
    ) -> Box<dyn std::future::Future<Output = Result<String, FeatureError>> + Send + '_>;
}

// ============================================================================
// Command adapters
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct EnqueueScanArgs {
    pub root_id: String,
}

#[command]
pub async fn library_enqueue_scan(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: EnqueueScanArgs,
) -> Result<ScanStartDto, FeatureError> {
    ops.enqueue_scan(args.root_id).await
}

#[derive(Debug, Deserialize)]
pub struct ListMediaArgs {
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: u32,
}

fn default_limit() -> u32 {
    100
}

#[command]
pub async fn library_list_media(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: ListMediaArgs,
) -> Result<Vec<MediaFileDto>, FeatureError> {
    ops.list_media(args.root_id, args.limit).await
}

#[derive(Debug, Deserialize)]
pub struct PlanPreviewArgs {
    pub constraints: StudyConstraintsDto,
    #[serde(default = "default_horizon")]
    pub horizon_days: u32,
}

fn default_horizon() -> u32 {
    7
}

#[command]
pub async fn plan_preview(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: PlanPreviewArgs,
) -> Result<PlanCommitDto, FeatureError> {
    ops.plan_preview(args.constraints, args.horizon_days).await
}

#[derive(Debug, Deserialize)]
pub struct PlanTodayArgs {
    #[serde(default = "default_today_limit")]
    pub limit: u32,
}

fn default_today_limit() -> u32 {
    20
}

#[command]
pub async fn plan_today(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: PlanTodayArgs,
) -> Result<Vec<PlanItemDto>, FeatureError> {
    ops.plan_today(args.limit).await
}

#[command]
pub async fn study_record_action(
    ops: State<'_, Arc<dyn FeatureOps>>,
    action: StudyActionDto,
) -> Result<(), FeatureError> {
    ops.record_study_action(action).await
}

#[derive(Debug, Deserialize)]
pub struct SearchArgs {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: u32,
}

#[command]
pub async fn search_query(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: SearchArgs,
) -> Result<Vec<SearchHitDto>, FeatureError> {
    ops.search(args.query, args.limit).await
}

#[command]
pub async fn ai_models_list(
    ops: State<'_, Arc<dyn FeatureOps>>,
) -> Result<Vec<AiModelDto>, FeatureError> {
    ops.list_models().await
}

#[derive(Debug, Deserialize)]
pub struct ModelIdArgs {
    pub id: String,
}

#[command]
pub async fn ai_models_download(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: ModelIdArgs,
) -> Result<(), FeatureError> {
    ops.download_model(args.id).await
}

#[command]
pub async fn ai_models_quarantine(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: ModelIdArgs,
) -> Result<(), FeatureError> {
    ops.quarantine_model(args.id).await
}

#[derive(Debug, Deserialize)]
pub struct ConsentSetArgs {
    pub feature: String,
    pub granted: bool,
}

#[command]
pub async fn consent_set(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: ConsentSetArgs,
) -> Result<(), FeatureError> {
    ops.consent_set(args.feature, args.granted).await
}

#[derive(Debug, Deserialize)]
pub struct ConsentGetArgs {
    pub feature: String,
}

#[command]
pub async fn consent_get(
    ops: State<'_, Arc<dyn FeatureOps>>,
    args: ConsentGetArgs,
) -> Result<bool, FeatureError> {
    ops.consent_get(args.feature).await
}

#[command]
pub async fn audit_export_bundle(
    ops: State<'_, Arc<dyn FeatureOps>>,
) -> Result<String, FeatureError> {
    ops.export_diagnostics_bundle().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constraints_dto_round_trip() {
        let dto = StudyConstraintsDto {
            user_id: "local".into(),
            daily_minutes: 45,
            allowed_weekdays: vec![0, 1, 2, 3, 4],
            max_continuous_min: 25,
            catch_up_mode: true,
            playback_speed: 1.25,
        };
        let c: lectorbit_services::StudyConstraints = dto.clone().into();
        assert_eq!(c.daily_minutes, 45);
        assert_eq!(c.user_id, "local");
        assert_eq!(c.allowed_weekdays.len(), 5);
        let back = StudyConstraintsDto::from(&c);
        assert_eq!(back.daily_minutes, dto.daily_minutes);
        assert_eq!(back.allowed_weekdays, dto.allowed_weekdays);
    }

    #[test]
    fn feature_error_carries_code() {
        let e = FeatureError::new("not_found", "missing");
        assert_eq!(e.code, "not_found");
        assert_eq!(e.message, "missing");
    }

    #[test]
    fn plan_item_dto_uses_status_string() {
        let mut item = lectorbit_services::PlanItem {
            id: "i".into(),
            plan_version_id: "v".into(),
            plan_day_id: None,
            media_id: "m".into(),
            chunk_id: "c".into(),
            scheduled_for: "2026-01-05".into(),
            start_ms: 0,
            end_ms: 1,
            status: lectorbit_services::PlanItemStatus::Pending,
            seq: 0,
        };
        let dto = PlanItemDto::from(&item);
        assert_eq!(dto.status, "pending");
        item.status = lectorbit_services::PlanItemStatus::Done;
        let dto = PlanItemDto::from(&item);
        assert_eq!(dto.status, "done");
    }
}
