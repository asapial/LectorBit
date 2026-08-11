//! Thin Tauri shell: bootstrap, managed adapters, and capability-gated plugins.

use std::io::stderr;
use std::sync::Arc;

use lectorbit_db::{LibraryRootsRepo, RedactingMakeWriter};
use lectorbit_services::{DiagnosticsService, LibraryService};
use tauri::Manager;
use tauri_plugin_lectorbit::{DiagnosticsProvider, LibraryOps};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

mod library_adapter;
use library_adapter::LibraryAdapter;

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
                env!("LECTORBIT_BUILD", "dev"),
                chrono::Utc::now(),
            );
            let library_service =
                LibraryService::new(LibraryRootsRepo::new(database.pool().clone()));
            let library_adapter = Arc::new(LibraryAdapter::new(
                library_service,
                database.pool().clone(),
            ));
            tauri::async_runtime::block_on(library_adapter.recover_and_resume())
                .map_err(|error| format!("recover interrupted jobs: {error}"))?;

            app.manage(Arc::new(DiagnosticsAdapter(diagnostics)) as Arc<dyn DiagnosticsProvider>);
            app.manage(library_adapter as Arc<dyn LibraryOps>);

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LectorBit");
}
