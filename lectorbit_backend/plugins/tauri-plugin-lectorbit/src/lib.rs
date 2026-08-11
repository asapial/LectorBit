//! Capability-gated IPC for LectorBit's privileged desktop operations.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime, State,
};
use tauri_plugin_dialog::DialogExt;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Serialize, Deserialize)]
pub struct AppVersion {
    pub version: &'static str,
    pub build: &'static str,
}

#[tauri::command]
pub fn app_get_version() -> AppVersion {
    AppVersion {
        version: env!("CARGO_PKG_VERSION"),
        build: option_env!("LECTORBIT_BUILD").unwrap_or("dev"),
    }
}

pub trait DiagnosticsProvider: Send + Sync + 'static {
    fn snapshot(&self) -> serde_json::Value;
}

#[tauri::command]
pub fn app_get_diagnostics(provider: State<'_, Arc<dyn DiagnosticsProvider>>) -> serde_json::Value {
    provider.snapshot()
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
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
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

fn default_media_limit() -> u32 {
    50
}

#[tauri::command]
pub async fn library_list_roots(
    ops: State<'_, Arc<dyn LibraryOps>>,
) -> Result<Vec<LibraryRootDto>, LibraryErrorCode> {
    ops.list_roots().await
}

/// The renderer cannot submit an absolute path. The native picker and the
/// registration call are one capability-gated operation.
#[tauri::command]
pub async fn library_pick_and_register_root<R: Runtime>(
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
pub async fn library_revoke_root(
    ops: State<'_, Arc<dyn LibraryOps>>,
    args: RevokeRootArgs,
) -> Result<LibraryRootDto, LibraryErrorCode> {
    ops.revoke_root(args.id).await
}

#[tauri::command]
pub async fn library_enqueue_scan(
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
pub async fn library_list_scan_jobs(
    ops: State<'_, Arc<dyn LibraryOps>>,
    args: Option<ListScanJobsArgs>,
) -> Result<Vec<ScanJobDto>, LibraryErrorCode> {
    ops.list_scan_jobs(args.and_then(|value| value.root_id))
        .await
}

#[tauri::command]
pub async fn library_list_media(
    ops: State<'_, Arc<dyn LibraryOps>>,
    args: Option<ListMediaArgs>,
) -> Result<MediaPageDto, LibraryErrorCode> {
    let args = args.unwrap_or_default();
    ops.list_media(args.root_id, args.cursor, args.limit).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lectorbit")
        .invoke_handler(tauri::generate_handler![
            app_get_version,
            app_get_diagnostics,
            library_list_roots,
            library_pick_and_register_root,
            library_revoke_root,
            library_enqueue_scan,
            library_list_scan_jobs,
            library_list_media,
        ])
        .build()
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
}
