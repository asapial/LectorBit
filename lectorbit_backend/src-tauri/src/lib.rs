//! LectorBit Tauri app shell.
//!
//! Responsibilities (kept intentionally thin):
//! - bootstrap tracing with the redaction MakeWriter
//! - open the SQLite database and run migrations
//! - register plugins
//! - open the main window with a narrow capability
//! - hand control over to services / IPC adapters
//!
//! Business logic lives in `lectorbit_services`. Privileged IPC is exposed via
//! `tauri-plugin-lectorbit` so commands can be capability-gated per-window.

use std::io::stderr;
use std::sync::Arc;

use lectorbit_db::RedactingMakeWriter;
use lectorbit_services::DiagnosticsService;
use tauri::Manager;
use tauri_plugin_lectorbit::DiagnosticsProvider;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Adapter that wraps `DiagnosticsService` so the plugin's `DiagnosticsProvider`
/// trait can be satisfied without depending on `lectorbit_services`.
struct DiagnosticsAdapter(DiagnosticsService);

impl DiagnosticsProvider for DiagnosticsAdapter {
    fn snapshot(&self) -> serde_json::Value {
        // We can't await in a sync trait. Build a small dedicated runtime
        // for the one-shot snapshot — diagnostics are rare and tiny, so the
        // overhead is fine and keeps the plugin API sync.
        let svc = self.0.clone();
        let value = tauri::async_runtime::block_on(async move {
            let report = svc.collect().await;
            serde_json::to_value(&report).unwrap_or_else(|e| {
                tracing::warn!(target: "diagnostics", error = %e, "snapshot serialization failed");
                serde_json::json!({ "error": "diagnostics serialization failed" })
            })
        });
        value
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
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
            // Determine the SQLite file path. We use Tauri's `app_data_dir()`
            // because it gives us a per-OS, writable location that's already
            // routed correctly for sandboxing.
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("resolve app_data_dir: {e}"))?;
            std::fs::create_dir_all(&app_data)
                .map_err(|e| format!("create app_data_dir {}: {e}", app_data.display()))?;
            let db_path = app_data.join("lectordb.sqlite");

            // Open DB (runs migrations on first start). Failure here should be
            // surfaced cleanly to the user; for now we panic with a useful
            // message because there's no UI plumbing yet.
            let db = tauri::async_runtime::block_on(lectorbit_db::Db::open(&db_path))
                .map_err(|e| format!("open database {}: {e}", db_path.display()))?;

            let started_at = chrono::Utc::now();
            let diagnostics = DiagnosticsService::new(
                db,
                env!("CARGO_PKG_VERSION"),
                env!("LECTORBIT_BUILD", "dev"),
                started_at,
            );

            // Register the adapter for `app_get_diagnostics`.
            app.manage(Arc::new(DiagnosticsAdapter(diagnostics)) as Arc<dyn DiagnosticsProvider>);

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LectorBit");
}