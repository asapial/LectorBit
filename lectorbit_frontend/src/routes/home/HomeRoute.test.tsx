import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeRoute } from './HomeRoute';

const { getRoutineMock, listDueReviewsMock, recordReviewMock } = vi.hoisted(() => ({
  getRoutineMock: vi.fn(),
  listDueReviewsMock: vi.fn(),
  recordReviewMock: vi.fn(),
}));
vi.mock('../../ipc/planner', () => ({ getRoutine: getRoutineMock }));
vi.mock('../../ipc/learning', () => ({
  listDueReviews: listDueReviewsMock,
  recordReview: recordReviewMock,
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    listDueReviewsMock.mockResolvedValue([]);
  });

  it('renders the empty Routine state', async () => {
    getRoutineMock.mockResolvedValue(null);
    renderRoute();
    expect(await screen.findByText('No committed routine yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Build your first plan/ })).toHaveAttribute(
      'href',
      '/plan',
    );
  });

  it('reviews due study material directly from Today', async () => {
    getRoutineMock.mockResolvedValue(null);
    listDueReviewsMock.mockResolvedValue([
      {
        id: 'review-1',
        media_id: 'media-1',
        chapter_start_ms: 0,
        kind: 'flashcard',
        prompt: 'What is stable sorting?',
        answer: 'Equal keys retain their original order.',
        hint: 'Think about ties.',
        options: [],
        evidence: [{ segment_id: 1, start_ms: 12_000, end_ms: 20_000 }],
        due_at: '2026-08-19T00:00:00Z',
        interval_days: 1,
        repetitions: 1,
        ease_milli: 2500,
        last_quality: 4,
      },
    ]);
    recordReviewMock.mockResolvedValue({ study_item_id: 'review-1' });
    renderRoute();

    expect(await screen.findByText('What is stable sorting?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal answer' }));
    expect(screen.getByText('Equal keys retain their original order.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remembered' }));
    await waitFor(() =>
      expect(recordReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          studyItemId: 'review-1',
          quality: 5,
        }),
      ),
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

  it('advances focused study past an already-finished day', async () => {
    getRoutineMock.mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version',
      title: 'Course',
      horizon_start: '2099-08-10',
      horizon_end: '2099-08-11',
      created_at: '2026-08-10T00:00:00Z',
      days: [
        {
          id: 'day-1',
          date: '2099-08-10',
          effective_content_ms: 60_000,
          break_ms: 0,
          items: [
            {
              id: 'item-1',
              media_id: 'media-1',
              display_name: 'Finished lesson',
              chunk_id: 'chunk-1',
              sequence: 0,
              raw_start_ms: 0,
              raw_end_ms: 60_000,
              effective_duration_ms: 60_000,
              break_after_ms: 0,
              status: 'done',
            },
          ],
        },
        {
          id: 'day-2',
          date: '2099-08-11',
          effective_content_ms: 60_000,
          break_ms: 0,
          items: [
            {
              id: 'item-2',
              media_id: 'media-2',
              display_name: 'Next lesson',
              chunk_id: 'chunk-2',
              sequence: 1,
              raw_start_ms: 0,
              raw_end_ms: 60_000,
              effective_duration_ms: 60_000,
              break_after_ms: 0,
              status: 'pending',
            },
          ],
        },
      ],
    });

    renderRoute();

    expect(await screen.findByRole('link', { name: /Start focused study/ })).toHaveAttribute(
      'href',
      '/player/item-2',
    );
  });
});
