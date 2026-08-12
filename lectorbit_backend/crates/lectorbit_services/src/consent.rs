//! Consent ledger (Feature 12).
//!
//! The actual storage lives in the `consent_events` table (Feature 1). This
//! module exposes a typed façade that:
//!
//! - validates that the feature name is one of a known set
//! - records a new entry
//! - returns the latest grant for a (user, feature) pair
//! - toggles convenience helpers

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::models::ConsentEntry;

/// All consent features we recognise.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ConsentFeature {
    /// Stream audio chunks to the local whisper.cpp process.
    AiWhisper,
    /// Share anonymised usage analytics.
    AnalyticsShare,
    /// Auto-check for updates on startup.
    AutoUpdateCheck,
    /// Allow the AI to suggest new chunks across media.
    AiCrossMediaSuggest,
}

impl ConsentFeature {
    pub fn as_db_str(self) -> &'static str {
        match self {
            ConsentFeature::AiWhisper => "ai_whisper",
            ConsentFeature::AnalyticsShare => "analytics_share",
            ConsentFeature::AutoUpdateCheck => "auto_update_check",
            ConsentFeature::AiCrossMediaSuggest => "ai_cross_media_suggest",
        }
    }

    pub fn from_db_str(s: &str) -> Option<Self> {
        Some(match s {
            "ai_whisper" => Self::AiWhisper,
            "analytics_share" => Self::AnalyticsShare,
            "auto_update_check" => Self::AutoUpdateCheck,
            "ai_cross_media_suggest" => Self::AiCrossMediaSuggest,
            _ => return None,
        })
    }

    pub const ALL: &'static [ConsentFeature] = &[
        ConsentFeature::AiWhisper,
        ConsentFeature::AnalyticsShare,
        ConsentFeature::AutoUpdateCheck,
        ConsentFeature::AiCrossMediaSuggest,
    ];
}

/// Where the consent decision originated.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsentSource {
    SettingsToggle,
    FirstRun,
    MigratedV1,
}

impl ConsentSource {
    pub fn as_db_str(self) -> &'static str {
        match self {
            ConsentSource::SettingsToggle => "settings_toggle",
            ConsentSource::FirstRun => "first_run",
            ConsentSource::MigratedV1 => "migrated_v1",
        }
    }
}

#[derive(Debug, Error)]
pub enum ConsentError {
    #[error("unknown consent feature: {0}")]
    UnknownFeature(String),
    #[error("consent storage error: {0}")]
    Storage(String),
}

/// Record a new consent decision.
///
/// The caller is responsible for persisting the returned `ConsentEntry`
/// to `consent_events` and capturing the source string in `payload`.
pub fn record(feature: ConsentFeature, granted: bool, source: ConsentSource) -> ConsentEntry {
    let at = chrono::Utc::now();
    ConsentEntry {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: "local".to_string(),
        feature: feature.as_db_str().to_string(),
        granted,
        at,
        payload: Some(format!(r#"{{"source":"{}"}}"#, source.as_db_str())),
    }
}

/// Convenience: parse a stored row into the typed enum, returning None if
/// the feature string is not recognised (forward-compat with new features).
pub fn latest_entry_to_feature(entry: &ConsentEntry) -> Option<(ConsentFeature, bool)> {
    let f = ConsentFeature::from_db_str(&entry.feature)?;
    Some((f, entry.granted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_roundtrip() {
        for f in ConsentFeature::ALL {
            assert_eq!(ConsentFeature::from_db_str(f.as_db_str()), Some(*f));
        }
    }

    #[test]
    fn unknown_feature_yields_none() {
        assert!(ConsentFeature::from_db_str("nope").is_none());
    }

    #[test]
    fn record_produces_entry_with_now_timestamp() {
        let e = record(
            ConsentFeature::AiWhisper,
            true,
            ConsentSource::SettingsToggle,
        );
        assert_eq!(e.user_id, "local");
        assert_eq!(e.feature, "ai_whisper");
        assert!(e.granted);
        assert!(e
            .payload
            .as_deref()
            .unwrap_or("")
            .contains("settings_toggle"));
    }

    #[test]
    fn record_rejected_grant_round_trips() {
        let e = record(
            ConsentFeature::AnalyticsShare,
            false,
            ConsentSource::FirstRun,
        );
        let (f, g) = latest_entry_to_feature(&e).unwrap();
        assert_eq!(f, ConsentFeature::AnalyticsShare);
        assert!(!g);
    }
}
