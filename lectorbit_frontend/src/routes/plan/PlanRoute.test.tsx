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
  cloudStatus: vi.fn(),
  suggestPlan: vi.fn(),
  parseIntent: vi.fn(),
}));

vi.mock('../../ipc/planner', () => ({
  listPlanningCandidates: mocks.listCandidates,
  previewPlan: mocks.previewPlan,
  commitPlan: mocks.commitPlan,
  getCloudPlanningStatus: mocks.cloudStatus,
  suggestPlanWithAi: mocks.suggestPlan,
  parsePlanIntent: mocks.parseIntent,
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

function renderRoute(initialEntry = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
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
          module_id: 'algorithms',
          module_name: 'Algorithms course',
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
    mocks.cloudStatus.mockResolvedValue({
      configured: false,
      provider: 'OpenRouter',
      model: 'google/gemma-4-26b-a4b-it:free',
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

  it('paginates media without combining folder modules', async () => {
    mocks.listCandidates.mockImplementation(({ cursor }: { cursor?: string }) =>
      Promise.resolve(
        cursor
          ? {
              items: [
                {
                  media_id: 'rust-1',
                  module_id: 'rust',
                  module_name: 'Rust course',
                  display_name: '1 - Ownership.mp4',
                  path_redacted: '[REDACTED]/Rust course/1 - Ownership.mp4',
                  duration_ms: 600_000,
                  chunk_count: 1,
                },
              ],
              next_cursor: null,
            }
          : {
              items: [
                {
                  media_id: 'ml-1',
                  module_id: 'ml',
                  module_name: 'Machine learning',
                  display_name: '1 - Introduction.mp4',
                  path_redacted: '[REDACTED]/Machine learning/1 - Introduction.mp4',
                  duration_ms: 900_000,
                  chunk_count: 1,
                },
              ],
              next_cursor: 'ml-1',
            },
      ),
    );

    renderRoute();
    expect(
      await screen.findByRole('region', { name: 'Machine learning module' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Rust course module' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('region', { name: 'Rust course module' })).toBeInTheDocument();
    expect(mocks.listCandidates).toHaveBeenLastCalledWith({ cursor: 'ml-1', limit: 24 });

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(
      await screen.findByRole('region', { name: 'Machine learning module' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('1 - Ownership.mp4')).not.toBeInTheDocument();
  });

  it('loads and preselects every page in a requested folder module', async () => {
    mocks.cloudStatus.mockResolvedValue({
      configured: true,
      provider: 'OpenRouter',
      model: 'google/gemma-4-26b-a4b-it:free',
    });
    mocks.listCandidates.mockImplementation(
      ({ moduleId, cursor }: { moduleId?: string; cursor?: string }) => {
        expect(moduleId).toBe('module-ml');
        return Promise.resolve(
          cursor
            ? {
                items: [
                  {
                    media_id: 'ml-2',
                    module_id: 'module-ml',
                    module_name: 'Machine learning',
                    display_name: '2 - Regression.mp4',
                    path_redacted: '[REDACTED]/Machine learning/2 - Regression.mp4',
                    duration_ms: 1_200_000,
                    chunk_count: 2,
                  },
                ],
                next_cursor: null,
              }
            : {
                items: [
                  {
                    media_id: 'ml-1',
                    module_id: 'module-ml',
                    module_name: 'Machine learning',
                    display_name: '1 - Introduction.mp4',
                    path_redacted: '[REDACTED]/Machine learning/1 - Introduction.mp4',
                    duration_ms: 900_000,
                    chunk_count: 1,
                  },
                ],
                next_cursor: 'ml-1',
              },
        );
      },
    );
    mocks.suggestPlan.mockResolvedValue({
      title: 'Machine learning module',
      description: 'The complete requested folder in a useful order.',
      model: 'provider/free-model',
      items: [
        { media_id: 'ml-1', priority: 4, dependencies: [], reason: 'Start here.' },
        {
          media_id: 'ml-2',
          priority: 3,
          dependencies: ['ml-1'],
          reason: 'Build on the introduction.',
        },
      ],
    });

    renderRoute('/plan?module=module-ml');
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    expect(
      screen.getByText(/Folder module loaded: 2 ready videos across 2 pages/),
    ).toBeInTheDocument();
    expect(mocks.listCandidates).toHaveBeenLastCalledWith({
      moduleId: 'module-ml',
      cursor: 'ml-1',
      limit: 24,
    });

    fireEvent.click(screen.getByRole('checkbox', { name: /I understand this request uses/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Suggest grounded prerequisites' }));
    await waitFor(() =>
      expect(mocks.suggestPlan).toHaveBeenCalledWith(['ml-1', 'ml-2'], expect.any(Object), true),
    );
  });

  it('applies an explained AI sequence without bypassing deterministic preview', async () => {
    mocks.cloudStatus.mockResolvedValue({
      configured: true,
      provider: 'OpenRouter',
      model: 'google/gemma-4-26b-a4b-it:free',
    });
    mocks.listCandidates.mockResolvedValue({
      items: [
        {
          media_id: 'ten',
          module_id: 'ml',
          module_name: 'Machine learning',
          display_name: '10 - Feature Scaling.mp4',
          path_redacted: '[REDACTED]/10 - Feature Scaling.mp4',
          duration_ms: 900_000,
          chunk_count: 1,
        },
        {
          media_id: 'two',
          module_id: 'ml',
          module_name: 'Machine learning',
          display_name: '2 - Machine Learning Demo Get Excited.mp4',
          path_redacted: '[REDACTED]/2 - Machine Learning Demo Get Excited.mp4',
          duration_ms: 600_000,
          chunk_count: 1,
        },
      ],
      next_cursor: null,
    });
    mocks.suggestPlan.mockResolvedValue({
      title: 'Machine learning foundations',
      description: 'Begin with motivation, then normalize features before model training.',
      model: 'provider/model',
      items: [
        {
          media_id: 'two',
          priority: 4,
          dependencies: [],
          reason: 'Introduces the course and builds context.',
        },
        {
          media_id: 'ten',
          priority: 3,
          dependencies: ['two'],
          reason: 'Uses the context established by the demonstration.',
        },
      ],
    });

    renderRoute();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /I understand this request uses/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Suggest grounded prerequisites' }));

    expect(
      await screen.findByText(
        'Begin with motivation, then normalize features before model training.',
      ),
    ).toBeInTheDocument();
    expect(mocks.suggestPlan).toHaveBeenCalledWith(['ten', 'two'], expect.any(Object), true);

    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    await waitFor(() => expect(mocks.previewPlan).toHaveBeenCalledTimes(1));
    const request = mocks.previewPlan.mock.calls[0][0] as PlanRequest;
    expect(request.selections.map((selection) => selection.media_id)).toEqual(['two', 'ten']);
    expect(request.selections[1].dependencies).toEqual(['two']);
  });

  it('shows AI failures beside the suggestion action and allows a retry', async () => {
    mocks.cloudStatus.mockResolvedValue({
      configured: true,
      provider: 'OpenRouter',
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free → google/gemma-4-26b-a4b-it:free',
    });
    mocks.suggestPlan
      .mockRejectedValueOnce(new Error('OpenRouter is temporarily unavailable.'))
      .mockResolvedValueOnce({
        title: 'Algorithms path',
        description: 'A clear progression through the selected material.',
        model: 'provider/free-model',
        items: [
          {
            media_id: 'media',
            priority: 3,
            dependencies: [],
            reason: 'Establish the core concepts first.',
          },
        ],
      });

    renderRoute();
    const consent = await screen.findByRole('checkbox', {
      name: /I understand this request uses/i,
    });
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest grounded prerequisites' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'OpenRouter is temporarily unavailable.',
    );
    expect(screen.getByRole('button', { name: 'Suggest grounded prerequisites' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Suggest grounded prerequisites' }));
    expect(
      await screen.findByText('A clear progression through the selected material.'),
    ).toBeInTheDocument();
    expect(mocks.suggestPlan).toHaveBeenCalledTimes(2);
  });
});
