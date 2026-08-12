//! Audit + diagnostics bundle (Feature 13).
//!
//! The `audit_events` table holds the canonical log. This module exposes:
//!
//! - [`audit`] — typed entry builder.
//! - [`redact_payload`] — strips paths and tokens before persistence.
//! - [`bundle_manifest`] — produces a JSON index of what would be exported
//!   in a diagnostics bundle (used by both the export UI and the export
//!   itself, so the on-disk shape stays consistent).

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::models::MediaFile;

/// A typed audit action. Keep this list short and explicit so we can scan
/// `audit_events.action` with confidence.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    LibraryScanStart,
    LibraryScanEnd,
    LibraryMediaAdded,
    LibraryMediaRemoved,
    ConstraintsUpdated,
    PlanCommitted,
    PlanSuperseded,
    StudyActionRecorded,
    PlaybackStarted,
    PlaybackCompleted,
    ConsentChanged,
    ModelDownloaded,
    ModelQuarantined,
    SearchQuery,
    DiagnosticsBundleExported,
    SettingsUpdated,
}

impl AuditAction {
    pub fn as_db_str(self) -> &'static str {
        match self {
            AuditAction::LibraryScanStart => "library_scan_start",
            AuditAction::LibraryScanEnd => "library_scan_end",
            AuditAction::LibraryMediaAdded => "library_media_added",
            AuditAction::LibraryMediaRemoved => "library_media_removed",
            AuditAction::ConstraintsUpdated => "constraints_updated",
            AuditAction::PlanCommitted => "plan_committed",
            AuditAction::PlanSuperseded => "plan_superseded",
            AuditAction::StudyActionRecorded => "study_action_recorded",
            AuditAction::PlaybackStarted => "playback_started",
            AuditAction::PlaybackCompleted => "playback_completed",
            AuditAction::ConsentChanged => "consent_changed",
            AuditAction::ModelDownloaded => "model_downloaded",
            AuditAction::ModelQuarantined => "model_quarantined",
            AuditAction::SearchQuery => "search_query",
            AuditAction::DiagnosticsBundleExported => "diagnostics_bundle_exported",
            AuditAction::SettingsUpdated => "settings_updated",
        }
    }
}

#[derive(Debug, Error)]
pub enum AuditError {
    #[error("audit payload too large: {size} bytes (max {max})")]
    PayloadTooLarge { size: usize, max: usize },
    #[error("audit storage error: {0}")]
    Storage(String),
}

/// Maximum size of the JSON-serialized payload. Prevents a runaway
/// payload from clogging the DB.
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024;

/// Build a JSON payload from any serializable record, redacting known
/// sensitive keys at the top level and enforcing the size limit.
pub fn redact_payload<T: Serialize>(record: &T) -> Result<serde_json::Value, AuditError> {
    let value = serde_json::to_value(record).map_err(|e| AuditError::Storage(e.to_string()))?;
    let redacted = redact_value(value);
    let serialized =
        serde_json::to_string(&redacted).map_err(|e| AuditError::Storage(e.to_string()))?;
    if serialized.len() > MAX_PAYLOAD_BYTES {
        return Err(AuditError::PayloadTooLarge {
            size: serialized.len(),
            max: MAX_PAYLOAD_BYTES,
        });
    }
    Ok(redacted)
}

fn redact_value(mut value: serde_json::Value) -> serde_json::Value {
    const SENSITIVE: &[&str] = &[
        "token",
        "access_token",
        "refresh_token",
        "password",
        "api_key",
        "authorization",
    ];
    if let serde_json::Value::Object(map) = &mut value {
        for k in SENSITIVE {
            if let Some(v) = map.get_mut(*k) {
                *v = serde_json::Value::String("[redacted]".into());
            }
        }
    }
    value
}

/// A summary entry inside a diagnostics bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BundleEntry {
    pub path: String,
    pub kind: String,
    pub byte_size_estimate: u64,
}

/// The manifest is the first file inside the export and lists every other
/// file in the bundle with its kind and size.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BundleManifest {
    pub schema: u32,
    pub created_at: String,
    pub app_version: String,
    pub entries: Vec<BundleEntry>,
}

impl BundleManifest {
    pub fn current(app_version: impl Into<String>) -> Self {
        Self {
            schema: 1,
            created_at: chrono::Utc::now().to_rfc3339(),
            app_version: app_version.into(),
            entries: Vec::new(),
        }
    }
}

/// Build a default manifest for a diagnostics export given the media list.
/// The real implementation will append settings, audit rows, etc. — this
/// is the deterministic skeleton.
pub fn default_bundle_entries(media: &[MediaFile], audit_row_count: u64) -> Vec<BundleEntry> {
    let mut entries = Vec::with_capacity(media.len() + 2);
    entries.push(BundleEntry {
        path: "manifest.json".into(),
        kind: "manifest".into(),
        byte_size_estimate: 0,
    });
    entries.push(BundleEntry {
        path: "audit.jsonl".into(),
        kind: "audit_log".into(),
        byte_size_estimate: audit_row_count.saturating_mul(200),
    });
    for m in media {
        entries.push(BundleEntry {
            path: format!("media/{}.json", redact_path(&m.path_redacted)),
            kind: "media_meta".into(),
            byte_size_estimate: 512,
        });
    }
    entries
}

/// Produce a stable, sanitized filename from a media path (no dirs, no
/// spaces, only [a-z0-9_]). Returns "unknown" if the input is empty.
pub fn redact_path(raw: &str) -> String {
    let stem = std::path::Path::new(raw)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let mut out = String::with_capacity(stem.len());
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "unknown".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redact_value_strips_tokens() {
        let v = json!({
            "token": "abc",
            "password": "hunter2",
            "safe": "ok"
        });
        let r = redact_payload(&v).unwrap();
        assert_eq!(r["token"], "[redacted]");
        assert_eq!(r["password"], "[redacted]");
        assert_eq!(r["safe"], "ok");
    }

    #[test]
    fn redact_payload_rejects_oversize() {
        let big = "x".repeat(MAX_PAYLOAD_BYTES + 1);
        let v = json!({ "k": big });
        let err = redact_payload(&v).unwrap_err();
        match err {
            AuditError::PayloadTooLarge { .. } => {}
            _ => panic!("wrong error variant"),
        }
    }

    #[test]
    fn redact_path_collapses_specials() {
        assert_eq!(redact_path("/tmp/Lecture 01.mp4"), "lecture_01");
        assert_eq!(redact_path("C:\\users\\foo\\bar.MKV"), "bar");
        assert_eq!(redact_path(""), "unknown");
    }

    #[test]
    fn manifest_is_well_formed() {
        let m = BundleManifest::current("0.1.0");
        assert_eq!(m.schema, 1);
        assert_eq!(m.app_version, "0.1.0");
        assert!(m.entries.is_empty());
    }

    #[test]
    fn default_bundle_entries_is_deterministic() {
        let media = vec![
            MediaFile {
                id: "a".into(),
                root_id: "r".into(),
                path_redacted: "/p/a".into(),
                size_bytes: 1,
                duration_ms: 100,
                chunk_count: 1,
                mtime: "0".into(),
            },
            MediaFile {
                id: "b".into(),
                root_id: "r".into(),
                path_redacted: "/p/b".into(),
                size_bytes: 1,
                duration_ms: 100,
                chunk_count: 1,
                mtime: "0".into(),
            },
        ];
        let e1 = default_bundle_entries(&media, 5);
        let e2 = default_bundle_entries(&media, 5);
        assert_eq!(e1, e2);
        assert_eq!(e1.len(), 2 + 2);
    }
}
