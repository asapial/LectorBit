//! Capability-gated IPC for LectorBit's privileged desktop operations.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{plugin::TauriPlugin, AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Serialize, Deserialize)]
pub struct AppVersion {
    pub version: &'static str,
    pub build: &'static str,
}

pub fn current_app_version() -> AppVersion {
    AppVersion {
        version: env!("CARGO_PKG_VERSION"),
        build: option_env!("LECTORBIT_BUILD").unwrap_or("dev"),
    }
}

pub trait DiagnosticsProvider: Send + Sync + 'static {
    fn snapshot(&self) -> serde_json::Value;
}

mod app_commands {
    use super::*;

    #[tauri::command]
    pub(crate) fn app_get_version() -> AppVersion {
        current_app_version()
    }

    #[tauri::command]
    pub(crate) fn app_get_diagnostics(
        provider: State<'_, Arc<dyn DiagnosticsProvider>>,
    ) -> serde_json::Value {
        provider.snapshot()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LibraryRootDto {
    pub id: String,
    pub display_name: String,
    pub path_redacted: String,
    pub registered_at: String,
    pub revoked_at: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanJobDto {
    pub id: String,
    pub root_id: String,
    pub status: String,
    pub attempt: u32,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaListItemDto {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaPageDto {
    pub items: Vec<MediaListItemDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannerCandidateDto {
    pub media_id: String,
    pub display_name: String,
    pub path_redacted: String,
    pub duration_ms: u64,
    pub chunk_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannerCandidatePageDto {
    pub items: Vec<PlannerCandidateDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanningConstraintsDto {
    pub daily_budget_minutes: u32,
    pub allowed_weekdays: Vec<u8>,
    pub preferred_session_minutes: u32,
    pub max_continuous_minutes: u32,
    pub minimum_break_minutes: u32,
    pub playback_speed_milli: u16,
    pub horizon_days: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanningSelectionDto {
    pub media_id: String,
    pub priority: u8,
    pub deadline: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanRequestDto {
    pub horizon_start: String,
    pub constraints: PlanningConstraintsDto,
    pub selections: Vec<PlanningSelectionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanPreviewItemDto {
    pub sequence: u32,
    pub media_id: String,
    pub display_name: String,
    pub chunk_id: String,
    pub scheduled_for: String,
    pub raw_start_ms: u64,
    pub raw_end_ms: u64,
    pub effective_duration_ms: u64,
    pub break_after_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanDayDto {
    pub date: String,
    pub effective_content_ms: u64,
    pub break_ms: u64,
    pub item_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnscheduledWorkDto {
    pub media_id: String,
    pub display_name: String,
    pub remaining_raw_ms: u64,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AlternativePatchDto {
    AllowWeekdays { weekdays: Vec<u8> },
    IncreaseDailyBudget { minutes: u32 },
    ExtendHorizon { days: u16 },
    IncreasePlaybackSpeed { speed_milli: u16 },
    MoveDeadline { media_id: String, date: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanAlternativeDto {
    pub id: String,
    pub label: String,
    pub patch: AlternativePatchDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanPreviewDto {
    pub feasible: bool,
    pub horizon_start: String,
    pub horizon_end: String,
    pub items: Vec<PlanPreviewItemDto>,
    pub days: Vec<PlanDayDto>,
    pub unscheduled: Vec<UnscheduledWorkDto>,
    pub alternatives: Vec<PlanAlternativeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanCommitResultDto {
    pub plan_id: String,
    pub plan_version_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutineItemDto {
    pub id: String,
    pub media_id: String,
    pub display_name: String,
    pub chunk_id: String,
    pub sequence: u32,
    pub raw_start_ms: u64,
    pub raw_end_ms: u64,
    pub effective_duration_ms: u64,
    pub break_after_ms: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutineDayDto {
    pub id: String,
    pub date: String,
    pub effective_content_ms: u64,
    pub break_ms: u64,
    pub items: Vec<RoutineItemDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutinePlanDto {
    pub plan_id: String,
    pub plan_version_id: String,
    pub title: String,
    pub horizon_start: String,
    pub horizon_end: String,
    pub created_at: String,
    pub days: Vec<RoutineDayDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaybackCapabilityDto {
    pub available: bool,
    pub backend: String,
    pub expected_version: String,
    pub detected_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaybackViewDto {
    pub plan_item_id: String,
    pub media_id: String,
    pub display_name: String,
    pub raw_start_ms: u64,
    pub raw_end_ms: u64,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub paused: bool,
    pub speed: f64,
    pub progress_version: u64,
    pub item_covered_ms: u64,
    pub item_duration_ms: u64,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "event", content = "data")]
pub enum PlaybackEventDto {
    State(PlaybackViewDto),
    Closed { plan_item_id: String },
    Failed { message: String },
}

pub type PlaybackEventSink = Arc<dyn Fn(PlaybackEventDto) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum ScanProgressDto {
    Started {
        job_id: String,
        root_id: String,
    },
    Discovering {
        job_id: String,
        visited_entries: u64,
        media_candidates: u64,
    },
    Indexing {
        job_id: String,
        current: u64,
        total: u64,
    },
    Metadata {
        job_id: String,
        completed: u64,
        total: u64,
        failed: u64,
    },
    Completed {
        job_id: String,
        indexed: u64,
        issues: u64,
    },
    Failed {
        job_id: String,
        message: String,
    },
}

pub type ScanEventSink = Arc<dyn Fn(ScanProgressDto) + Send + Sync>;

pub trait LibraryOps: Send + Sync + 'static {
    fn list_roots(&self) -> BoxFuture<'_, Result<Vec<LibraryRootDto>, LibraryErrorCode>>;
    fn register_selected_root(
        &self,
        selected_path: String,
    ) -> BoxFuture<'_, Result<LibraryRootDto, LibraryErrorCode>>;
    fn revoke_root(&self, id: String) -> BoxFuture<'_, Result<LibraryRootDto, LibraryErrorCode>>;
    fn enqueue_scan(
        &self,
        root_id: String,
        sink: ScanEventSink,
    ) -> BoxFuture<'_, Result<ScanJobDto, LibraryErrorCode>>;
    fn list_scan_jobs(
        &self,
        root_id: Option<String>,
    ) -> BoxFuture<'_, Result<Vec<ScanJobDto>, LibraryErrorCode>>;
    fn list_media(
        &self,
        root_id: Option<String>,
        cursor: Option<String>,
        limit: u32,
    ) -> BoxFuture<'_, Result<MediaPageDto, LibraryErrorCode>>;
}

pub trait PlannerOps: Send + Sync + 'static {
    fn list_candidates(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> BoxFuture<'_, Result<PlannerCandidatePageDto, PlannerErrorCode>>;
    fn preview(
        &self,
        request: PlanRequestDto,
    ) -> BoxFuture<'_, Result<PlanPreviewDto, PlannerErrorCode>>;
    fn commit(
        &self,
        title: String,
        request: PlanRequestDto,
    ) -> BoxFuture<'_, Result<PlanCommitResultDto, PlannerErrorCode>>;
    fn routine(
        &self,
        day_limit: u32,
    ) -> BoxFuture<'_, Result<Option<RoutinePlanDto>, PlannerErrorCode>>;
    fn replan(
        &self,
        horizon_start: String,
    ) -> BoxFuture<'_, Result<PlanCommitResultDto, PlannerErrorCode>>;
}

pub trait PlaybackOps: Send + Sync + 'static {
    fn capability(&self) -> BoxFuture<'_, Result<PlaybackCapabilityDto, PlaybackErrorCode>>;
    fn open(
        &self,
        plan_item_id: String,
        sink: PlaybackEventSink,
    ) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>>;
    fn play(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>>;
    fn pause(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>>;
    fn seek(&self, position_ms: u64) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>>;
    fn set_speed(&self, speed: f64) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>>;
    fn state(&self) -> BoxFuture<'_, Result<PlaybackViewDto, PlaybackErrorCode>>;
    fn close(&self) -> BoxFuture<'_, Result<(), PlaybackErrorCode>>;
    fn record_action(
        &self,
        plan_item_id: String,
        kind: String,
        at_ms: Option<u64>,
    ) -> BoxFuture<'_, Result<(), PlaybackErrorCode>>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelDto {
    pub id: String,
    pub version: String,
    pub provider: String,
    pub expected_size_bytes: u64,
    pub architecture: String,
    pub analyzer_compatibility: String,
    pub license: String,
    pub state: String,
    pub bytes_downloaded: u64,
    pub verified_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalysisJobDto {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub attempt: u32,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptStateDto {
    pub media_id: String,
    pub status: String,
    pub segment_count: u64,
    pub updated_at: Option<String>,
    pub job: Option<AnalysisJobDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum AnalysisProgressDto {
    Queued {
        job_id: String,
    },
    Downloading {
        job_id: String,
        downloaded_bytes: u64,
        total_bytes: u64,
    },
    Extracting {
        job_id: String,
    },
    Transcribing {
        job_id: String,
    },
    Indexing {
        job_id: String,
        segments: u64,
    },
    Completed {
        job_id: String,
    },
    Failed {
        job_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchHitDto {
    pub media_id: String,
    pub display_name: String,
    pub plan_item_id: Option<String>,
    pub source: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    /// Safe plain text with matched terms wrapped in `<mark>` tags only.
    pub snippet: String,
    pub score: u32,
}

pub type AnalysisEventSink = Arc<dyn Fn(AnalysisProgressDto) + Send + Sync>;

pub trait AnalysisOps: Send + Sync + 'static {
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelDto>, AnalysisErrorCode>>;
    fn install_model(
        &self,
        model_id: String,
        sink: AnalysisEventSink,
    ) -> BoxFuture<'_, Result<AnalysisJobDto, AnalysisErrorCode>>;
    fn remove_model(&self, model_id: String) -> BoxFuture<'_, Result<(), AnalysisErrorCode>>;
    fn start_transcription(
        &self,
        media_id: String,
        model_id: String,
        sink: AnalysisEventSink,
    ) -> BoxFuture<'_, Result<AnalysisJobDto, AnalysisErrorCode>>;
    fn transcript_state(
        &self,
        media_id: String,
    ) -> BoxFuture<'_, Result<TranscriptStateDto, AnalysisErrorCode>>;
    fn list_jobs(
        &self,
        kind: String,
    ) -> BoxFuture<'_, Result<Vec<AnalysisJobDto>, AnalysisErrorCode>>;
}

pub trait SearchOps: Send + Sync + 'static {
    fn search(
        &self,
        text: String,
        limit: u32,
    ) -> BoxFuture<'_, Result<Vec<SearchHitDto>, SearchErrorCode>>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateCheckDto {
    pub status: String,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "event",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum UpdateProgressDto {
    Downloading {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Installing,
    Relaunching,
}

pub type UpdateEventSink = Arc<dyn Fn(UpdateProgressDto) + Send + Sync>;

pub trait UpdateOps: Send + Sync + 'static {
    fn check(&self) -> BoxFuture<'_, Result<UpdateCheckDto, UpdateErrorCode>>;
    fn install(
        &self,
        version: String,
        sink: UpdateEventSink,
    ) -> BoxFuture<'_, Result<(), UpdateErrorCode>>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryErrorCode {
    pub kind: LibraryErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryErrorKind {
    EmptyPath,
    NotADirectory,
    NotFound,
    Io,
    Database,
    Internal,
}

impl LibraryErrorCode {
    pub fn new(kind: LibraryErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannerErrorCode {
    pub kind: PlannerErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlannerErrorKind {
    InvalidInput,
    MediaUnavailable,
    Infeasible,
    Database,
    Internal,
}

impl PlannerErrorCode {
    pub fn new(kind: PlannerErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackErrorCode {
    pub kind: PlaybackErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackErrorKind {
    InvalidInput,
    ItemUnavailable,
    NotOpen,
    PlaybackUnavailable,
    Database,
    Internal,
}

impl PlaybackErrorCode {
    pub fn new(kind: PlaybackErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisErrorCode {
    pub kind: AnalysisErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisErrorKind {
    InvalidInput,
    ModelNotFound,
    ModelNotReady,
    MediaUnavailable,
    SidecarUnavailable,
    Database,
    Internal,
}

impl AnalysisErrorCode {
    pub fn new(kind: AnalysisErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchErrorCode {
    pub kind: SearchErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchErrorKind {
    InvalidInput,
    Database,
    Internal,
}

impl SearchErrorCode {
    pub fn new(kind: SearchErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateErrorCode {
    pub kind: UpdateErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateErrorKind {
    NotConfigured,
    InvalidRequest,
    Busy,
    Network,
    Verification,
    Install,
    Internal,
}

impl UpdateErrorCode {
    pub fn new(kind: UpdateErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RevokeRootArgs {
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct EnqueueScanArgs {
    pub root_id: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct ListScanJobsArgs {
    #[serde(default)]
    pub root_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ListMediaArgs {
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_media_limit")]
    pub limit: u32,
}

#[derive(Debug, Deserialize)]
pub struct PlannerPreviewArgs {
    pub request: PlanRequestDto,
}

#[derive(Debug, Default, Deserialize)]
pub struct PlannerCandidatesArgs {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_media_limit")]
    pub limit: u32,
}

#[derive(Debug, Deserialize)]
pub struct PlanCommitArgs {
    pub title: String,
    pub request: PlanRequestDto,
}

#[derive(Debug, Default, Deserialize)]
pub struct RoutineArgs {
    #[serde(default = "default_routine_days")]
    pub day_limit: u32,
}

#[derive(Debug, Deserialize)]
pub struct ReplanArgs {
    pub horizon_start: String,
}

#[derive(Debug, Deserialize)]
pub struct PlaybackOpenArgs {
    pub plan_item_id: String,
}

#[derive(Debug, Deserialize)]
pub struct PlaybackSeekArgs {
    pub position_ms: u64,
}

#[derive(Debug, Deserialize)]
pub struct PlaybackSpeedArgs {
    pub speed: f64,
}

#[derive(Debug, Deserialize)]
pub struct StudyActionArgs {
    pub plan_item_id: String,
    pub kind: String,
    #[serde(default)]
    pub at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct ModelArgs {
    pub model_id: String,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptionArgs {
    pub media_id: String,
    pub model_id: String,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptStateArgs {
    pub media_id: String,
}

#[derive(Debug, Deserialize)]
pub struct AnalysisJobsArgs {
    pub kind: String,
}

#[derive(Debug, Deserialize)]
pub struct SearchArgs {
    pub text: String,
    #[serde(default = "default_search_limit")]
    pub limit: u32,
}

#[derive(Debug, Deserialize)]
pub struct UpdateInstallArgs {
    pub version: String,
}

fn default_media_limit() -> u32 {
    50
}

fn default_routine_days() -> u32 {
    14
}

fn default_search_limit() -> u32 {
    30
}

mod commands {
    use super::*;

    #[tauri::command]
    pub(crate) async fn library_list_roots(
        ops: State<'_, Arc<dyn LibraryOps>>,
    ) -> Result<Vec<LibraryRootDto>, LibraryErrorCode> {
        ops.list_roots().await
    }

    /// The renderer cannot submit an absolute path. The native picker and the
    /// registration call are one capability-gated operation.
    #[tauri::command]
    pub(crate) async fn library_pick_and_register_root<R: Runtime>(
        app: AppHandle<R>,
        ops: State<'_, Arc<dyn LibraryOps>>,
    ) -> Result<Option<LibraryRootDto>, LibraryErrorCode> {
        let selected = app
            .dialog()
            .file()
            .set_title("Select a folder of videos")
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| {
            LibraryErrorCode::new(
                LibraryErrorKind::Io,
                "The selected folder could not be resolved.",
            )
        })?;
        ops.register_selected_root(path.to_string_lossy().into_owned())
            .await
            .map(Some)
    }

    #[tauri::command]
    pub(crate) async fn library_revoke_root(
        ops: State<'_, Arc<dyn LibraryOps>>,
        args: RevokeRootArgs,
    ) -> Result<LibraryRootDto, LibraryErrorCode> {
        ops.revoke_root(args.id).await
    }

    #[tauri::command]
    pub(crate) async fn library_enqueue_scan(
        ops: State<'_, Arc<dyn LibraryOps>>,
        args: EnqueueScanArgs,
        on_event: Channel<ScanProgressDto>,
    ) -> Result<ScanJobDto, LibraryErrorCode> {
        let sink: ScanEventSink = Arc::new(move |event| {
            let _ = on_event.send(event);
        });
        ops.enqueue_scan(args.root_id, sink).await
    }

    #[tauri::command]
    pub(crate) async fn library_list_scan_jobs(
        ops: State<'_, Arc<dyn LibraryOps>>,
        args: Option<ListScanJobsArgs>,
    ) -> Result<Vec<ScanJobDto>, LibraryErrorCode> {
        ops.list_scan_jobs(args.and_then(|value| value.root_id))
            .await
    }

    #[tauri::command]
    pub(crate) async fn library_list_media(
        ops: State<'_, Arc<dyn LibraryOps>>,
        args: Option<ListMediaArgs>,
    ) -> Result<MediaPageDto, LibraryErrorCode> {
        let args = args.unwrap_or_default();
        ops.list_media(args.root_id, args.cursor, args.limit).await
    }

    #[tauri::command]
    pub(crate) async fn planner_list_candidates(
        ops: State<'_, Arc<dyn PlannerOps>>,
        args: Option<PlannerCandidatesArgs>,
    ) -> Result<PlannerCandidatePageDto, PlannerErrorCode> {
        let args = args.unwrap_or_default();
        ops.list_candidates(args.cursor, args.limit).await
    }

    #[tauri::command]
    pub(crate) async fn planner_preview(
        ops: State<'_, Arc<dyn PlannerOps>>,
        args: PlannerPreviewArgs,
    ) -> Result<PlanPreviewDto, PlannerErrorCode> {
        ops.preview(args.request).await
    }

    #[tauri::command]
    pub(crate) async fn plan_commit(
        ops: State<'_, Arc<dyn PlannerOps>>,
        args: PlanCommitArgs,
    ) -> Result<PlanCommitResultDto, PlannerErrorCode> {
        ops.commit(args.title, args.request).await
    }

    #[tauri::command]
    pub(crate) async fn plan_get_routine(
        ops: State<'_, Arc<dyn PlannerOps>>,
        args: Option<RoutineArgs>,
    ) -> Result<Option<RoutinePlanDto>, PlannerErrorCode> {
        ops.routine(args.unwrap_or_default().day_limit).await
    }

    #[tauri::command]
    pub(crate) async fn plan_replan(
        ops: State<'_, Arc<dyn PlannerOps>>,
        args: ReplanArgs,
    ) -> Result<PlanCommitResultDto, PlannerErrorCode> {
        ops.replan(args.horizon_start).await
    }

    #[tauri::command]
    pub(crate) async fn playback_get_capability(
        ops: State<'_, Arc<dyn PlaybackOps>>,
    ) -> Result<PlaybackCapabilityDto, PlaybackErrorCode> {
        ops.capability().await
    }

    #[tauri::command]
    pub(crate) async fn playback_open(
        ops: State<'_, Arc<dyn PlaybackOps>>,
        args: PlaybackOpenArgs,
        on_event: Channel<PlaybackEventDto>,
    ) -> Result<PlaybackViewDto, PlaybackErrorCode> {
        let sink: PlaybackEventSink = Arc::new(move |event| {
            let _ = on_event.send(event);
        });
        ops.open(args.plan_item_id, sink).await
    }

    #[tauri::command]
    pub(crate) async fn playback_play(
        ops: State<'_, Arc<dyn PlaybackOps>>,
    ) -> Result<PlaybackViewDto, PlaybackErrorCode> {
        ops.play().await
    }

    #[tauri::command]
    pub(crate) async fn playback_pause(
        ops: State<'_, Arc<dyn PlaybackOps>>,
    ) -> Result<PlaybackViewDto, PlaybackErrorCode> {
        ops.pause().await
    }

    #[tauri::command]
    pub(crate) async fn playback_seek(
        ops: State<'_, Arc<dyn PlaybackOps>>,
        args: PlaybackSeekArgs,
    ) -> Result<PlaybackViewDto, PlaybackErrorCode> {
        ops.seek(args.position_ms).await
    }

    #[tauri::command]
    pub(crate) async fn playback_set_speed(
        ops: State<'_, Arc<dyn PlaybackOps>>,
        args: PlaybackSpeedArgs,
    ) -> Result<PlaybackViewDto, PlaybackErrorCode> {
        ops.set_speed(args.speed).await
    }

    #[tauri::command]
    pub(crate) async fn playback_get_state(
        ops: State<'_, Arc<dyn PlaybackOps>>,
    ) -> Result<PlaybackViewDto, PlaybackErrorCode> {
        ops.state().await
    }

    #[tauri::command]
    pub(crate) async fn playback_close(
        ops: State<'_, Arc<dyn PlaybackOps>>,
    ) -> Result<(), PlaybackErrorCode> {
        ops.close().await
    }

    #[tauri::command]
    pub(crate) async fn study_record_action(
        ops: State<'_, Arc<dyn PlaybackOps>>,
        args: StudyActionArgs,
    ) -> Result<(), PlaybackErrorCode> {
        ops.record_action(args.plan_item_id, args.kind, args.at_ms)
            .await
    }

    #[tauri::command]
    pub(crate) async fn models_list(
        ops: State<'_, Arc<dyn AnalysisOps>>,
    ) -> Result<Vec<ModelDto>, AnalysisErrorCode> {
        ops.list_models().await
    }

    #[tauri::command]
    pub(crate) async fn models_install(
        ops: State<'_, Arc<dyn AnalysisOps>>,
        args: ModelArgs,
        on_event: Channel<AnalysisProgressDto>,
    ) -> Result<AnalysisJobDto, AnalysisErrorCode> {
        let sink: AnalysisEventSink = Arc::new(move |event| {
            let _ = on_event.send(event);
        });
        ops.install_model(args.model_id, sink).await
    }

    #[tauri::command]
    pub(crate) async fn models_remove(
        ops: State<'_, Arc<dyn AnalysisOps>>,
        args: ModelArgs,
    ) -> Result<(), AnalysisErrorCode> {
        ops.remove_model(args.model_id).await
    }

    #[tauri::command]
    pub(crate) async fn analysis_start_transcription(
        ops: State<'_, Arc<dyn AnalysisOps>>,
        args: TranscriptionArgs,
        on_event: Channel<AnalysisProgressDto>,
    ) -> Result<AnalysisJobDto, AnalysisErrorCode> {
        let sink: AnalysisEventSink = Arc::new(move |event| {
            let _ = on_event.send(event);
        });
        ops.start_transcription(args.media_id, args.model_id, sink)
            .await
    }

    #[tauri::command]
    pub(crate) async fn analysis_get_transcript_state(
        ops: State<'_, Arc<dyn AnalysisOps>>,
        args: TranscriptStateArgs,
    ) -> Result<TranscriptStateDto, AnalysisErrorCode> {
        ops.transcript_state(args.media_id).await
    }

    #[tauri::command]
    pub(crate) async fn analysis_list_jobs(
        ops: State<'_, Arc<dyn AnalysisOps>>,
        args: AnalysisJobsArgs,
    ) -> Result<Vec<AnalysisJobDto>, AnalysisErrorCode> {
        ops.list_jobs(args.kind).await
    }

    #[tauri::command]
    pub(crate) async fn search_query(
        ops: State<'_, Arc<dyn SearchOps>>,
        args: SearchArgs,
    ) -> Result<Vec<SearchHitDto>, SearchErrorCode> {
        ops.search(args.text, args.limit).await
    }

    #[tauri::command]
    pub(crate) async fn updates_check(
        ops: State<'_, Arc<dyn UpdateOps>>,
    ) -> Result<UpdateCheckDto, UpdateErrorCode> {
        ops.check().await
    }

    #[tauri::command]
    pub(crate) async fn updates_install(
        ops: State<'_, Arc<dyn UpdateOps>>,
        args: UpdateInstallArgs,
        on_event: Channel<UpdateProgressDto>,
    ) -> Result<(), UpdateErrorCode> {
        let sink: UpdateEventSink = Arc::new(move |event| {
            let _ = on_event.send(event);
        });
        ops.install(args.version, sink).await
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    plugin_builder::build()
}

// `generate_handler!` imports command helper macros. Keeping that expansion in
// a child module prevents macro-namespace collisions with commands defined in
// this public boundary module.
mod plugin_builder {
    use tauri::{
        plugin::{Builder, TauriPlugin},
        Runtime,
    };

    pub(super) fn build<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("lectorbit")
            .invoke_handler(tauri::generate_handler![
                super::app_commands::app_get_version,
                super::app_commands::app_get_diagnostics,
                super::commands::library_list_roots,
                super::commands::library_pick_and_register_root,
                super::commands::library_revoke_root,
                super::commands::library_enqueue_scan,
                super::commands::library_list_scan_jobs,
                super::commands::library_list_media,
                super::commands::planner_list_candidates,
                super::commands::planner_preview,
                super::commands::plan_commit,
                super::commands::plan_get_routine,
                super::commands::plan_replan,
                super::commands::playback_get_capability,
                super::commands::playback_open,
                super::commands::playback_play,
                super::commands::playback_pause,
                super::commands::playback_seek,
                super::commands::playback_set_speed,
                super::commands::playback_get_state,
                super::commands::playback_close,
                super::commands::study_record_action,
                super::commands::models_list,
                super::commands::models_install,
                super::commands::models_remove,
                super::commands::analysis_start_transcription,
                super::commands::analysis_get_transcript_state,
                super::commands::analysis_list_jobs,
                super::commands::search_query,
                super::commands::updates_check,
                super::commands::updates_install,
            ])
            .build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_progress_uses_tagged_wire_shape() {
        let value = serde_json::to_value(ScanProgressDto::Indexing {
            job_id: "job".into(),
            current: 4,
            total: 10,
        })
        .expect("serialize");
        assert_eq!(value["event"], "indexing");
        assert_eq!(value["data"]["current"], 4);

        let metadata = serde_json::to_value(ScanProgressDto::Metadata {
            job_id: "probe".into(),
            completed: 2,
            total: 3,
            failed: 1,
        })
        .expect("serialize metadata");
        assert_eq!(metadata["event"], "metadata");
        assert_eq!(metadata["data"]["jobId"], "probe");
    }

    #[test]
    fn planner_alternative_uses_a_tagged_safe_shape() {
        let value = serde_json::to_value(PlanAlternativeDto {
            id: "budget".into(),
            label: "Add time".into(),
            patch: AlternativePatchDto::IncreaseDailyBudget { minutes: 60 },
        })
        .expect("serialize");
        assert_eq!(value["patch"]["kind"], "increase_daily_budget");
        assert_eq!(value["patch"]["minutes"], 60);
    }

    #[test]
    fn analysis_progress_uses_camel_case_channel_fields() {
        let value = serde_json::to_value(AnalysisProgressDto::Downloading {
            job_id: "job".into(),
            downloaded_bytes: 10,
            total_bytes: 20,
        })
        .expect("serialize");
        assert_eq!(value["event"], "downloading");
        assert_eq!(value["data"]["jobId"], "job");
        assert_eq!(value["data"]["downloadedBytes"], 10);
    }

    #[test]
    fn update_progress_uses_a_tagged_safe_wire_shape() {
        let value = serde_json::to_value(UpdateProgressDto::Downloading {
            downloaded_bytes: 512,
            total_bytes: Some(1024),
        })
        .expect("serialize update progress");
        assert_eq!(value["event"], "downloading");
        assert_eq!(value["data"]["downloadedBytes"], 512);
        assert_eq!(value["data"]["totalBytes"], 1024);
        assert!(value.get("download_url").is_none());
        assert!(value.get("signature").is_none());
    }
}
