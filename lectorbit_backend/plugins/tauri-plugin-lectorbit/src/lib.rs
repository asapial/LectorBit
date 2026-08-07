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

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
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

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lectorbit")
        .invoke_handler(tauri::generate_handler![app_get_version])
        .build()
}