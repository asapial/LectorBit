import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyRoute } from './StudyRoute';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
  review: vi.fn(),
  routine: vi.fn(),
}));

vi.mock('../../ipc/learning', () => ({
  listStudyLibrary: mocks.list,
  updateStudyItem: mocks.update,
  recordReview: mocks.review,
}));
vi.mock('../../ipc/planner', () => ({ getRoutine: mocks.routine }));

const item = {
  id: 'study-1',
  media_id: 'media-1',
  chapter_start_ms: 10_000,
  kind: 'flashcard' as const,
  prompt: 'What is a graph?',
  answer: 'A set of vertices connected by edges.',
  hint: 'Think nodes.',
  options: [],
  evidence: [{ segment_id: 1, start_ms: 10_000, end_ms: 20_000 }],
  due_at: '2020-01-01T00:00:00Z',
  interval_days: 0,
  repetitions: 0,
  ease_milli: 2500,
  last_quality: null,
  archived: false,
  user_edited: false,
};

function renderRoute() {
  return render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StudyRoute />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('StudyRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([item]);
    mocks.routine.mockResolvedValue(null);
    mocks.review.mockResolvedValue({});
    mocks.update.mockResolvedValue({ ...item, user_edited: true });
  });

  it('reviews and corrects global study material', async () => {
    renderRoute();
    expect(await screen.findByText('What is a graph?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reveal answer' }));
    expect(screen.getByText('A set of vertices connected by edges.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remembered' }));
    await waitFor(() => expect(mocks.review).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Define a graph.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Define a graph.' }),
      ),
    );
  });
});
