import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const PlannerCandidateSchema = z.object({
  media_id: z.string().min(1),
  display_name: z.string().min(1),
  path_redacted: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
});

const PlannerCandidatePageSchema = z.object({
  items: z.array(PlannerCandidateSchema),
  next_cursor: z.string().nullable(),
});

export const PlanningConstraintsSchema = z.object({
  daily_budget_minutes: z.number().int().min(1).max(1440),
  allowed_weekdays: z.array(z.number().int().min(0).max(6)),
  preferred_session_minutes: z.number().int().min(1).max(480),
  max_continuous_minutes: z.number().int().min(1).max(480),
  minimum_break_minutes: z.number().int().min(0).max(120),
  playback_speed_milli: z.number().int().min(500).max(2000),
  horizon_days: z.number().int().min(1).max(366),
});

const PlanningSelectionSchema = z.object({
  media_id: z.string().min(1),
  priority: z.number().int().min(1).max(5),
  deadline: z.string().nullable(),
  dependencies: z.array(z.string()),
});

export const PlanRequestSchema = z.object({
  horizon_start: z.iso.date(),
  constraints: PlanningConstraintsSchema,
  selections: z.array(PlanningSelectionSchema).max(500),
});

const PlanTitleSchema = z.string().trim().min(1).max(80);

const PlanPreviewItemSchema = z.object({
  sequence: z.number().int().nonnegative(),
  media_id: z.string(),
  display_name: z.string(),
  chunk_id: z.string(),
  scheduled_for: z.iso.date(),
  raw_start_ms: z.number().int().nonnegative(),
  raw_end_ms: z.number().int().positive(),
  effective_duration_ms: z.number().int().positive(),
  break_after_ms: z.number().int().nonnegative(),
});

const PlanDaySchema = z.object({
  date: z.iso.date(),
  effective_content_ms: z.number().int().nonnegative(),
  break_ms: z.number().int().nonnegative(),
  item_count: z.number().int().nonnegative(),
});

const UnscheduledWorkSchema = z.object({
  media_id: z.string(),
  display_name: z.string(),
  remaining_raw_ms: z.number().int().positive(),
  code: z.enum([
    'no_allowed_days',
    'deadline_capacity',
    'horizon_capacity',
    'dependency_unavailable',
  ]),
});

const AlternativePatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('allow_weekdays'),
    weekdays: z.array(z.number().int().min(0).max(6)),
  }),
  z.object({
    kind: z.literal('increase_daily_budget'),
    minutes: z.number().int().min(1).max(1440),
  }),
  z.object({
    kind: z.literal('extend_horizon'),
    days: z.number().int().min(1).max(366),
  }),
  z.object({
    kind: z.literal('increase_playback_speed'),
    speed_milli: z.number().int().min(500).max(2000),
  }),
  z.object({
    kind: z.literal('move_deadline'),
    media_id: z.string(),
    date: z.iso.date(),
  }),
]);

const PlanAlternativeSchema = z.object({
  id: z.string(),
  label: z.string(),
  patch: AlternativePatchSchema,
});

const PlanPreviewSchema = z.object({
  feasible: z.boolean(),
  horizon_start: z.iso.date(),
  horizon_end: z.iso.date(),
  items: z.array(PlanPreviewItemSchema),
  days: z.array(PlanDaySchema),
  unscheduled: z.array(UnscheduledWorkSchema),
  alternatives: z.array(PlanAlternativeSchema),
});

const PlanCommitResultSchema = z.object({
  plan_id: z.string().min(1),
  plan_version_id: z.string().min(1),
  created_at: z.string().min(1),
});

const RoutineItemSchema = z.object({
  id: z.string().min(1),
  media_id: z.string().min(1),
  display_name: z.string().min(1),
  chunk_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  raw_start_ms: z.number().int().nonnegative(),
  raw_end_ms: z.number().int().positive(),
  effective_duration_ms: z.number().int().positive(),
  break_after_ms: z.number().int().nonnegative(),
  status: z.enum(['pending', 'in_progress', 'done', 'skipped', 'postponed']),
});

const RoutineDaySchema = z.object({
  id: z.string().min(1),
  date: z.iso.date(),
  effective_content_ms: z.number().int().nonnegative(),
  break_ms: z.number().int().nonnegative(),
  items: z.array(RoutineItemSchema),
});

const RoutinePlanSchema = z.object({
  plan_id: z.string().min(1),
  plan_version_id: z.string().min(1),
  title: z.string().min(1),
  horizon_start: z.iso.date(),
  horizon_end: z.iso.date(),
  created_at: z.string().min(1),
  days: z.array(RoutineDaySchema),
});

const PlannerErrorSchema = z.object({
  kind: z.enum(['invalid_input', 'media_unavailable', 'infeasible', 'database', 'internal']),
  message: z.string(),
});

const CloudPlanningStatusSchema = z.object({
  configured: z.boolean(),
  provider: z.string().min(1),
  model: z.string().min(1),
});

const AiPlanSuggestionSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(600),
  model: z.string().min(1),
  items: z.array(
    z.object({
      media_id: z.string().min(1),
      priority: z.number().int().min(1).max(5),
      dependencies: z.array(z.string().min(1)),
      reason: z.string().min(1).max(300),
    }),
  ),
});

const CloudPlanningErrorSchema = z.object({
  kind: z.enum([
    'invalid_input',
    'consent_required',
    'not_configured',
    'credential_store',
    'provider',
    'invalid_response',
    'internal',
  ]),
  message: z.string(),
});

export type PlannerCandidate = z.infer<typeof PlannerCandidateSchema>;
export type PlannerCandidatePage = z.infer<typeof PlannerCandidatePageSchema>;
export type PlanningConstraints = z.infer<typeof PlanningConstraintsSchema>;
export type PlanningSelection = z.infer<typeof PlanningSelectionSchema>;
export type PlanRequest = z.infer<typeof PlanRequestSchema>;
export type PlanPreview = z.infer<typeof PlanPreviewSchema>;
export type PlanAlternative = z.infer<typeof PlanAlternativeSchema>;
export type AlternativePatch = z.infer<typeof AlternativePatchSchema>;
export type PlanCommitResult = z.infer<typeof PlanCommitResultSchema>;
export type RoutinePlan = z.infer<typeof RoutinePlanSchema>;
export type CloudPlanningStatus = z.infer<typeof CloudPlanningStatusSchema>;
export type AiPlanSuggestion = z.infer<typeof AiPlanSuggestionSchema>;

export class PlannerRpcError extends Error {
  readonly kind: z.infer<typeof PlannerErrorSchema>['kind'];

  constructor(kind: z.infer<typeof PlannerErrorSchema>['kind'], message: string) {
    super(message);
    this.name = 'PlannerRpcError';
    this.kind = kind;
  }
}

export async function listPlanningCandidates(options?: {
  cursor?: string;
  limit?: number;
}): Promise<PlannerCandidatePage> {
  return call(
    'planner_list_candidates',
    {
      args: {
        cursor: options?.cursor ?? null,
        limit: options?.limit ?? 100,
      },
    },
    PlannerCandidatePageSchema,
  );
}

export async function previewPlan(request: PlanRequest): Promise<PlanPreview> {
  const validated = PlanRequestSchema.parse(request);
  return call('planner_preview', { args: { request: validated } }, PlanPreviewSchema);
}

export async function commitPlan(title: string, request: PlanRequest): Promise<PlanCommitResult> {
  const validatedTitle = PlanTitleSchema.parse(title);
  const validated = PlanRequestSchema.parse(request);
  return call(
    'plan_commit',
    { args: { title: validatedTitle, request: validated } },
    PlanCommitResultSchema,
  );
}

export async function getRoutine(dayLimit = 14): Promise<RoutinePlan | null> {
  return call('plan_get_routine', { args: { day_limit: dayLimit } }, RoutinePlanSchema.nullable());
}

export async function replanActive(horizonStart: string): Promise<PlanCommitResult> {
  const validatedStart = z.iso.date().parse(horizonStart);
  return call('plan_replan', { args: { horizon_start: validatedStart } }, PlanCommitResultSchema);
}

export async function getCloudPlanningStatus(): Promise<CloudPlanningStatus> {
  return cloudCall('cloud_planning_get_status', undefined, CloudPlanningStatusSchema);
}

export async function saveOpenRouterKey(apiKey: string): Promise<CloudPlanningStatus> {
  const key = z.string().trim().min(20).max(512).parse(apiKey);
  return cloudCall(
    'cloud_planning_save_key',
    { args: { api_key: key } },
    CloudPlanningStatusSchema,
  );
}

export async function removeOpenRouterKey(): Promise<void> {
  return cloudCall(
    'cloud_planning_remove_key',
    undefined,
    z.null().transform(() => undefined),
  );
}

export async function suggestPlanWithAi(
  candidateIds: string[],
  constraints: PlanningConstraints,
  consent: boolean,
): Promise<AiPlanSuggestion> {
  return cloudCall(
    'cloud_planning_suggest',
    {
      args: {
        candidate_ids: z.array(z.string().min(1)).min(1).max(200).parse(candidateIds),
        constraints: PlanningConstraintsSchema.parse(constraints),
        consent,
      },
    },
    AiPlanSuggestionSchema,
  );
}

async function call<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await invoke<unknown>(`plugin:lectorbit|${command}`, args).then(
    (value) => value,
    (error: unknown) => {
      throw wrapPlannerError(error);
    },
  );
  return schema.parse(raw);
}

function wrapPlannerError(error: unknown): PlannerRpcError {
  if (!(error instanceof Error)) {
    const parsed = PlannerErrorSchema.safeParse(error);
    if (parsed.success) {
      return new PlannerRpcError(parsed.data.kind, parsed.data.message);
    }
  }
  return new PlannerRpcError('internal', 'The planner service is unavailable.');
}

async function cloudCall<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await invoke<unknown>(`plugin:lectorbit|${command}`, args).then(
    (value) => value,
    (error: unknown) => {
      if (!(error instanceof Error)) {
        const parsed = CloudPlanningErrorSchema.safeParse(error);
        if (parsed.success) throw new Error(parsed.data.message);
      }
      throw new Error('Cloud planning is unavailable.');
    },
  );
  return schema.parse(raw);
}
