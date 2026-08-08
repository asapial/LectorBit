//! Internal Tauri plugin that exposes narrow, capability-gated LectorBit commands.
//!
//! Why a plugin and not plain `invoke_handler` registrations?
//! - Plain app commands are NOT default-denied by Tauri capabilities.
//! - Plugin commands can declare explicit generated allow/deny permissions per command,
//!   and the main window's capability file only lists the LectorBit permissions it needs.
//!
//! Conventions:
//! - Each command: `deserialize DTO -> permission/window check -> resource/root check
//!   -> service call -> map result/error`.
//! - Business rules stay in `lectorbit_services`; this crate is a thin adapter.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime, State,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct AppVersion {
    pub version: &'static str,
    pub build: &'static str,
}

// `pub` so integration tests can call the handler directly without a Tauri runtime.
#[tauri::command]
pub fn app_get_version() -> AppVersion {
    AppVersion {
        version: env!("CARGO_PKG_VERSION"),
        build: env!("LECTORBIT_BUILD", "dev"),
    }
}

/// Trait the host application implements to provide the diagnostics snapshot.
///
/// The plugin holds this as managed state (`Arc<dyn DiagnosticsProvider>`)
/// and the `app_get_diagnostics` command forwards to it. The trait keeps
/// `lectorbit_services` (and its heavy SQLx dep) out of the plugin crate.
pub trait DiagnosticsProvider: Send + Sync + 'static {
    /// Build a serializable diagnostics snapshot. The returned value is
    /// already redacted and safe to surface to the renderer.
    fn snapshot(&self) -> serde_json::Value;
}

#[tauri::command]
pub fn app_get_diagnostics(
    provider: State<'_, Arc<dyn DiagnosticsProvider>>,
) -> serde_json::Value {
    provider.snapshot()
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // If the host forgot to register managed state, Tauri surfaces that as an
    // error at command-invocation time. We don't fail initialization here
    // because `init` is also called from unit tests that don't need diagnostics.
    Builder::new("lectorbit")
        .invoke_handler(tauri::generate_handler![
            app_get_version,
            app_get_diagnostics
        ])
        .build()
}