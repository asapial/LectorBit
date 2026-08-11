import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('search IPC', () => {
  beforeEach(() => invoke.mockReset());

  it('accepts timestamped local search results', async () => {
    invoke.mockResolvedValueOnce([
      {
        media_id: 'media',
        display_name: 'Lesson',
        plan_item_id: 'item',
        source: 'transcript',
        start_ms: 12000,
        end_ms: 17000,
        snippet: '<mark>queues</mark> are durable',
        score: 100,
      },
    ]);
    const { searchLibrary } = await import('./search');
    const results = await searchLibrary('queues');
    expect(results[0].start_ms).toBe(12000);
  });
});
