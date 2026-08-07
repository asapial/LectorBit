//! LectorBit Tauri app shell.
//!
//! Responsibilities (kept intentionally thin):
//! - bootstrap tracing with the redaction MakeWriter
//! - register plugins
//! - open the main window with a narrow capability
//! - hand control over to services / IPC adapters
//!
//! Business logic lives in `lectorbit_services`. Privileged IPC is exposed via
//! `tauri-plugin-lectorbit` so commands can be capability-gated per-window.

use std::io::stderr;

use lectorbit_db::RedactingMakeWriter;
use tauri::Manager;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

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
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LectorBit");
}