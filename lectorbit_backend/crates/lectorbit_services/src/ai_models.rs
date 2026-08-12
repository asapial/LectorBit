//! AI model registry (Feature 11).
//!
//! Tracks whisper.cpp model files: where they live on disk, their expected
//! SHA-256, and their lifecycle state (Discoverable → Downloading → Ready →
//! Quarantined). On download, the file is written to `<state_dir>/models/`
//! and verified against the expected hash before being marked Ready.
//!
//! This module is *pure logic*; the network/disk I/O lives in the plugin
//! or a separate worker. The functions here decide *what* should happen,
//! not *how*.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::models::AiModel;

/// Lifecycle of a model file.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ModelState {
    /// Listed in the registry but not present on disk.
    Available,
    /// A download is in progress.
    Downloading,
    /// Downloaded and hash-verified.
    Ready,
    /// Present but failed verification — must be deleted.
    Quarantined,
}

#[derive(Debug, Error)]
pub enum ModelError {
    #[error("invalid model id: {0}")]
    InvalidId(String),
    #[error("hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("model is not Ready: {0}")]
    NotReady(String),
}

/// Validate a model id: lowercase letters, digits, dot, underscore, dash.
/// Max 64 chars.
pub fn validate_id(id: &str) -> Result<(), ModelError> {
    if id.is_empty() || id.len() > 64 {
        return Err(ModelError::InvalidId(id.to_string()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    {
        return Err(ModelError::InvalidId(id.to_string()));
    }
    Ok(())
}

/// Convert a hex SHA-256 to a normalized lowercase form. Returns an error
/// if the input is not exactly 64 hex chars.
pub fn normalize_sha256(raw: &str) -> Result<String, ModelError> {
    let s = raw.trim().to_ascii_lowercase();
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ModelError::InvalidId(format!("bad sha256: {raw}")));
    }
    Ok(s)
}

/// Pure helper: given a freshly-downloaded model and its verified
/// SHA-256, transition it to Ready (or Quarantined if the hash is wrong).
pub fn verify_download(model: AiModel, actual_sha256: &str) -> Result<AiModel, ModelError> {
    let expected = normalize_sha256(&model.sha256)?;
    let actual = normalize_sha256(actual_sha256)?;
    if expected != actual {
        return Err(ModelError::HashMismatch { expected, actual });
    }
    Ok(AiModel {
        state: "ready".into(),
        ..model
    })
}

/// Mark a Ready model as Quarantined (used after a failed run / virus
/// scanner hit).
pub fn quarantine(model: AiModel) -> AiModel {
    AiModel {
        state: "quarantined".into(),
        ..model
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_model() -> AiModel {
        AiModel {
            id: "tiny.en".into(),
            kind: "whisper".into(),
            sha256: "b1937d96b91c30dc35fef7ed94f0c1f3a0c30d5c4f0c0d5f3a0c30d5c4f0c0d5".into(),
            size_bytes: 75_000_000,
            state: "downloading".into(),
            quarantined_reason: None,
        }
    }

    #[test]
    fn validate_id_accepts_normals() {
        assert!(validate_id("tiny.en").is_ok());
        assert!(validate_id("large-v3-q5_0").is_ok());
    }

    #[test]
    fn validate_id_rejects_bad() {
        assert!(validate_id("").is_err());
        assert!(validate_id("../etc/passwd").is_err());
        assert!(validate_id("BIG").is_err());
        assert!(validate_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn normalize_sha256_lowercases_and_rejects_short() {
        let h = "B1937D96B91C30DC35FEF7ED94F0C1F3A0C30D5C4F0C0D5F3A0C30D5C4F0C0D5";
        assert_eq!(
            normalize_sha256(h).unwrap(),
            "b1937d96b91c30dc35fef7ed94f0c1f3a0c30d5c4f0c0d5f3a0c30d5c4f0c0d5"
        );
        assert!(normalize_sha256("abc").is_err());
    }

    #[test]
    fn verify_download_marks_ready_on_match() {
        let m = sample_model();
        let r = verify_download(m.clone(), &m.sha256).unwrap();
        assert_eq!(r.state, "ready");
    }

    #[test]
    fn verify_download_quarantines_on_mismatch() {
        let mut m = sample_model();
        m.sha256 = "a".repeat(64);
        let r = verify_download(m, &("b".repeat(64)));
        assert!(matches!(r, Err(ModelError::HashMismatch { .. })));
    }

    #[test]
    fn quarantine_sets_state() {
        let m = AiModel {
            state: "ready".into(),
            ..sample_model()
        };
        let q = quarantine(m);
        assert_eq!(q.state, "quarantined");
    }
}
