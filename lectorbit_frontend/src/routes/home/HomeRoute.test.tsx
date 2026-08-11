import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeRoute } from './HomeRoute';

const { getRoutineMock } = vi.hoisted(() => ({ getRoutineMock: vi.fn() }));
vi.mock('../../ipc/planner', () => ({ getRoutine: getRoutineMock }));

function renderRoute() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <HomeRoute />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('HomeRoute', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the empty Routine state', async () => {
    getRoutineMock.mockResolvedValue(null);
    renderRoute();
    expect(await screen.findByText('No committed routine yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Build your first plan/ })).toHaveAttribute(
      'href',
      '/plan',
    );
  });

  it('renders the active immutable routine with timestamped blocks', async () => {
    getRoutineMock.mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version',
      title: 'Algorithms sprint',
      horizon_start: '2026-08-10',
      horizon_end: '2099-08-23',
      created_at: '2026-08-10T00:00:00Z',
      days: [
        {
          id: 'day',
          date: '2099-08-10',
          effective_content_ms: 1_500_000,
          break_ms: 300_000,
          items: [
            {
              id: 'item',
              media_id: 'media',
              display_name: 'Algorithms',
              chunk_id: 'chunk',
              sequence: 0,
              raw_start_ms: 0,
              raw_end_ms: 1_500_000,
              effective_duration_ms: 1_500_000,
              break_after_ms: 0,
              status: 'pending',
            },
          ],
        },
      ],
    });
    renderRoute();
    expect(await screen.findByRole('heading', { name: 'Algorithms sprint' })).toBeInTheDocument();
    expect(screen.getAllByText('Algorithms').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/00:00:00–00:25:00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Active immutable version/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start focused study/ })).toHaveAttribute(
      'href',
      '/player/item',
    );
  });
});
