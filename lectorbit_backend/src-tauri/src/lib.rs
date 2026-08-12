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
    AnalysisOps, CloudPlanningOps, DiagnosticsProvider, LibraryOps, PlannerOps, PlaybackOps,
    SearchOps, UpdateOps,
};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

mod analysis_adapter;
mod embedded_media;
mod library_adapter;
mod media_adapter;
mod openrouter_adapter;
mod planner_adapter;
mod playback_adapter;
mod update_adapter;
use analysis_adapter::AnalysisAdapter;
use embedded_media::EmbeddedMediaRegistry;
use library_adapter::LibraryAdapter;
use media_adapter::ProbeScheduler;
use openrouter_adapter::OpenRouterPlanningAdapter;
use planner_adapter::PlannerAdapter;
use playback_adapter::PlaybackAdapter;
use update_adapter::UpdateAdapter;

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

    let embedded_media =
        EmbeddedMediaRegistry::start().expect("start the private loopback media server");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_lectorbit::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .setup(move |app| {
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
            let chunks_repo = ChunksRepo::new(database.pool().clone());
            let planner_service = PlannerService::new(
                chunks_repo.clone(),
                PlansRepo::new(database.pool().clone()),
                StudyRepo::new(database.pool().clone()),
            );
            let cloud_planning_adapter = Arc::new(OpenRouterPlanningAdapter::new(chunks_repo)?);
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
            let ffmpeg_path = resolve_ffmpeg_path(
                resource_dir.as_deref(),
                std::env::var_os("LECTORBIT_FFMPEG_PATH"),
            );
            let analysis_adapter = Arc::new(tauri::async_runtime::block_on(AnalysisAdapter::new(
                analysis_service,
                SearchService::new(analysis_repo),
                whisper_path,
                ffmpeg_path.clone(),
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
            app.manage(cloud_planning_adapter as Arc<dyn CloudPlanningOps>);
            let playback_work = app_data.join("playback-work");
            std::fs::create_dir_all(&playback_work)
                .map_err(|error| format!("create playback work directory: {error}"))?;
            app.manage(Arc::new(PlaybackAdapter::new(
                playback_service,
                embedded_media,
                ffmpeg_path,
                playback_work,
            )) as Arc<dyn PlaybackOps>);
            app.manage(analysis_adapter.clone() as Arc<dyn AnalysisOps>);
            app.manage(analysis_adapter as Arc<dyn SearchOps>);
            app.manage(Arc::new(UpdateAdapter::new(app.handle().clone())) as Arc<dyn UpdateOps>);

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
    let search_path = if cfg!(debug_assertions) {
        std::env::var_os("PATH")
    } else {
        None
    };
    resolve_mpv_path_with_search_path(resource_dir, configured, search_path)
        .or_else(|| {
            if cfg!(all(debug_assertions, windows)) {
                resolve_pinned_windows_mpv(std::env::var_os("LOCALAPPDATA"))
            } else {
                None
            }
        })
        .map(std::path::PathBuf::into_os_string)
        .unwrap_or_else(|| if cfg!(windows) { "mpv.exe" } else { "mpv" }.into())
}

fn resolve_mpv_path_with_search_path(
    resource_dir: Option<&std::path::Path>,
    configured: Option<std::ffi::OsString>,
    search_path: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    let configured = configured.map(std::path::PathBuf::from);
    if configured
        .as_ref()
        .is_some_and(|path| path.is_absolute() && path.is_file())
    {
        return configured;
    }
    let filename = if cfg!(windows) { "mpv.exe" } else { "mpv" };
    resource_dir
        .map(|directory| directory.join("sidecars").join(filename))
        .filter(|path| path.is_absolute() && path.is_file())
        .or_else(|| resolve_executable_on_path(filename, search_path))
}

fn resolve_ffprobe_path(
    resource_dir: Option<&std::path::Path>,
    configured: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    let search_path = if cfg!(debug_assertions) {
        std::env::var_os("PATH")
    } else {
        None
    };
    resolve_ffprobe_path_with_search_path(resource_dir, configured, search_path).or_else(|| {
        if cfg!(all(debug_assertions, windows)) {
            resolve_pinned_windows_ffprobe(std::env::var_os("LOCALAPPDATA"))
        } else {
            None
        }
    })
}

fn resolve_ffmpeg_path(
    resource_dir: Option<&std::path::Path>,
    configured: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    let filename = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let search_path = if cfg!(debug_assertions) {
        std::env::var_os("PATH")
    } else {
        None
    };
    resolve_named_sidecar(resource_dir, configured, filename)
        .or_else(|| resolve_executable_on_path(filename, search_path))
        .or_else(|| {
            if cfg!(all(debug_assertions, windows)) {
                resolve_pinned_windows_ffmpeg(std::env::var_os("LOCALAPPDATA"))
            } else {
                None
            }
        })
}

fn resolve_ffprobe_path_with_search_path(
    resource_dir: Option<&std::path::Path>,
    configured: Option<std::ffi::OsString>,
    search_path: Option<std::ffi::OsString>,
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
        .or_else(|| resolve_executable_on_path(filename, search_path))
}

fn resolve_executable_on_path(
    filename: &str,
    search_path: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    std::env::split_paths(&search_path?)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(filename))
        .find(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok())
}

fn resolve_pinned_windows_ffprobe(
    local_app_data: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    let local_app_data = std::path::PathBuf::from(local_app_data?);
    if !local_app_data.is_absolute() {
        return None;
    }
    local_app_data
        .join("Microsoft")
        .join("WinGet")
        .join("Packages")
        .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
        .join("ffmpeg-8.1.2-full_build")
        .join("bin")
        .join("ffprobe.exe")
        .canonicalize()
        .ok()
        .filter(|path| path.is_file())
}

fn resolve_pinned_windows_ffmpeg(
    local_app_data: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    let local_app_data = std::path::PathBuf::from(local_app_data?);
    if !local_app_data.is_absolute() {
        return None;
    }
    local_app_data
        .join("Microsoft")
        .join("WinGet")
        .join("Packages")
        .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
        .join("ffmpeg-8.1.2-full_build")
        .join("bin")
        .join("ffmpeg.exe")
        .canonicalize()
        .ok()
        .filter(|path| path.is_file())
}

fn resolve_pinned_windows_mpv(
    local_app_data: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    let local_app_data = std::path::PathBuf::from(local_app_data?);
    if !local_app_data.is_absolute() {
        return None;
    }
    local_app_data
        .join("Microsoft")
        .join("WinGet")
        .join("Packages")
        .join("mpv-player.mpv-CI.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe")
        .join("mpv.exe")
        .canonicalize()
        .ok()
        .filter(|path| path.is_file())
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
        assert_eq!(
            resolve_ffprobe_path_with_search_path(None, Some("ffprobe".into()), None),
            None
        );
    }

    #[test]
    fn debug_sidecar_can_be_resolved_to_an_absolute_path() {
        let executable = std::env::current_exe().expect("test executable");
        let filename = executable
            .file_name()
            .and_then(|value| value.to_str())
            .expect("executable filename");
        let search_path = std::env::join_paths([executable.parent().expect("executable parent")])
            .expect("search path");

        assert_eq!(
            resolve_executable_on_path(filename, Some(search_path)),
            executable.canonicalize().ok()
        );
    }

    #[test]
    fn pinned_windows_development_install_is_discovered_without_a_shell_restart() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let local_app_data = directory.path().join("Local");
        let executable = local_app_data
            .join("Microsoft")
            .join("WinGet")
            .join("Packages")
            .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("ffmpeg-8.1.2-full_build")
            .join("bin")
            .join("ffprobe.exe");
        std::fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("create package directory");
        std::fs::write(&executable, b"fixture").expect("create executable fixture");

        assert_eq!(
            resolve_pinned_windows_ffprobe(Some(local_app_data.into_os_string())),
            executable.canonicalize().ok()
        );
    }

    #[test]
    fn relative_mpv_configuration_is_rejected() {
        assert_eq!(
            resolve_mpv_path_with_search_path(None, Some("other-player".into()), None),
            None
        );
    }

    #[test]
    fn pinned_windows_mpv_install_is_discovered_without_a_shell_restart() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let local_app_data = directory.path().join("Local");
        let executable = local_app_data
            .join("Microsoft")
            .join("WinGet")
            .join("Packages")
            .join("mpv-player.mpv-CI.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("mpv.exe");
        std::fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("create package directory");
        std::fs::write(&executable, b"fixture").expect("create executable fixture");

        assert_eq!(
            resolve_pinned_windows_mpv(Some(local_app_data.into_os_string())),
            executable.canonicalize().ok()
        );
    }
}
