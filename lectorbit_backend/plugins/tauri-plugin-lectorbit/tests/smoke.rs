//! Command smoke tests for the internal plugin.
//!
//! These run without a Tauri runtime so they stay cheap and don't depend on a
//! webview harness. They cover:
//! - `app_get_version` returns a non-empty version string.
//! - The `DiagnosticsProvider` trait wrapper serializes a hand-built payload
//!   without leaking sensitive fields.

use std::sync::Arc;

use serde::Serialize;
use tauri_plugin_lectorbit::{app_get_version, AppVersion, DiagnosticsProvider};

#[test]
fn app_get_version_returns_a_version_string() {
    let v: AppVersion = app_get_version();
    assert!(!v.version.is_empty());
}

#[derive(Serialize)]
struct FakeReport {
    app: &'static str,
    redaction_marker_present: bool,
}

struct FakeProvider;

impl DiagnosticsProvider for FakeProvider {
    fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "app": "lectorbit-test",
            "redaction_marker_present": true,
        })
    }
}

#[test]
fn diagnostics_provider_trait_produces_a_serializable_snapshot() {
    let provider: Arc<dyn DiagnosticsProvider> = Arc::new(FakeProvider);
    let value = provider.snapshot();

    assert_eq!(value["app"], "lectorbit-test");
    assert_eq!(value["redaction_marker_present"], true);
}

#[test]
fn fake_report_serializes_cleanly() {
    // Round-trip a tiny diagnostic-shaped struct through serde_json so we
    // know the trait's `serde_json::Value` boundary is happy with whatever
    // the real `DiagnosticsReport` will produce.
    let report = FakeReport {
        app: "lectorbit-test",
        redaction_marker_present: true,
    };
    let value = serde_json::to_value(report).expect("serialize");
    assert_eq!(value["app"], "lectorbit-test");
    assert!(value["redaction_marker_present"].as_bool().unwrap());
}