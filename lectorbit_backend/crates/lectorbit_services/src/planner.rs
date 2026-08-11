//! Backend-owned deterministic plan preview and immutable commit workflow.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{Duration, NaiveDate};
use lectorbit_db::{
    ChunksRepo, CommittedPlan, DbError, PlansRepo, ReplanMediaState, RoutinePlan, SchedulableMedia,
    StoredChunk, StudyRepo,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use lectorbit_core::planning::*;

const LOCAL_USER_ID: &str = "local";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannerCandidate {
    pub media_id: String,
    pub display_name: String,
    pub path_redacted: String,
    pub duration_ms: u64,
    pub chunk_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannerCandidatePage {
    pub items: Vec<PlannerCandidate>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanningSelection {
    pub media_id: String,
    pub priority: u8,
    pub deadline: Option<NaiveDate>,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanRequest {
    pub horizon_start: NaiveDate,
    pub constraints: PlanningConstraints,
    pub selections: Vec<PlanningSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanPreview {
    pub draft: PlanDraft,
    pub labels: BTreeMap<String, String>,
    pub alternatives: Vec<PlanAlternative>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanAlternative {
    pub id: String,
    pub label: String,
    pub patch: AlternativePatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AlternativePatch {
    AllowWeekdays { weekdays: Vec<u8> },
    IncreaseDailyBudget { minutes: u32 },
    ExtendHorizon { days: u16 },
    IncreasePlaybackSpeed { speed_milli: u16 },
    MoveDeadline { media_id: String, date: NaiveDate },
}

#[derive(Debug, Error)]
pub enum PlannerServiceError {
    #[error("select at least one schedulable media item")]
    EmptySelection,
    #[error("too many media items selected")]
    SelectionLimit,
    #[error("media selection contains a duplicate")]
    DuplicateSelection,
    #[error("selected media is unavailable: {0}")]
    MediaUnavailable(String),
    #[error("the plan is not feasible")]
    Infeasible,
    #[error("the plan contains no remaining study work")]
    EmptyPlan,
    #[error("there is no active plan to replan")]
    NoActivePlan,
    #[error("invalid plan input: {0}")]
    InvalidInput(String),
    #[error("planner database operation failed")]
    Database,
}

impl From<DbError> for PlannerServiceError {
    fn from(error: DbError) -> Self {
        tracing::error!(error = %error, "planner database operation failed");
        Self::Database
    }
}

#[derive(Clone)]
pub struct PlannerService {
    chunks: ChunksRepo,
    plans: PlansRepo,
    study: StudyRepo,
}

impl PlannerService {
    pub fn new(chunks: ChunksRepo, plans: PlansRepo, study: StudyRepo) -> Self {
        Self {
            chunks,
            plans,
            study,
        }
    }

    pub async fn list_candidates(
        &self,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<PlannerCandidatePage, PlannerServiceError> {
        let page = self.chunks.list_candidate_page(cursor, limit).await?;
        Ok(PlannerCandidatePage {
            items: page
                .items
                .into_iter()
                .map(|entry| PlannerCandidate {
                    media_id: entry.media_id,
                    display_name: entry.display_name,
                    path_redacted: entry.path_redacted,
                    duration_ms: entry.duration_ms,
                    chunk_count: entry.chunk_count,
                })
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    pub async fn preview(&self, request: &PlanRequest) -> Result<PlanPreview, PlannerServiceError> {
        let available = self.chunks.list_schedulable().await?;
        build_preview(request, available)
    }

    pub async fn commit(
        &self,
        title: &str,
        request: &PlanRequest,
    ) -> Result<CommittedPlan, PlannerServiceError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
            return Err(PlannerServiceError::InvalidInput("plan title".into()));
        }
        let preview = self.preview(request).await?;
        if !preview.draft.is_feasible() {
            return Err(PlannerServiceError::Infeasible);
        }
        if preview.draft.items.is_empty() {
            return Err(PlannerServiceError::EmptyPlan);
        }
        let mut selections = request.selections.clone();
        selections.sort_by(|left, right| left.media_id.cmp(&right.media_id));
        let selections_json = serde_json::to_string(&selections)
            .map_err(|_| PlannerServiceError::InvalidInput("selections".into()))?;
        Ok(self
            .plans
            .commit(
                LOCAL_USER_ID,
                title,
                &request.constraints,
                &selections_json,
                &preview.draft,
            )
            .await?)
    }

    pub async fn routine(
        &self,
        day_limit: u32,
    ) -> Result<Option<RoutinePlan>, PlannerServiceError> {
        Ok(self
            .plans
            .get_active_routine(LOCAL_USER_ID, day_limit)
            .await?)
    }

    pub async fn replan(
        &self,
        horizon_start: NaiveDate,
    ) -> Result<CommittedPlan, PlannerServiceError> {
        let seed = self
            .plans
            .get_active_seed(LOCAL_USER_ID)
            .await?
            .ok_or(PlannerServiceError::NoActivePlan)?;
        let selections: Vec<PlanningSelection> = serde_json::from_str(&seed.selections_json)
            .map_err(|_| PlannerServiceError::InvalidInput("stored selections".into()))?;
        let request = PlanRequest {
            horizon_start,
            constraints: seed.constraints,
            selections,
        };
        let available = self.chunks.list_schedulable().await?;
        let states = self
            .study
            .replan_media_states()
            .await?
            .into_iter()
            .map(|state| (state.media_id.clone(), state))
            .collect::<BTreeMap<_, _>>();
        let preview = build_preview_with_states(&request, available, &states)?;
        if !preview.draft.is_feasible() {
            return Err(PlannerServiceError::Infeasible);
        }
        if preview.draft.items.is_empty() {
            return Err(PlannerServiceError::EmptyPlan);
        }
        Ok(self
            .plans
            .commit(
                LOCAL_USER_ID,
                &seed.title,
                &request.constraints,
                &seed.selections_json,
                &preview.draft,
            )
            .await?)
    }
}

fn build_preview(
    request: &PlanRequest,
    available: Vec<SchedulableMedia>,
) -> Result<PlanPreview, PlannerServiceError> {
    build_preview_with_states(request, available, &BTreeMap::new())
}

fn build_preview_with_states(
    request: &PlanRequest,
    available: Vec<SchedulableMedia>,
    states: &BTreeMap<String, ReplanMediaState>,
) -> Result<PlanPreview, PlannerServiceError> {
    if request.selections.is_empty() {
        return Err(PlannerServiceError::EmptySelection);
    }
    if request.selections.len() > 500 {
        return Err(PlannerServiceError::SelectionLimit);
    }
    let selected_ids = request
        .selections
        .iter()
        .map(|selection| selection.media_id.as_str())
        .collect::<BTreeSet<_>>();
    if selected_ids.len() != request.selections.len() {
        return Err(PlannerServiceError::DuplicateSelection);
    }
    let mut by_id = available
        .into_iter()
        .map(|entry| (entry.media.id.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    let mut labels = BTreeMap::new();
    let mut media_work = Vec::with_capacity(request.selections.len());
    for selection in &request.selections {
        let entry = by_id
            .remove(&selection.media_id)
            .ok_or_else(|| PlannerServiceError::MediaUnavailable(selection.media_id.clone()))?;
        labels.insert(selection.media_id.clone(), entry.media.display_name);
        let chunks = adjusted_chunks(entry.chunks, states.get(&selection.media_id));
        media_work.push(MediaWork {
            media_id: selection.media_id.clone(),
            priority: selection.priority,
            deadline: selection.deadline,
            dependencies: selection.dependencies.clone(),
            chunks,
        });
    }
    let draft = build_plan(request.horizon_start, &request.constraints, &media_work)
        .map_err(|error| PlannerServiceError::InvalidInput(error.to_string()))?;
    let alternatives = alternatives_for(request, &draft);
    Ok(PlanPreview {
        draft,
        labels,
        alternatives,
    })
}

fn adjusted_chunks(
    chunks: Vec<StoredChunk>,
    state: Option<&ReplanMediaState>,
) -> Vec<PlanningChunk> {
    let Some(state) = state else {
        return chunks
            .into_iter()
            .map(|chunk| PlanningChunk {
                id: chunk.id,
                ordinal: chunk.ordinal,
                start_ms: chunk.start_ms,
                end_ms: chunk.end_ms,
                remaining_start_ms: chunk.start_ms,
            })
            .collect();
    };

    let mut result = Vec::new();
    for chunk in chunks {
        let mut boundaries = vec![chunk.start_ms, chunk.end_ms];
        for (start, end) in state
            .completed_ranges
            .iter()
            .chain(state.forced_ranges.iter())
        {
            if *end > chunk.start_ms && *start < chunk.end_ms {
                boundaries.push((*start).max(chunk.start_ms));
                boundaries.push((*end).min(chunk.end_ms));
            }
        }
        boundaries.extend(
            state
                .split_points
                .iter()
                .copied()
                .filter(|point| *point > chunk.start_ms && *point < chunk.end_ms),
        );
        boundaries.sort_unstable();
        boundaries.dedup();
        for pair in boundaries.windows(2) {
            let start = pair[0];
            let end = pair[1];
            let completed = range_contains(&state.completed_ranges, start, end);
            let forced = range_contains(&state.forced_ranges, start, end);
            if start < end && (!completed || forced) {
                let ordinal = u32::try_from(result.len()).unwrap_or(u32::MAX);
                result.push(PlanningChunk {
                    id: format!("{}:replan:{start}:{end}", chunk.id),
                    ordinal,
                    start_ms: start,
                    end_ms: end,
                    remaining_start_ms: start,
                });
            }
        }
    }
    result
}

fn range_contains(ranges: &[(u64, u64)], start: u64, end: u64) -> bool {
    ranges
        .iter()
        .any(|(range_start, range_end)| *range_start <= start && *range_end >= end)
}

fn alternatives_for(request: &PlanRequest, draft: &PlanDraft) -> Vec<PlanAlternative> {
    let codes = draft
        .unscheduled
        .iter()
        .map(|work| work.code)
        .collect::<BTreeSet<_>>();
    let mut alternatives = Vec::new();
    if codes.contains(&InfeasibilityCode::NoAllowedDays) {
        alternatives.push(PlanAlternative {
            id: "allow-weekdays".into(),
            label: "Allow Monday through Friday".into(),
            patch: AlternativePatch::AllowWeekdays {
                weekdays: vec![0, 1, 2, 3, 4],
            },
        });
    }
    if request.constraints.daily_budget_minutes < 24 * 60
        && codes.iter().any(|code| {
            matches!(
                code,
                InfeasibilityCode::DeadlineCapacity | InfeasibilityCode::HorizonCapacity
            )
        })
    {
        alternatives.push(PlanAlternative {
            id: "increase-daily-budget".into(),
            label: "Add 15 minutes per study day".into(),
            patch: AlternativePatch::IncreaseDailyBudget {
                minutes: (request.constraints.daily_budget_minutes + 15).min(24 * 60),
            },
        });
    }
    if request.constraints.playback_speed_milli < 2000
        && codes.iter().any(|code| {
            matches!(
                code,
                InfeasibilityCode::DeadlineCapacity | InfeasibilityCode::HorizonCapacity
            )
        })
    {
        let speed = (request.constraints.playback_speed_milli + 250).min(2000);
        alternatives.push(PlanAlternative {
            id: "increase-playback-speed".into(),
            label: format!("Plan at {:.2}x playback", f32::from(speed) / 1000.0),
            patch: AlternativePatch::IncreasePlaybackSpeed { speed_milli: speed },
        });
    }
    if request.constraints.horizon_days < 366
        && codes.iter().any(|code| {
            matches!(
                code,
                InfeasibilityCode::HorizonCapacity | InfeasibilityCode::DependencyUnavailable
            )
        })
    {
        alternatives.push(PlanAlternative {
            id: "extend-horizon".into(),
            label: "Extend the plan by 7 days".into(),
            patch: AlternativePatch::ExtendHorizon {
                days: (request.constraints.horizon_days + 7).min(366),
            },
        });
    }
    if codes.contains(&InfeasibilityCode::DeadlineCapacity) {
        if let Some(selection) = request
            .selections
            .iter()
            .filter(|selection| selection.deadline.is_some())
            .min_by_key(|selection| selection.deadline)
        {
            if let Some(deadline) = selection
                .deadline
                .and_then(|date| date.checked_add_signed(Duration::days(7)))
            {
                alternatives.push(PlanAlternative {
                    id: format!("move-deadline-{}", selection.media_id),
                    label: "Move the earliest deadline by 7 days".into(),
                    patch: AlternativePatch::MoveDeadline {
                        media_id: selection.media_id.clone(),
                        date: deadline,
                    },
                });
            }
        }
    }
    alternatives
}

#[cfg(test)]
mod tests {
    use super::*;
    use lectorbit_db::{MediaListItem, StoredChunk};

    fn available() -> Vec<SchedulableMedia> {
        vec![SchedulableMedia {
            media: MediaListItem {
                id: "media".into(),
                root_id: "root".into(),
                display_name: "Algorithms".into(),
                path_redacted: "[REDACTED]/Algorithms.mp4".into(),
                media_kind: "video".into(),
                size_bytes: 1,
                duration_ms: Some(60 * 60_000),
                container: None,
                video_codec: None,
                audio_codec: None,
                width: None,
                height: None,
                audio_streams: 0,
                subtitle_streams: 0,
                probe_status: "ready".into(),
                probe_error: None,
                discovered_at: "now".into(),
            },
            chunks: vec![StoredChunk {
                id: "chunk".into(),
                media_id: "media".into(),
                ordinal: 0,
                start_ms: 0,
                end_ms: 60 * 60_000,
                source: "coarse".into(),
                analyzer_version: "coarse-v1".into(),
            }],
        }]
    }

    fn request() -> PlanRequest {
        PlanRequest {
            horizon_start: NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
            constraints: PlanningConstraints::default(),
            selections: vec![PlanningSelection {
                media_id: "media".into(),
                priority: 3,
                deadline: None,
                dependencies: Vec::new(),
            }],
        }
    }

    #[test]
    fn preview_uses_only_backend_loaded_chunks() {
        let preview = build_preview(&request(), available()).unwrap();
        assert!(preview.draft.is_feasible());
        assert_eq!(preview.labels["media"], "Algorithms");
        assert!(preview
            .draft
            .items
            .iter()
            .all(|item| item.chunk_id == "chunk"));
    }

    #[test]
    fn infeasible_preview_returns_actionable_alternatives() {
        let mut request = request();
        request.constraints.horizon_days = 1;
        request.constraints.daily_budget_minutes = 10;
        request.constraints.max_continuous_minutes = 10;
        request.constraints.preferred_session_minutes = 10;
        let preview = build_preview(&request, available()).unwrap();
        assert!(!preview.draft.is_feasible());
        assert!(preview.alternatives.iter().any(|alternative| matches!(
            alternative.patch,
            AlternativePatch::ExtendHorizon { .. }
        )));
    }

    #[test]
    fn replan_subtracts_coverage_but_preserves_forced_and_split_ranges() {
        let chunks = adjusted_chunks(
            available().remove(0).chunks,
            Some(&ReplanMediaState {
                media_id: "media".into(),
                completed_ranges: vec![(0, 50 * 60_000)],
                forced_ranges: vec![(10 * 60_000, 20 * 60_000)],
                split_points: vec![15 * 60_000],
            }),
        );
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| (chunk.start_ms, chunk.end_ms))
                .collect::<Vec<_>>(),
            vec![
                (10 * 60_000, 15 * 60_000),
                (15 * 60_000, 20 * 60_000),
                (50 * 60_000, 60 * 60_000),
            ]
        );
    }
}
