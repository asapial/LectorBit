import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  commitPlan,
  CloudPlanningRpcError,
  getCloudPlanningStatus,
  getRoutine,
  listPlanningCandidates,
  previewPlan,
  replanActive,
  suggestPlanWithAi,
  type PlanRequest,
} from './planner';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const request: PlanRequest = {
  horizon_start: '2026-08-10',
  constraints: {
    daily_budget_minutes: 45,
    allowed_weekdays: [0, 1, 2, 3, 4],
    preferred_session_minutes: 25,
    max_continuous_minutes: 30,
    minimum_break_minutes: 5,
    playback_speed_milli: 1000,
    horizon_days: 14,
  },
  selections: [{ media_id: 'media', priority: 3, deadline: null, dependencies: [] }],
};

describe('ipc/planner', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('parses renderer-safe planning candidates', async () => {
    vi.mocked(invoke).mockResolvedValue({
      items: [
        {
          media_id: 'media',
          module_id: 'algorithms',
          module_name: 'Algorithms course',
          display_name: 'Algorithms',
          path_redacted: '[REDACTED]/Algorithms course/Algorithms.mp4',
          duration_ms: 3_600_000,
          chunk_count: 3,
        },
      ],
      next_cursor: 'media',
    });
    const candidates = await listPlanningCandidates();
    expect(candidates.items[0].path_redacted).toContain('[REDACTED]');
    expect(candidates.next_cursor).toBe('media');
    expect(JSON.stringify(candidates)).not.toContain('C:\\');
  });

  it('requests a paginated candidate page scoped to one folder module', async () => {
    vi.mocked(invoke).mockResolvedValue({ items: [], next_cursor: null });

    await listPlanningCandidates({ moduleId: 'module-b', cursor: 'media-20', limit: 20 });

    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|planner_list_candidates', {
      args: { module_id: 'module-b', cursor: 'media-20', limit: 20 },
    });
  });

  it('sends a typed preview request and parses alternatives', async () => {
    vi.mocked(invoke).mockResolvedValue({
      feasible: false,
      horizon_start: '2026-08-10',
      horizon_end: '2026-08-23',
      items: [],
      days: [],
      unscheduled: [
        {
          media_id: 'media',
          display_name: 'Algorithms',
          remaining_raw_ms: 3_600_000,
          code: 'horizon_capacity',
        },
      ],
      alternatives: [
        {
          id: 'extend',
          label: 'Extend by 7 days',
          patch: { kind: 'extend_horizon', days: 21 },
        },
      ],
    });
    const preview = await previewPlan(request);
    expect(preview.alternatives[0].patch.kind).toBe('extend_horizon');
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|planner_preview', { args: { request } });
  });

  it('commits by intent without sending renderer-authored plan items', async () => {
    vi.mocked(invoke).mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version',
      created_at: '2026-08-10T00:00:00Z',
    });
    await commitPlan('My plan', request);
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|plan_commit', {
      args: { title: 'My plan', request },
    });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls[0]?.[1])).not.toContain('raw_start_ms');
  });

  it('rejects an invalid title before crossing IPC', async () => {
    await expect(commitPlan('   ', request)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('parses the immutable active routine', async () => {
    vi.mocked(invoke).mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version',
      title: 'My plan',
      horizon_start: '2026-08-10',
      horizon_end: '2026-08-23',
      created_at: '2026-08-10T00:00:00Z',
      days: [],
    });
    expect((await getRoutine())?.plan_version_id).toBe('version');
  });

  it('replans from a validated local date without renderer-authored items', async () => {
    vi.mocked(invoke).mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version-2',
      created_at: '2026-08-12T00:00:00Z',
    });
    await expect(replanActive('2026-08-12')).resolves.toMatchObject({
      plan_version_id: 'version-2',
    });
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|plan_replan', {
      args: { horizon_start: '2026-08-12' },
    });
  });

  it('wraps raw bridge failures without exposing them', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('C:\\private\\plan.sqlite'));
    let caught: unknown;
    try {
      await listPlanningCandidates();
    } catch (error) {
      caught = error;
    }
    expect((caught as { kind?: string }).kind).toBe('internal');
    expect((caught as Error).message).toBe('The planner service is unavailable.');
    expect(String(caught)).not.toContain('plan.sqlite');
  });

  it('sends the explicit cloud consent and preserves actionable provider failures', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: 'provider',
      message: "OpenRouter's free request limit was reached. Try again later.",
    });

    let caught: unknown;
    try {
      await suggestPlanWithAi(['media'], request.constraints, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CloudPlanningRpcError);
    expect((caught as CloudPlanningRpcError).kind).toBe('provider');
    expect((caught as Error).message).toContain("OpenRouter's free request limit was reached");
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|cloud_planning_suggest', {
      args: {
        candidate_ids: ['media'],
        constraints: request.constraints,
        consent: true,
      },
    });
  });

  it('parses the capability-aware cloud planning status', async () => {
    vi.mocked(invoke).mockResolvedValue({
      configured: true,
      provider: 'OpenRouter',
      model: 'openrouter/free',
    });
    await expect(getCloudPlanningStatus()).resolves.toMatchObject({
      configured: true,
      model: 'openrouter/free',
    });
  });
});
