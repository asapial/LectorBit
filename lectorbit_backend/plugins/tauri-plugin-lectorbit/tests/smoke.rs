//! Command smoke test for `app_get_version`.
//!
//! Runs the handler directly (no Tauri runtime) to verify the payload shape.

use tauri_plugin_lectorbit::{AppVersion, app_get_version};

#[test]
fn app_get_version_returns_a_version_string() {
    let v: AppVersion = app_get_version();
    assert!(!v.version.is_empty());
}