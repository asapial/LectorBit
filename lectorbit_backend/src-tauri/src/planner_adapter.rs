//! Safe DTO mapping for the backend-owned planner workflow.

use chrono::NaiveDate;
use lectorbit_core::{InfeasibilityCode, PlanningConstraints};
use lectorbit_services::{
    AlternativePatch, PlanPreview, PlanRequest, PlannerService, PlannerServiceError,
    PlanningSelection,
};
use tauri_plugin_lectorbit::{
    AlternativePatchDto, BoxFuture, PlanAlternativeDto, PlanCommitResultDto, PlanDayDto,
    PlanPreviewDto, PlanPreviewItemDto, PlanRequestDto, PlannerCandidateDto,
    PlannerCandidatePageDto, PlannerErrorCode, PlannerErrorKind, PlannerOps, RoutineDayDto,
    RoutineItemDto, RoutinePlanDto, UnscheduledWorkDto,
};

#[derive(Clone)]
pub struct PlannerAdapter {
    service: PlannerService,
}

impl PlannerAdapter {
    pub fn new(service: PlannerService) -> Self {
        Self { service }
    }
}

impl PlannerOps for PlannerAdapter {
    fn list_candidates(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> BoxFuture<'_, Result<PlannerCandidatePageDto, PlannerErrorCode>> {
        Box::pin(async move {
            self.service
                .list_candidates(cursor.as_deref(), limit)
                .await
                .map(|page| PlannerCandidatePageDto {
                    items: page
                        .items
                        .into_iter()
                        .map(|item| PlannerCandidateDto {
                            media_id: item.media_id,
                            display_name: item.display_name,
                            path_redacted: item.path_redacted,
                            duration_ms: item.duration_ms,
                            chunk_count: item.chunk_count,
                        })
                        .collect(),
                    next_cursor: page.next_cursor,
                })
                .map_err(map_error)
        })
    }

    fn preview(
        &self,
        request: PlanRequestDto,
    ) -> BoxFuture<'_, Result<PlanPreviewDto, PlannerErrorCode>> {
        Box::pin(async move {
            let request = parse_request(request)?;
            self.service
                .preview(&request)
                .await
                .map(to_preview_dto)
                .map_err(map_error)
        })
    }

    fn commit(
        &self,
        title: String,
        request: PlanRequestDto,
    ) -> BoxFuture<'_, Result<PlanCommitResultDto, PlannerErrorCode>> {
        Box::pin(async move {
            let request = parse_request(request)?;
            self.service
                .commit(&title, &request)
                .await
                .map(|commit| PlanCommitResultDto {
                    plan_id: commit.plan_id,
                    plan_version_id: commit.plan_version_id,
                    created_at: commit.created_at,
                })
                .map_err(map_error)
        })
    }

    fn routine(
        &self,
        day_limit: u32,
    ) -> BoxFuture<'_, Result<Option<RoutinePlanDto>, PlannerErrorCode>> {
        Box::pin(async move {
            self.service
                .routine(day_limit)
                .await
                .map(|routine| {
                    routine.map(|plan| RoutinePlanDto {
                        plan_id: plan.plan_id,
                        plan_version_id: plan.plan_version_id,
                        title: plan.title,
                        horizon_start: plan.horizon_start,
                        horizon_end: plan.horizon_end,
                        created_at: plan.created_at,
                        days: plan
                            .days
                            .into_iter()
                            .map(|day| RoutineDayDto {
                                id: day.id,
                                date: day.date,
                                effective_content_ms: day.effective_content_ms,
                                break_ms: day.break_ms,
                                items: day
                                    .items
                                    .into_iter()
                                    .map(|item| RoutineItemDto {
                                        id: item.id,
                                        media_id: item.media_id,
                                        display_name: item.display_name,
                                        chunk_id: item.chunk_id,
                                        sequence: item.sequence,
                                        raw_start_ms: item.raw_start_ms,
                                        raw_end_ms: item.raw_end_ms,
                                        effective_duration_ms: item.effective_duration_ms,
                                        break_after_ms: item.break_after_ms,
                                        status: item.status,
                                    })
                                    .collect(),
                            })
                            .collect(),
                    })
                })
                .map_err(map_error)
        })
    }
}

fn parse_request(dto: PlanRequestDto) -> Result<PlanRequest, PlannerErrorCode> {
    let horizon_start = parse_date(&dto.horizon_start)?;
    let selections = dto
        .selections
        .into_iter()
        .map(|selection| {
            Ok(PlanningSelection {
                media_id: selection.media_id,
                priority: selection.priority,
                deadline: selection.deadline.as_deref().map(parse_date).transpose()?,
                dependencies: selection.dependencies,
            })
        })
        .collect::<Result<Vec<_>, PlannerErrorCode>>()?;
    Ok(PlanRequest {
        horizon_start,
        constraints: PlanningConstraints {
            daily_budget_minutes: dto.constraints.daily_budget_minutes,
            allowed_weekdays: dto.constraints.allowed_weekdays,
            preferred_session_minutes: dto.constraints.preferred_session_minutes,
            max_continuous_minutes: dto.constraints.max_continuous_minutes,
            minimum_break_minutes: dto.constraints.minimum_break_minutes,
            playback_speed_milli: dto.constraints.playback_speed_milli,
            horizon_days: dto.constraints.horizon_days,
        },
        selections,
    })
}

fn parse_date(value: &str) -> Result<NaiveDate, PlannerErrorCode> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        PlannerErrorCode::new(
            PlannerErrorKind::InvalidInput,
            "Dates must use the YYYY-MM-DD format.",
        )
    })
}

fn to_preview_dto(preview: PlanPreview) -> PlanPreviewDto {
    let labels = preview.labels;
    PlanPreviewDto {
        feasible: preview.draft.is_feasible(),
        horizon_start: preview.draft.horizon_start.to_string(),
        horizon_end: preview.draft.horizon_end.to_string(),
        items: preview
            .draft
            .items
            .into_iter()
            .map(|item| PlanPreviewItemDto {
                sequence: item.sequence,
                display_name: labels
                    .get(&item.media_id)
                    .cloned()
                    .unwrap_or_else(|| "Unavailable media".into()),
                media_id: item.media_id,
                chunk_id: item.chunk_id,
                scheduled_for: item.scheduled_for.to_string(),
                raw_start_ms: item.raw_start_ms,
                raw_end_ms: item.raw_end_ms,
                effective_duration_ms: item.effective_duration_ms,
                break_after_ms: item.break_after_ms,
            })
            .collect(),
        days: preview
            .draft
            .days
            .into_iter()
            .map(|day| PlanDayDto {
                date: day.date.to_string(),
                effective_content_ms: day.effective_content_ms,
                break_ms: day.break_ms,
                item_count: day.item_count,
            })
            .collect(),
        unscheduled: preview
            .draft
            .unscheduled
            .into_iter()
            .map(|work| UnscheduledWorkDto {
                display_name: labels
                    .get(&work.media_id)
                    .cloned()
                    .unwrap_or_else(|| "Unavailable media".into()),
                media_id: work.media_id,
                remaining_raw_ms: work.remaining_raw_ms,
                code: infeasibility_code(work.code).into(),
            })
            .collect(),
        alternatives: preview
            .alternatives
            .into_iter()
            .map(|alternative| PlanAlternativeDto {
                id: alternative.id,
                label: alternative.label,
                patch: match alternative.patch {
                    AlternativePatch::AllowWeekdays { weekdays } => {
                        AlternativePatchDto::AllowWeekdays { weekdays }
                    }
                    AlternativePatch::IncreaseDailyBudget { minutes } => {
                        AlternativePatchDto::IncreaseDailyBudget { minutes }
                    }
                    AlternativePatch::ExtendHorizon { days } => {
                        AlternativePatchDto::ExtendHorizon { days }
                    }
                    AlternativePatch::IncreasePlaybackSpeed { speed_milli } => {
                        AlternativePatchDto::IncreasePlaybackSpeed { speed_milli }
                    }
                    AlternativePatch::MoveDeadline { media_id, date } => {
                        AlternativePatchDto::MoveDeadline {
                            media_id,
                            date: date.to_string(),
                        }
                    }
                },
            })
            .collect(),
    }
}

fn infeasibility_code(code: InfeasibilityCode) -> &'static str {
    match code {
        InfeasibilityCode::NoAllowedDays => "no_allowed_days",
        InfeasibilityCode::DeadlineCapacity => "deadline_capacity",
        InfeasibilityCode::HorizonCapacity => "horizon_capacity",
        InfeasibilityCode::DependencyUnavailable => "dependency_unavailable",
    }
}

fn map_error(error: PlannerServiceError) -> PlannerErrorCode {
    let (kind, message) = match error {
        PlannerServiceError::EmptySelection => (
            PlannerErrorKind::InvalidInput,
            "Select at least one ready media item.",
        ),
        PlannerServiceError::SelectionLimit => (
            PlannerErrorKind::InvalidInput,
            "Select no more than 500 media items at once.",
        ),
        PlannerServiceError::DuplicateSelection => (
            PlannerErrorKind::InvalidInput,
            "Each media item can be selected once.",
        ),
        PlannerServiceError::MediaUnavailable(_) => (
            PlannerErrorKind::MediaUnavailable,
            "One of the selected media items is no longer ready.",
        ),
        PlannerServiceError::Infeasible => (
            PlannerErrorKind::Infeasible,
            "Apply an alternative before committing this plan.",
        ),
        PlannerServiceError::EmptyPlan => (
            PlannerErrorKind::InvalidInput,
            "The selected media has no remaining study work.",
        ),
        PlannerServiceError::InvalidInput(_) => (
            PlannerErrorKind::InvalidInput,
            "Review the planning constraints and try again.",
        ),
        PlannerServiceError::Database => (
            PlannerErrorKind::Database,
            "The plan could not be saved. Your current plan is unchanged.",
        ),
    };
    PlannerErrorCode::new(kind, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_lectorbit::{PlanningConstraintsDto, PlanningSelectionDto};

    #[test]
    fn request_parser_rejects_non_iso_dates() {
        let error = parse_request(PlanRequestDto {
            horizon_start: "tomorrow".into(),
            constraints: PlanningConstraintsDto {
                daily_budget_minutes: 45,
                allowed_weekdays: vec![0],
                preferred_session_minutes: 25,
                max_continuous_minutes: 30,
                minimum_break_minutes: 5,
                playback_speed_milli: 1000,
                horizon_days: 14,
            },
            selections: vec![PlanningSelectionDto {
                media_id: "media".into(),
                priority: 3,
                deadline: None,
                dependencies: Vec::new(),
            }],
        })
        .unwrap_err();
        assert_eq!(error.kind, PlannerErrorKind::InvalidInput);
    }
}
