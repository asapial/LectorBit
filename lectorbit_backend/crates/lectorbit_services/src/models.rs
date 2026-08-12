//! Domain models used at the IPC boundary.
//!
//! Kept in one file because they're plain data and we want to keep
//! `lectorbit_core` free of `serde` defaults that would leak into the kernel.
//!
//! All models here are `Clone + Serialize + Deserialize` so the renderer can
//! round-trip them through zod schemas without custom glue.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// User-facing study constraints (Feature 6).
///
/// `daily_minutes` is a soft target the planner tries to hit on every scheduled
/// day, not a hard cap; the planner will absorb ±10% to honour higher-priority
/// rules. `max_continuous_min` IS hard: a single plan_item is never longer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StudyConstraints {
    pub user_id: String,
    pub daily_minutes: u32,
    /// `0..=6` with `0 = Monday` (ISO). Empty array disables scheduling entirely.
    pub allowed_weekdays: Vec<u8>,
    pub max_continuous_min: u32,
    pub catch_up_mode: bool,
    /// 0.5 ..= 2.0. Clamped at the editor boundary.
    pub playback_speed: f32,
    pub updated_at: DateTime<Utc>,
}

impl Default for StudyConstraints {
    fn default() -> Self {
        Self {
            user_id: "local".into(),
            daily_minutes: 30,
            allowed_weekdays: vec![0, 1, 2, 3, 4, 5, 6],
            max_continuous_min: 25,
            catch_up_mode: true,
            playback_speed: 1.0,
            updated_at: Utc::now(),
        }
    }
}

impl StudyConstraints {
    /// DAG check: every numeric field must be inside its allowed range and the
    /// weekday vector must be a valid subset of `0..=6`. Returns `Ok(())` on
    /// success or a human-readable error suitable for surfacing in the UI.
    pub fn validate(&self) -> Result<(), String> {
        if self.daily_minutes == 0 || self.daily_minutes > 24 * 60 {
            return Err(format!(
                "daily_minutes must be between 1 and {}, got {}",
                24 * 60,
                self.daily_minutes
            ));
        }
        if self.max_continuous_min == 0 || self.max_continuous_min > 8 * 60 {
            return Err(format!(
                "max_continuous_min must be between 1 and {}, got {}",
                8 * 60,
                self.max_continuous_min
            ));
        }
        if !(0.5..=2.0).contains(&self.playback_speed) {
            return Err(format!(
                "playback_speed must be between 0.5 and 2.0, got {}",
                self.playback_speed
            ));
        }
        for &w in &self.allowed_weekdays {
            if w > 6 {
                return Err(format!(
                    "weekday {w} is invalid; allowed values are 0..=6 (Mon..Sun)"
                ));
            }
        }
        if self.max_continuous_min > self.daily_minutes {
            return Err("max_continuous_min cannot exceed daily_minutes".to_string());
        }
        Ok(())
    }
}

/// A coarse 20-30 minute chunk of a media file.
///
/// Generated deterministically from `duration_ms` by
/// [`lectorbit_services::library::derive_chunks_for_media`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Chunk {
    pub id: String,
    pub media_id: String,
    pub idx: u32,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// A row from `media_files` (Feature 4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaFile {
    pub id: String,
    pub root_id: String,
    pub path_redacted: String,
    pub size_bytes: u64,
    pub mtime: String,
    pub chunk_count: u32,
    pub duration_ms: u64,
}

/// A scheduled study session (Feature 7). The planner commits one of these
/// per chunk per scheduled day, then the Today view (Feature 8) reads them.
///
/// `PlanItem` is the *planner-facing* shape; the persistence layer maps it
/// onto `plan_items` (F1) keyed by `plan_day_id`, and joins to the new
/// `plan_versions` table via `plan_version_id` for history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanItem {
    pub id: String,
    pub plan_version_id: String,
    pub plan_day_id: Option<String>,
    pub media_id: String,
    pub chunk_id: String,
    /// `YYYY-MM-DD`.
    pub scheduled_for: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: PlanItemStatus,
    /// Display order within a plan_version (0-based, ascending).
    pub seq: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Done,
    Skipped,
    Postponed,
}

impl PlanItemStatus {
    pub fn from_str(s: &str) -> Self {
        match s {
            "in_progress" => Self::InProgress,
            "done" => Self::Done,
            "skipped" => Self::Skipped,
            "postponed" => Self::Postponed,
            _ => Self::Pending,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Done => "done",
            Self::Skipped => "skipped",
            Self::Postponed => "postponed",
        }
    }
}

/// A study action recorded by the Today view (Feature 10).
///
/// Append-only: the planner replans from the latest run, never edits history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StudyAction {
    pub id: String,
    pub user_id: String,
    pub plan_item_id: Option<String>,
    pub media_id: Option<String>,
    pub kind: StudyActionKind,
    pub payload: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StudyActionKind {
    Started,
    Paused,
    Finished,
    Skipped,
    Postponed,
    Split,
}

impl StudyActionKind {
    pub fn from_str(s: &str) -> Self {
        match s {
            "started" => Self::Started,
            "paused" => Self::Paused,
            "finished" => Self::Finished,
            "skipped" => Self::Skipped,
            "postponed" => Self::Postponed,
            "split" => Self::Split,
            _ => Self::Started,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Paused => "paused",
            Self::Finished => "finished",
            Self::Skipped => "skipped",
            Self::Postponed => "postponed",
            Self::Split => "split",
        }
    }
}

/// A consolidated search hit (Feature 11).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchHit {
    pub media_id: String,
    pub path_redacted: String,
    pub snippet: String,
    /// 0..=100, percentage score normalized from FTS5 rank.
    pub score: u32,
    pub source: SearchSource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchSource {
    Media,
    Transcript,
}

/// A consent ledger entry (Feature 13). Mirrors `consent_events` (F1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConsentEntry {
    pub id: String,
    pub user_id: String,
    /// The `scope` column on `consent_events`: e.g. `cloud`, `analytics`,
    /// `model_download`. We keep the field name as `feature` in code for
    /// readability; SQL maps the column.
    pub feature: String,
    pub granted: bool,
    pub at: DateTime<Utc>,
    pub payload: Option<String>,
}

/// Catalog entry for an AI model (Feature 12).
///
/// Matches the `ai_models` table from migration 0002: every time field is
/// stored as RFC3339 text, not as a typed `DateTime`, so the in-memory
/// representation stays portable across runtimes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiModel {
    pub id: String,
    pub family: String,
    pub name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub path: String,
    pub status: String,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constraints_default_validates() {
        let c = StudyConstraints::default();
        c.validate().expect("default must validate");
    }

    #[test]
    fn constraints_reject_zero_daily_minutes() {
        let c = StudyConstraints {
            daily_minutes: 0,
            ..StudyConstraints::default()
        };
        assert!(c.validate().is_err());
    }

    #[test]
    fn constraints_reject_continuous_above_daily() {
        let c = StudyConstraints {
            daily_minutes: 20,
            max_continuous_min: 30,
            ..StudyConstraints::default()
        };
        assert!(c.validate().is_err());
    }

    #[test]
    fn constraints_reject_speed_out_of_range() {
        let c = StudyConstraints {
            playback_speed: 3.0,
            ..StudyConstraints::default()
        };
        assert!(c.validate().is_err());
    }

    #[test]
    fn constraints_reject_invalid_weekday() {
        let c = StudyConstraints {
            allowed_weekdays: vec![7],
            ..StudyConstraints::default()
        };
        assert!(c.validate().is_err());
    }

    #[test]
    fn plan_item_status_round_trip() {
        for s in [
            PlanItemStatus::Pending,
            PlanItemStatus::InProgress,
            PlanItemStatus::Done,
            PlanItemStatus::Skipped,
            PlanItemStatus::Postponed,
        ] {
            assert_eq!(PlanItemStatus::from_str(s.as_str()), s);
        }
    }

    #[test]
    fn study_action_kind_round_trip() {
        for k in [
            StudyActionKind::Started,
            StudyActionKind::Paused,
            StudyActionKind::Finished,
            StudyActionKind::Skipped,
            StudyActionKind::Postponed,
            StudyActionKind::Split,
        ] {
            assert_eq!(StudyActionKind::from_str(k.as_str()), k);
        }
    }
}
