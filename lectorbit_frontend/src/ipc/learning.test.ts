import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    onmessage?: (value: unknown) => void;
  },
}));

describe('learning IPC', () => {
  beforeEach(() => invoke.mockReset());

  it('requests and validates the dedicated due-review queue', async () => {
    invoke.mockResolvedValueOnce([
      {
        id: 'review-1',
        media_id: 'media-1',
        chapter_start_ms: 10_000,
        kind: 'flashcard',
        prompt: 'Question',
        answer: 'Answer',
        hint: null,
        options: [],
        evidence: [{ segment_id: 7, start_ms: 10_000, end_ms: 20_000 }],
        due_at: '2026-08-19T00:00:00Z',
        interval_days: 1,
        repetitions: 1,
        ease_milli: 2500,
        last_quality: 4,
      },
    ]);
    const { listDueReviews } = await import('./learning');
    await expect(listDueReviews('2026-08-19T12:00:00Z', 20)).resolves.toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|learning_list_due_reviews', {
      args: { due_before: '2026-08-19T12:00:00Z', limit: 20 },
    });
  });

  it('rejects a due item without canonical evidence', async () => {
    invoke.mockResolvedValueOnce([
      {
        id: 'review-1',
        media_id: 'media-1',
        chapter_start_ms: null,
        kind: 'flashcard',
        prompt: 'Question',
        answer: 'Answer',
        hint: null,
        options: [],
        evidence: [],
        due_at: '2026-08-19T00:00:00Z',
        interval_days: 0,
        repetitions: 0,
        ease_milli: 2500,
        last_quality: null,
      },
    ]);
    const { listDueReviews } = await import('./learning');
    await expect(listDueReviews()).rejects.toThrow();
  });
});
