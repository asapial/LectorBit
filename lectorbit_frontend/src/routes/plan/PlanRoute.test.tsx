import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanPreview, PlanRequest } from '../../ipc/planner';
import { PlanRoute } from './PlanRoute';

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(),
  previewPlan: vi.fn(),
  commitPlan: vi.fn(),
}));

vi.mock('../../ipc/planner', () => ({
  listPlanningCandidates: mocks.listCandidates,
  previewPlan: mocks.previewPlan,
  commitPlan: mocks.commitPlan,
}));

const feasiblePreview: PlanPreview = {
  feasible: true,
  horizon_start: '2026-08-10',
  horizon_end: '2026-08-23',
  items: [
    {
      sequence: 0,
      media_id: 'media',
      display_name: 'Algorithms',
      chunk_id: 'chunk',
      scheduled_for: '2026-08-10',
      raw_start_ms: 0,
      raw_end_ms: 1_500_000,
      effective_duration_ms: 1_500_000,
      break_after_ms: 0,
    },
  ],
  days: [
    {
      date: '2026-08-10',
      effective_content_ms: 1_500_000,
      break_ms: 0,
      item_count: 1,
    },
  ],
  unscheduled: [],
  alternatives: [],
};

function renderRoute() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <PlanRoute />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('PlanRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCandidates.mockResolvedValue({
      items: [
        {
          media_id: 'media',
          display_name: 'Algorithms',
          path_redacted: '[REDACTED]/Algorithms.mp4',
          duration_ms: 3_600_000,
          chunk_count: 3,
        },
      ],
      next_cursor: null,
    });
    mocks.previewPlan.mockResolvedValue(feasiblePreview);
    mocks.commitPlan.mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version',
      created_at: '2026-08-10T00:00:00Z',
    });
  });

  it('previews and commits a backend-owned feasible plan', async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Algorithms/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    expect(await screen.findByText('Feasible')).toBeInTheDocument();
    expect(screen.getByText('Routine strip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Commit this plan' }));
    expect(await screen.findByText(/Plan committed/)).toBeInTheDocument();
    expect(mocks.commitPlan).toHaveBeenCalledTimes(1);
    const request = mocks.commitPlan.mock.calls[0][1] as PlanRequest;
    expect(request.selections[0].media_id).toBe('media');
    expect(JSON.stringify(request)).not.toContain('raw_start_ms');
  });

  it('applies an actionable infeasibility patch and previews again', async () => {
    const infeasible: PlanPreview = {
      ...feasiblePreview,
      feasible: false,
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
          label: 'Extend the plan by 7 days',
          patch: { kind: 'extend_horizon', days: 21 },
        },
      ],
    };
    mocks.previewPlan.mockResolvedValueOnce(infeasible).mockResolvedValueOnce(feasiblePreview);
    renderRoute();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Algorithms/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Extend the plan by 7 days' }));
    await waitFor(() => expect(mocks.previewPlan).toHaveBeenCalledTimes(2));
    const patched = mocks.previewPlan.mock.calls[1][0] as PlanRequest;
    expect(patched.constraints.horizon_days).toBe(21);
  });

  it('keeps the primary preview action reachable with no media selected', async () => {
    renderRoute();
    await screen.findByText('Algorithms');
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Select at least one');
    expect(mocks.previewPlan).not.toHaveBeenCalled();
  });
});
