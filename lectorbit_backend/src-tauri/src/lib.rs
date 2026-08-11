//! Thin Tauri shell: bootstrap, managed adapters, and capability-gated plugins.

use std::io::stderr;
use std::sync::Arc;

use lectorbit_db::{
    AnalysisRepo, ChunksRepo, LibraryRootsRepo, MediaRepo, PlansRepo, RedactingMakeWriter,
    StudyRepo,
};
use lectorbit_playback::MpvEngine;
use lectorbit_services::{
    AnalysisService, DiagnosticsService, LibraryService, MediaService, PlannerService,
    PlaybackService, SearchService,
};
use tauri::Manager;
use tauri_plugin_lectorbit::{
    AnalysisOps, DiagnosticsProvider, LibraryOps, PlannerOps, PlaybackOps, SearchOps,
};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

mod analysis_adapter;
mod library_adapter;
mod media_adapter;
mod planner_adapter;
mod playback_adapter;
use analysis_adapter::AnalysisAdapter;
use library_adapter::LibraryAdapter;
use media_adapter::ProbeScheduler;
use planner_adapter::PlannerAdapter;
use playback_adapter::PlaybackAdapter;

struct DiagnosticsAdapter(DiagnosticsService);

impl DiagnosticsProvider for DiagnosticsAdapter {
    fn snapshot(&self) -> serde_json::Value {
        let service = self.0.clone();
        tauri::async_runtime::block_on(async move {
            serde_json::to_value(service.collect().await).unwrap_or_else(|error| {
                tracing::warn!(target: "diagnostics", %error, "snapshot serialization failed");
                serde_json::json!({ "error": "diagnostics serialization failed" })
            })
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(RedactingMakeWriter::new(stderr()))
                .with_target(false),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_lectorbit::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("resolve app data directory: {error}"))?;
            std::fs::create_dir_all(&app_data)
                .map_err(|error| format!("create app data directory: {error}"))?;
            let database_path = app_data.join("lectordb.sqlite");
            let database = tauri::async_runtime::block_on(lectorbit_db::Db::open(&database_path))
                .map_err(|error| format!("open application database: {error}"))?;

            let diagnostics = DiagnosticsService::new(
                database.clone(),
                env!("CARGO_PKG_VERSION"),
                option_env!("LECTORBIT_BUILD").unwrap_or("dev"),
                chrono::Utc::now(),
            );
            let library_service =
                LibraryService::new(LibraryRootsRepo::new(database.pool().clone()));
            let media_service = MediaService::new(MediaRepo::new(database.pool().clone()));
            let analysis_repo = AnalysisRepo::new(database.pool().clone());
            let models_dir = app_data.join("models");
            std::fs::create_dir_all(&models_dir)
                .map_err(|error| format!("create model directory: {error}"))?;
            let analysis_service =
                AnalysisService::new(analysis_repo.clone(), media_service.clone(), models_dir);
            tauri::async_runtime::block_on(analysis_service.initialize_catalog())
                .map_err(|error| format!("initialize model catalog: {error}"))?;
            let planner_service = PlannerService::new(
                ChunksRepo::new(database.pool().clone()),
                PlansRepo::new(database.pool().clone()),
                StudyRepo::new(database.pool().clone()),
            );
            let mpv_path = resolve_mpv_path(
                app.path().resource_dir().ok().as_deref(),
                std::env::var_os("LECTORBIT_MPV_PATH"),
            );
            let playback_service = PlaybackService::new(
                Arc::new(MpvEngine::new(mpv_path)),
                media_service.clone(),
                StudyRepo::new(database.pool().clone()),
            );
            let ffprobe_path = resolve_ffprobe_path(
                app.path().resource_dir().ok().as_deref(),
                std::env::var_os("LECTORBIT_FFPROBE_PATH"),
            );
            let resource_dir = app.path().resource_dir().ok();
            let whisper_path = resolve_named_sidecar(
                resource_dir.as_deref(),
                std::env::var_os("LECTORBIT_WHISPER_PATH"),
                if cfg!(windows) {
                    "whisper-cli.exe"
                } else {
                    "whisper-cli"
                },
            );
            let ffmpeg_path = resolve_named_sidecar(
                resource_dir.as_deref(),
                std::env::var_os("LECTORBIT_FFMPEG_PATH"),
                if cfg!(windows) {
                    "ffmpeg.exe"
                } else {
                    "ffmpeg"
                },
            );
            let analysis_adapter = Arc::new(tauri::async_runtime::block_on(AnalysisAdapter::new(
                analysis_service,
                SearchService::new(analysis_repo),
                whisper_path,
                ffmpeg_path,
                app_data.join("analysis-work"),
            )));
            std::fs::create_dir_all(app_data.join("analysis-work"))
                .map_err(|error| format!("create analysis work directory: {error}"))?;
            let probe_scheduler = tauri::async_runtime::block_on(ProbeScheduler::new(
                media_service.clone(),
                ffprobe_path,
            ));
            let library_adapter = Arc::new(LibraryAdapter::new(
                library_service,
                media_service,
                probe_scheduler.clone(),
                database.pool().clone(),
            ));
            tauri::async_runtime::block_on(library_adapter.recover_and_resume())
                .map_err(|error| format!("recover interrupted jobs: {error}"))?;
            tauri::async_runtime::block_on(probe_scheduler.recover_and_resume())
                .map_err(|error| format!("recover probe jobs: {error}"))?;
            tauri::async_runtime::block_on(analysis_adapter.recover_and_resume())
                .map_err(|error| format!("recover analysis jobs: {error}"))?;

            app.manage(Arc::new(DiagnosticsAdapter(diagnostics)) as Arc<dyn DiagnosticsProvider>);
            app.manage(library_adapter as Arc<dyn LibraryOps>);
            app.manage(Arc::new(PlannerAdapter::new(planner_service)) as Arc<dyn PlannerOps>);
            app.manage(Arc::new(PlaybackAdapter::new(playback_service)) as Arc<dyn PlaybackOps>);
            app.manage(analysis_adapter.clone() as Arc<dyn AnalysisOps>);
            app.manage(analysis_adapter as Arc<dyn SearchOps>);

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LectorBit");
}

fn resolve_mpv_path(
    resource_dir: Option<&std::path::Path>,
    configured: Option<std::ffi::OsString>,
) -> std::ffi::OsString {
    let configured = configured.map(std::path::PathBuf::from);
    if configured
        .as_ref()
        .is_some_and(|path| path.is_absolute() && path.is_file())
    {
        return configured.unwrap().into_os_string();
    }
    let filename = if cfg!(windows) { "mpv.exe" } else { "mpv" };
    resource_dir
        .map(|directory| directory.join("sidecars").join(filename))
        .filter(|path| path.is_absolute() && path.is_file())
        .map(std::path::PathBuf::into_os_string)
        .unwrap_or_else(|| filename.into())
}

fn resolve_ffprobe_path(
    resource_dir: Option<&std::path::Path>,
    configured: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    let configured = configured.map(std::path::PathBuf::from);
    if configured
        .as_ref()
        .is_some_and(|path| path.is_absolute() && path.is_file())
    {
        return configured;
    }
    let filename = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    resource_dir
        .map(|directory| directory.join("sidecars").join(filename))
        .filter(|path| path.is_absolute() && path.is_file())
}

fn resolve_named_sidecar(
    resource_dir: Option<&std::path::Path>,
    configured: Option<std::ffi::OsString>,
    filename: &str,
) -> Option<std::path::PathBuf> {
    let configured = configured.map(std::path::PathBuf::from);
    if configured
        .as_ref()
        .is_some_and(|path| path.is_absolute() && path.is_file())
    {
        return configured;
    }
    resource_dir
        .map(|directory| directory.join("sidecars").join(filename))
        .filter(|path| path.is_absolute() && path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_sidecar_configuration_is_rejected() {
        assert_eq!(resolve_ffprobe_path(None, Some("ffprobe".into())), None);
    }

    #[test]
    fn relative_mpv_configuration_falls_back_to_the_known_binary_name() {
        assert_eq!(
            resolve_mpv_path(None, Some("other-player".into())),
            std::ffi::OsString::from(if cfg!(windows) { "mpv.exe" } else { "mpv" })
        );
    }
}
