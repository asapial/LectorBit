import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { openPlayback, recordStudyAction, seekPlayback, setPlaybackSpeed } from './playback';

type ChannelShape<T> = { onmessage?: (message: T) => void };

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel<T> {
    onmessage?: (message: T) => void;
  }
  return { Channel: MockChannel, invoke: vi.fn() };
});

const view = {
  plan_item_id: 'item',
  media_id: 'media',
  display_name: 'Graph theory',
  raw_start_ms: 60_000,
  raw_end_ms: 1_560_000,
  position_ms: 120_000,
  duration_ms: 3_600_000,
  paused: true,
  speed: 1,
  progress_version: 4,
  item_covered_ms: 300_000,
  item_duration_ms: 1_500_000,
  completed: false,
  stream_url: 'http://lector-media.localhost/0123456789abcdef0123456789abcdef',
  caption_tracks: [
    {
      label: 'Captions',
      language: 'en',
      url: 'http://lector-media.localhost/fedcba9876543210fedcba9876543210',
    },
  ],
};

describe('ipc/playback', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('opens an authorized plan item and validates channel events', async () => {
    vi.mocked(invoke).mockResolvedValue(view);
    const events: unknown[] = [];
    await expect(openPlayback('item', (event) => events.push(event))).resolves.toEqual(view);
    const payload = vi.mocked(invoke).mock.calls[0]?.[1] as {
      onEvent: ChannelShape<unknown>;
    };
    payload.onEvent.onmessage?.({ event: 'state', data: { ...view, paused: false } });
    payload.onEvent.onmessage?.({ event: 'state', data: { ...view, position_ms: -1 } });
    expect(events).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(
      'plugin:lectorbit|playback_open',
      expect.objectContaining({ args: { plan_item_id: 'item' } }),
    );
  });

  it('validates seek and speed before crossing IPC', async () => {
    await expect(seekPlayback(-1)).rejects.toThrow();
    await expect(setPlaybackSpeed(3)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends only closed study action values', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await recordStudyAction('item', 'split', 420_000);
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|study_record_action', {
      args: {
        plan_item_id: 'item',
        kind: 'split',
        at_ms: 420_000,
      },
    });
  });

  it('redacts raw bridge failures', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('C:\\private\\lesson.mp4'));
    await expect(openPlayback('item', () => undefined)).rejects.toMatchObject({
      kind: 'internal',
      message: 'The playback service is unavailable.',
    });
  });
});
