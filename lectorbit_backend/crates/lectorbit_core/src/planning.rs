//! Pure, deterministic chunking and study-plan invariants.
//!
//! This module owns no I/O. The same frozen input always produces the same
//! draft, so persistence and UI layers can safely preview before committing an
//! immutable plan version.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const COARSE_CHUNK_VERSION: &str = "coarse-v1";
pub const COARSE_TARGET_MS: u64 = 25 * 60_000;
pub const COARSE_MIN_MS: u64 = 20 * 60_000;
pub const COARSE_MAX_MS: u64 = 30 * 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoarseChunk {
    pub id: String,
    pub media_id: String,
    pub ordinal: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub source: String,
    pub analyzer_version: String,
}

/// Split a duration into balanced, contiguous windows near 25 minutes.
///
/// Balancing avoids tiny tail chunks while keeping every chunk at or below 30
/// minutes. Durations below 30 minutes remain a single schedulable chunk.
pub fn derive_coarse_chunks(media_id: &str, duration_ms: u64) -> Vec<CoarseChunk> {
    if duration_ms == 0 {
        return Vec::new();
    }

    let chunk_count = if duration_ms <= COARSE_MAX_MS {
        1
    } else {
        let minimum_count = duration_ms.div_ceil(COARSE_MAX_MS);
        let maximum_count = duration_ms / COARSE_MIN_MS;
        let target_count = (duration_ms + (COARSE_TARGET_MS / 2)) / COARSE_TARGET_MS;
        if maximum_count >= minimum_count {
            target_count.clamp(minimum_count, maximum_count)
        } else {
            minimum_count
        }
    };

    let base_ms = duration_ms / chunk_count;
    let remainder = duration_ms % chunk_count;
    let mut cursor = 0_u64;
    (0..chunk_count)
        .map(|ordinal| {
            let length = base_ms + if ordinal < remainder { 1 } else { 0 };
            let end_ms = cursor + length;
            let chunk = CoarseChunk {
                id: format!("{media_id}:coarse:{ordinal}"),
                media_id: media_id.to_string(),
                ordinal: u32::try_from(ordinal).unwrap_or(u32::MAX),
                start_ms: cursor,
                end_ms,
                source: "coarse".to_string(),
                analyzer_version: COARSE_CHUNK_VERSION.to_string(),
            };
            cursor = end_ms;
            chunk
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanningConstraints {
    pub daily_budget_minutes: u32,
    /// ISO weekday numbers: Monday = 0, Sunday = 6.
    pub allowed_weekdays: Vec<u8>,
    pub preferred_session_minutes: u32,
    pub max_continuous_minutes: u32,
    pub minimum_break_minutes: u32,
    /// Fixed-point playback speed: 1000 = 1.0x, 1500 = 1.5x.
    pub playback_speed_milli: u16,
    pub horizon_days: u16,
}

impl Default for PlanningConstraints {
    fn default() -> Self {
        Self {
            daily_budget_minutes: 45,
            allowed_weekdays: vec![0, 1, 2, 3, 4, 5, 6],
            preferred_session_minutes: 25,
            max_continuous_minutes: 30,
            minimum_break_minutes: 5,
            playback_speed_milli: 1000,
            horizon_days: 14,
        }
    }
}

impl PlanningConstraints {
    pub fn validate(&self) -> Result<(), PlanningError> {
        if !(1..=24 * 60).contains(&self.daily_budget_minutes) {
            return Err(PlanningError::InvalidConstraint(
                "daily budget must be between 1 and 1440 minutes",
            ));
        }
        if !(1..=8 * 60).contains(&self.preferred_session_minutes) {
            return Err(PlanningError::InvalidConstraint(
                "preferred session must be between 1 and 480 minutes",
            ));
        }
        if !(1..=8 * 60).contains(&self.max_continuous_minutes) {
            return Err(PlanningError::InvalidConstraint(
                "maximum continuous block must be between 1 and 480 minutes",
            ));
        }
        if self.max_continuous_minutes > self.daily_budget_minutes {
            return Err(PlanningError::InvalidConstraint(
                "maximum continuous block cannot exceed the daily budget",
            ));
        }
        if self.minimum_break_minutes > 120 {
            return Err(PlanningError::InvalidConstraint(
                "minimum break cannot exceed 120 minutes",
            ));
        }
        if !(500..=2000).contains(&self.playback_speed_milli) {
            return Err(PlanningError::InvalidConstraint(
                "playback speed must be between 0.5x and 2.0x",
            ));
        }
        if !(1..=366).contains(&self.horizon_days) {
            return Err(PlanningError::InvalidConstraint(
                "planning horizon must be between 1 and 366 days",
            ));
        }
        let weekdays = self
            .allowed_weekdays
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if weekdays.len() != self.allowed_weekdays.len()
            || weekdays.iter().any(|weekday| *weekday > 6)
        {
            return Err(PlanningError::InvalidConstraint(
                "allowed weekdays must be a unique subset of 0 through 6",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanningChunk {
    pub id: String,
    pub ordinal: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    /// First raw timestamp that still needs study. It must be inside the chunk.
    pub remaining_start_ms: u64,
}

impl From<CoarseChunk> for PlanningChunk {
    fn from(chunk: CoarseChunk) -> Self {
        Self {
            id: chunk.id,
            ordinal: chunk.ordinal,
            start_ms: chunk.start_ms,
            end_ms: chunk.end_ms,
            remaining_start_ms: chunk.start_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaWork {
    pub media_id: String,
    /// 1 (low) through 5 (critical).
    pub priority: u8,
    pub deadline: Option<NaiveDate>,
    /// Every listed media item must be fully scheduled first.
    pub dependencies: Vec<String>,
    pub chunks: Vec<PlanningChunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledItem {
    pub sequence: u32,
    pub media_id: String,
    pub chunk_id: String,
    pub scheduled_for: NaiveDate,
    pub raw_start_ms: u64,
    pub raw_end_ms: u64,
    pub effective_duration_ms: u64,
    pub break_after_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DayLoad {
    pub date: NaiveDate,
    pub effective_content_ms: u64,
    pub break_ms: u64,
    pub item_count: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum InfeasibilityCode {
    NoAllowedDays,
    DeadlineCapacity,
    HorizonCapacity,
    DependencyUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnscheduledWork {
    pub media_id: String,
    pub remaining_raw_ms: u64,
    pub code: InfeasibilityCode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanDraft {
    pub horizon_start: NaiveDate,
    pub horizon_end: NaiveDate,
    pub items: Vec<ScheduledItem>,
    pub days: Vec<DayLoad>,
    pub unscheduled: Vec<UnscheduledWork>,
}

impl PlanDraft {
    pub fn is_feasible(&self) -> bool {
        self.unscheduled.is_empty()
    }
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum PlanningError {
    #[error("invalid planning constraint: {0}")]
    InvalidConstraint(&'static str),
    #[error("duplicate media ID: {0}")]
    DuplicateMedia(String),
    #[error("media {media_id} references missing dependency {dependency_id}")]
    MissingDependency {
        media_id: String,
        dependency_id: String,
    },
    #[error("media dependency graph contains a cycle")]
    DependencyCycle,
    #[error("invalid chunks for media {0}")]
    InvalidChunks(String),
    #[error("invalid priority for media {0}; expected 1 through 5")]
    InvalidPriority(String),
    #[error("planning horizon overflow")]
    HorizonOverflow,
}

pub fn build_plan(
    horizon_start: NaiveDate,
    constraints: &PlanningConstraints,
    media: &[MediaWork],
) -> Result<PlanDraft, PlanningError> {
    constraints.validate()?;
    let horizon_end = horizon_start
        .checked_add_signed(Duration::days(i64::from(constraints.horizon_days) - 1))
        .ok_or(PlanningError::HorizonOverflow)?;
    let ordered = validate_and_order(media)?;
    let daily_budget_ms = u64::from(constraints.daily_budget_minutes) * 60_000;
    let session_cap_ms = u64::from(
        constraints
            .preferred_session_minutes
            .min(constraints.max_continuous_minutes),
    ) * 60_000;
    let minimum_break_ms = u64::from(constraints.minimum_break_minutes) * 60_000;
    let allowed = constraints
        .allowed_weekdays
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let minimum_slot_ms = effective_duration_ms(1, constraints.playback_speed_milli);
    let mut used_by_day = BTreeMap::<NaiveDate, u64>::new();
    let mut items = Vec::<ScheduledItem>::new();
    let mut unscheduled = Vec::new();
    let mut fully_scheduled = BTreeSet::<String>::new();
    let mut completed_on = BTreeMap::<String, NaiveDate>::new();

    for work in ordered {
        let remaining_total = remaining_raw_ms(work);
        if work
            .dependencies
            .iter()
            .any(|dependency| !fully_scheduled.contains(dependency))
        {
            if remaining_total > 0 {
                unscheduled.push(UnscheduledWork {
                    media_id: work.media_id.clone(),
                    remaining_raw_ms: remaining_total,
                    code: InfeasibilityCode::DependencyUnavailable,
                });
            }
            continue;
        }
        if remaining_total == 0 {
            fully_scheduled.insert(work.media_id.clone());
            completed_on.insert(work.media_id.clone(), horizon_start);
            continue;
        }
        if allowed.is_empty() {
            unscheduled.push(UnscheduledWork {
                media_id: work.media_id.clone(),
                remaining_raw_ms: remaining_total,
                code: InfeasibilityCode::NoAllowedDays,
            });
            continue;
        }

        let last_date = work
            .deadline
            .map_or(horizon_end, |deadline| deadline.min(horizon_end));
        let mut cursor_date = work
            .dependencies
            .iter()
            .filter_map(|dependency| completed_on.get(dependency))
            .copied()
            .max()
            .unwrap_or(horizon_start);
        let mut work_completed_on = cursor_date;
        let mut work_complete = true;
        let mut chunks = work.chunks.iter().collect::<Vec<_>>();
        chunks.sort_by_key(|chunk| chunk.ordinal);

        for (chunk_position, chunk) in chunks.iter().enumerate() {
            let mut raw_cursor = chunk.remaining_start_ms;
            while raw_cursor < chunk.end_ms {
                let Some(date) = next_day_with_capacity(
                    cursor_date,
                    last_date,
                    &allowed,
                    &used_by_day,
                    daily_budget_ms,
                    minimum_slot_ms,
                ) else {
                    let remainder = chunk.end_ms - raw_cursor
                        + chunks[(chunk_position + 1)..]
                            .iter()
                            .map(|later| later.end_ms - later.remaining_start_ms)
                            .sum::<u64>();
                    let code = match work.deadline {
                        Some(deadline) if deadline <= horizon_end => {
                            InfeasibilityCode::DeadlineCapacity
                        }
                        _ => InfeasibilityCode::HorizonCapacity,
                    };
                    unscheduled.push(UnscheduledWork {
                        media_id: work.media_id.clone(),
                        remaining_raw_ms: remainder,
                        code,
                    });
                    work_complete = false;
                    break;
                };

                let used_ms = used_by_day.get(&date).copied().unwrap_or_default();
                let available_ms = daily_budget_ms - used_ms;
                let effective_cap_ms = session_cap_ms.min(available_ms);
                let raw_cap_ms =
                    raw_for_effective(effective_cap_ms, constraints.playback_speed_milli);
                let raw_end = raw_cursor
                    .saturating_add(raw_cap_ms.max(1))
                    .min(chunk.end_ms);
                let effective_ms =
                    effective_duration_ms(raw_end - raw_cursor, constraints.playback_speed_milli);
                debug_assert!(effective_ms <= effective_cap_ms);
                used_by_day.insert(date, used_ms + effective_ms);
                items.push(ScheduledItem {
                    sequence: 0,
                    media_id: work.media_id.clone(),
                    chunk_id: chunk.id.clone(),
                    scheduled_for: date,
                    raw_start_ms: raw_cursor,
                    raw_end_ms: raw_end,
                    effective_duration_ms: effective_ms,
                    break_after_ms: minimum_break_ms,
                });
                raw_cursor = raw_end;
                cursor_date = date;
                work_completed_on = date;
            }
            if !work_complete {
                break;
            }
        }
        if work_complete {
            fully_scheduled.insert(work.media_id.clone());
            completed_on.insert(work.media_id.clone(), work_completed_on);
        }
    }

    // Stable date sort preserves dependency/priority insertion order within a day.
    items.sort_by_key(|item| item.scheduled_for);
    for index in 0..items.len() {
        let is_last_for_day = index + 1 == items.len()
            || items[index + 1].scheduled_for != items[index].scheduled_for;
        let item = &mut items[index];
        item.sequence = u32::try_from(index).unwrap_or(u32::MAX);
        if is_last_for_day {
            item.break_after_ms = 0;
        }
    }

    let mut days = Vec::new();
    for date in used_by_day.keys() {
        let day_items = items
            .iter()
            .filter(|item| item.scheduled_for == *date)
            .collect::<Vec<_>>();
        days.push(DayLoad {
            date: *date,
            effective_content_ms: day_items
                .iter()
                .map(|item| item.effective_duration_ms)
                .sum(),
            break_ms: day_items.iter().map(|item| item.break_after_ms).sum(),
            item_count: u32::try_from(day_items.len()).unwrap_or(u32::MAX),
        });
    }

    Ok(PlanDraft {
        horizon_start,
        horizon_end,
        items,
        days,
        unscheduled,
    })
}

fn validate_and_order(media: &[MediaWork]) -> Result<Vec<&MediaWork>, PlanningError> {
    let mut by_id = BTreeMap::<&str, &MediaWork>::new();
    for work in media {
        if by_id.insert(&work.media_id, work).is_some() {
            return Err(PlanningError::DuplicateMedia(work.media_id.clone()));
        }
        if !(1..=5).contains(&work.priority) {
            return Err(PlanningError::InvalidPriority(work.media_id.clone()));
        }
        if !valid_chunks(&work.chunks) {
            return Err(PlanningError::InvalidChunks(work.media_id.clone()));
        }
    }
    for work in media {
        for dependency in &work.dependencies {
            if !by_id.contains_key(dependency.as_str()) {
                return Err(PlanningError::MissingDependency {
                    media_id: work.media_id.clone(),
                    dependency_id: dependency.clone(),
                });
            }
        }
    }

    let mut completed = BTreeSet::<&str>::new();
    let mut ordered = Vec::with_capacity(media.len());
    while ordered.len() < media.len() {
        let mut ready = media
            .iter()
            .filter(|work| !completed.contains(work.media_id.as_str()))
            .filter(|work| {
                work.dependencies
                    .iter()
                    .all(|dependency| completed.contains(dependency.as_str()))
            })
            .collect::<Vec<_>>();
        if ready.is_empty() {
            return Err(PlanningError::DependencyCycle);
        }
        ready.sort_by_key(|work| {
            (
                work.deadline.unwrap_or(NaiveDate::MAX),
                Reverse(work.priority),
                work.media_id.as_str(),
            )
        });
        let next = ready[0];
        completed.insert(next.media_id.as_str());
        ordered.push(next);
    }
    Ok(ordered)
}

fn valid_chunks(chunks: &[PlanningChunk]) -> bool {
    let mut ordered = chunks.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|chunk| chunk.ordinal);
    let mut ids = BTreeSet::new();
    let mut ordinals = BTreeSet::new();
    let mut prior_end = None;
    for chunk in ordered {
        if !ids.insert(chunk.id.as_str())
            || !ordinals.insert(chunk.ordinal)
            || chunk.start_ms >= chunk.end_ms
            || !(chunk.start_ms..=chunk.end_ms).contains(&chunk.remaining_start_ms)
            || prior_end.is_some_and(|end| chunk.start_ms < end)
        {
            return false;
        }
        prior_end = Some(chunk.end_ms);
    }
    true
}

fn remaining_raw_ms(work: &MediaWork) -> u64 {
    work.chunks
        .iter()
        .map(|chunk| chunk.end_ms.saturating_sub(chunk.remaining_start_ms))
        .sum()
}

fn next_day_with_capacity(
    start: NaiveDate,
    end: NaiveDate,
    allowed: &BTreeSet<u8>,
    used_by_day: &BTreeMap<NaiveDate, u64>,
    daily_budget_ms: u64,
    minimum_slot_ms: u64,
) -> Option<NaiveDate> {
    let mut date = start;
    while date <= end {
        let weekday = date.weekday().num_days_from_monday() as u8;
        let used_ms = used_by_day.get(&date).copied().unwrap_or_default();
        if allowed.contains(&weekday) && daily_budget_ms.saturating_sub(used_ms) >= minimum_slot_ms
        {
            return Some(date);
        }
        date = date.checked_add_signed(Duration::days(1))?;
    }
    None
}

pub fn effective_duration_ms(raw_duration_ms: u64, playback_speed_milli: u16) -> u64 {
    let numerator = u128::from(raw_duration_ms) * 1000;
    let speed = u128::from(playback_speed_milli.max(1));
    u64::try_from(numerator.div_ceil(speed)).unwrap_or(u64::MAX)
}

fn raw_for_effective(effective_ms: u64, playback_speed_milli: u16) -> u64 {
    let raw = u128::from(effective_ms) * u128::from(playback_speed_milli) / 1000;
    u64::try_from(raw).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(media_id: &str, minutes: u64) -> MediaWork {
        MediaWork {
            media_id: media_id.to_string(),
            priority: 3,
            deadline: None,
            dependencies: Vec::new(),
            chunks: derive_coarse_chunks(media_id, minutes * 60_000)
                .into_iter()
                .map(PlanningChunk::from)
                .collect(),
        }
    }

    #[test]
    fn coarse_chunks_are_contiguous_balanced_and_deterministic() {
        for minutes in (1_u64..=48 * 60).step_by(7) {
            let duration = minutes * 60_000 + 137;
            let first = derive_coarse_chunks("media", duration);
            let second = derive_coarse_chunks("media", duration);
            assert_eq!(first, second);
            assert_eq!(first.first().map(|chunk| chunk.start_ms), Some(0));
            assert_eq!(first.last().map(|chunk| chunk.end_ms), Some(duration));
            for pair in first.windows(2) {
                assert_eq!(pair[0].end_ms, pair[1].start_ms);
            }
            assert!(first.iter().all(|chunk| {
                chunk.start_ms < chunk.end_ms && chunk.end_ms - chunk.start_ms <= COARSE_MAX_MS
            }));
            let shortest = first
                .iter()
                .map(|chunk| chunk.end_ms - chunk.start_ms)
                .min()
                .unwrap();
            let longest = first
                .iter()
                .map(|chunk| chunk.end_ms - chunk.start_ms)
                .max()
                .unwrap();
            assert!(longest - shortest <= 1);
        }
    }

    #[test]
    fn planner_golden_output_is_stable_for_unordered_input() {
        let date = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let constraints = PlanningConstraints {
            daily_budget_minutes: 50,
            horizon_days: 2,
            ..PlanningConstraints::default()
        };
        let a = work("a", 50);
        let mut b = work("b", 25);
        b.priority = 5;
        let first = build_plan(date, &constraints, &[a.clone(), b.clone()]).unwrap();
        let second = build_plan(date, &constraints, &[b, a]).unwrap();
        assert_eq!(first, second);
        let golden = first
            .items
            .iter()
            .map(|item| {
                (
                    item.media_id.as_str(),
                    item.scheduled_for,
                    item.raw_start_ms,
                    item.raw_end_ms,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            golden,
            vec![
                ("b", date, 0, 25 * 60_000),
                ("a", date, 0, 25 * 60_000),
                ("a", date.succ_opt().unwrap(), 25 * 60_000, 50 * 60_000),
            ]
        );
    }

    #[test]
    fn hard_invariants_hold_across_budgets_and_speeds() {
        let start = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        for daily_minutes in [20, 30, 45, 90] {
            for speed in [500, 1000, 1250, 2000] {
                let constraints = PlanningConstraints {
                    daily_budget_minutes: daily_minutes,
                    preferred_session_minutes: 20.min(daily_minutes),
                    max_continuous_minutes: 20.min(daily_minutes),
                    playback_speed_milli: speed,
                    horizon_days: 60,
                    allowed_weekdays: vec![0, 2, 4],
                    ..PlanningConstraints::default()
                };
                let draft = build_plan(start, &constraints, &[work("course", 180)]).unwrap();
                assert!(draft.is_feasible());
                for day in &draft.days {
                    assert!(day.effective_content_ms <= u64::from(daily_minutes) * 60_000);
                    assert!([0, 2, 4].contains(&(day.date.weekday().num_days_from_monday() as u8)));
                }
                for item in &draft.items {
                    assert!(
                        item.effective_duration_ms <= u64::from(20.min(daily_minutes)) * 60_000
                    );
                    assert_eq!(
                        item.effective_duration_ms,
                        effective_duration_ms(item.raw_end_ms - item.raw_start_ms, speed)
                    );
                }
            }
        }
    }

    #[test]
    fn dependencies_are_scheduled_in_order() {
        let start = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let a = work("foundation", 75);
        let mut b = work("advanced", 25);
        b.priority = 5;
        b.dependencies = vec![a.media_id.clone()];
        let draft = build_plan(start, &PlanningConstraints::default(), &[b, a]).unwrap();
        let foundation = draft
            .items
            .iter()
            .position(|item| item.media_id == "foundation")
            .unwrap();
        let advanced = draft
            .items
            .iter()
            .position(|item| item.media_id == "advanced")
            .unwrap();
        assert!(foundation < advanced);
        let foundation_completed = draft
            .items
            .iter()
            .filter(|item| item.media_id == "foundation")
            .map(|item| item.scheduled_for)
            .max()
            .unwrap();
        let advanced_started = draft
            .items
            .iter()
            .filter(|item| item.media_id == "advanced")
            .map(|item| item.scheduled_for)
            .min()
            .unwrap();
        assert!(advanced_started >= foundation_completed);
    }

    #[test]
    fn remaining_duration_is_speed_adjusted() {
        let start = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let mut media = work("partial", 20);
        media.chunks[0].remaining_start_ms = 10 * 60_000;
        let constraints = PlanningConstraints {
            playback_speed_milli: 2000,
            ..PlanningConstraints::default()
        };
        let draft = build_plan(start, &constraints, &[media]).unwrap();
        assert_eq!(draft.items.len(), 1);
        assert_eq!(draft.items[0].effective_duration_ms, 5 * 60_000);
    }

    #[test]
    fn deadline_capacity_is_reported_without_violating_the_deadline() {
        let start = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let mut media = work("urgent", 90);
        media.deadline = Some(start);
        let constraints = PlanningConstraints {
            daily_budget_minutes: 30,
            max_continuous_minutes: 30,
            horizon_days: 7,
            ..PlanningConstraints::default()
        };
        let draft = build_plan(start, &constraints, &[media]).unwrap();
        assert!(!draft.is_feasible());
        assert_eq!(
            draft.unscheduled[0].code,
            InfeasibilityCode::DeadlineCapacity
        );
        assert!(draft.items.iter().all(|item| item.scheduled_for <= start));
    }

    #[test]
    fn dependency_cycles_are_rejected() {
        let mut a = work("a", 25);
        let mut b = work("b", 25);
        a.dependencies = vec!["b".to_string()];
        b.dependencies = vec!["a".to_string()];
        let error = build_plan(
            NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
            &PlanningConstraints::default(),
            &[a, b],
        )
        .unwrap_err();
        assert_eq!(error, PlanningError::DependencyCycle);
    }
}
