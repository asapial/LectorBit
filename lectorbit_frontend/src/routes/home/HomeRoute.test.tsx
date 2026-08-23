import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutinePlan } from '../../ipc/planner';
import { HomeRoute } from './HomeRoute';

const { getRoutineMock, replanActiveMock, listDueReviewsMock, recordReviewMock } = vi.hoisted(
  () => ({
    getRoutineMock: vi.fn(),
    replanActiveMock: vi.fn(),
    listDueReviewsMock: vi.fn(),
    recordReviewMock: vi.fn(),
  }),
);
vi.mock('../../ipc/planner', () => ({
  getRoutine: getRoutineMock,
  replanActive: replanActiveMock,
}));
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

function todayDate() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function routineItem(overrides: Partial<RoutinePlan['days'][number]['items'][number]> = {}) {
  return {
    id: 'item',
    media_id: 'media',
    display_name: 'Algorithms',
    chunk_id: 'chunk',
    sequence: 0,
    raw_start_ms: 0,
    raw_end_ms: 60_000,
    effective_duration_ms: 60_000,
    break_after_ms: 0,
    status: 'pending' as const,
    ...overrides,
  };
}

function currentRoutine(items: ReturnType<typeof routineItem>[]): RoutinePlan {
  const today = todayDate();
  return {
    plan_id: 'plan',
    plan_version_id: 'version',
    title: 'Algorithms sprint',
    horizon_start: today,
    horizon_end: today,
    created_at: '2026-08-23T00:00:00Z',
    days: [
      {
        id: 'today',
        date: today,
        effective_content_ms: items.reduce((total, item) => total + item.effective_duration_ms, 0),
        break_ms: 300_000,
        items,
      },
    ],
  };
}

describe('HomeRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDueReviewsMock.mockResolvedValue([]);
    replanActiveMock.mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'repaired-version',
      created_at: '2026-08-23T00:00:00Z',
    });
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
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect((await screen.findAllByText('Algorithms')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/00:00:00–00:25:00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Following Algorithms sprint/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open next scheduled block/ })).toHaveAttribute(
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

    expect(await screen.findByRole('link', { name: /Open next scheduled block/ })).toHaveAttribute(
      'href',
      '/player/item-2',
    );
  });

  it('prioritizes an in-progress block and shows an honest daily snapshot', async () => {
    getRoutineMock.mockResolvedValue(
      currentRoutine([
        routineItem({ id: 'pending', display_name: 'Pending lesson' }),
        routineItem({
          id: 'active',
          display_name: 'Active lesson',
          sequence: 1,
          status: 'in_progress',
        }),
        routineItem({
          id: 'done',
          display_name: 'Finished lesson',
          sequence: 2,
          status: 'done',
        }),
      ]),
    );

    renderRoute();

    expect(await screen.findByRole('link', { name: /Continue block/ })).toHaveAttribute(
      'href',
      '/player/active',
    );
    expect(screen.getByRole('progressbar', { name: 'Daily blocks handled' })).toHaveAttribute(
      'aria-valuetext',
      '1 of 3 blocks handled',
    );
    expect(screen.getByText('2m')).toBeInTheDocument();
  });

  it('hides legacy micro-blocks and repairs the immutable remaining schedule', async () => {
    getRoutineMock.mockResolvedValue(
      currentRoutine([
        routineItem({
          id: 'micro',
          raw_start_ms: 105_788,
          raw_end_ms: 106_591,
          effective_duration_ms: 803,
        }),
        routineItem({
          id: 'playable',
          display_name: 'Meaningful remainder',
          sequence: 1,
          raw_start_ms: 239_418,
          raw_end_ms: 285_256,
          effective_duration_ms: 45_838,
        }),
      ]),
    );

    renderRoute();

    expect(await screen.findByRole('link', { name: /Start focused study/ })).toHaveAttribute(
      'href',
      '/player/playable',
    );
    expect(screen.queryByRole('link', { name: 'Algorithms' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Repair schedule' }));
    await waitFor(() => expect(replanActiveMock).toHaveBeenCalledWith(todayDate()));
  });

  it('does not silently launch unfinished work scheduled only in the past', async () => {
    const routine = currentRoutine([routineItem({ id: 'overdue' })]);
    routine.horizon_start = '2000-01-01';
    routine.horizon_end = '2000-01-01';
    routine.days[0].date = '2000-01-01';
    getRoutineMock.mockResolvedValue(routine);

    renderRoute();

    expect(
      await screen.findByRole('heading', { name: 'Schedule needs attention' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /focused study|scheduled block/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repair remaining schedule' })).toBeInTheDocument();
  });

  it('runs one multiple-choice review at a time and links back to cited evidence', async () => {
    getRoutineMock.mockResolvedValue(currentRoutine([routineItem({ id: 'evidence-block' })]));
    listDueReviewsMock.mockResolvedValue([
      {
        id: 'review-1',
        media_id: 'media',
        chapter_start_ms: 0,
        kind: 'multiple_choice',
        prompt: 'Which sort preserves equal-key order?',
        answer: 'A stable sort.',
        hint: null,
        options: ['Stable sort', 'Unstable sort'],
        evidence: [{ segment_id: 1, start_ms: 12_000, end_ms: 20_000 }],
        due_at: '2026-08-23T00:00:00Z',
        interval_days: 1,
        repetitions: 1,
        ease_milli: 2500,
        last_quality: 4,
      },
    ]);
    recordReviewMock.mockResolvedValue({ study_item_id: 'review-1' });

    renderRoute();

    const focusHeading = await screen.findByRole('heading', { name: 'Algorithms' });
    const reviewHeading = screen.getByRole('heading', { name: 'Review sprint' });
    expect(
      focusHeading.compareDocumentPosition(reviewHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Stable sort'));
    expect(screen.getByRole('link', { name: /Replay evidence at 00:00:12/ })).toHaveAttribute(
      'href',
      '/player/evidence-block?t=12000',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reveal answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remembered' }));
    await waitFor(() =>
      expect(recordReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          studyItemId: 'review-1',
          quality: 5,
          answerText: 'Stable sort',
        }),
      ),
    );
  });
});
