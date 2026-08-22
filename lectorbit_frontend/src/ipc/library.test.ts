import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  LibraryRpcError,
  listRoots,
  listMedia,
  listScanJobs,
  pickAndRegisterRoot,
  revokeRoot,
  startScan,
} from './library';

const roots = [
  {
    id: 'root-1',
    display_name: 'Videos',
    path_redacted: '[REDACTED]/Videos',
    registered_at: '2026-08-08T00:00:00Z',
    revoked_at: null,
    is_active: true,
  },
];

const job = {
  id: 'job-1',
  root_id: 'root-1',
  status: 'queued',
  attempt: 0,
  last_error: null,
  created_at: '2026-08-08T00:00:00Z',
  updated_at: '2026-08-08T00:00:00Z',
};

const mediaPage = {
  items: [
    {
      id: 'media-1',
      root_id: 'root-1',
      display_name: 'lesson.mp4',
      path_redacted: '[REDACTED]/lesson.mp4',
      media_kind: 'video',
      size_bytes: 2048,
      duration_ms: 90500,
      container: 'matroska',
      video_codec: 'h264',
      audio_codec: 'aac',
      width: 1920,
      height: 1080,
      audio_streams: 1,
      subtitle_streams: 1,
      probe_status: 'ready',
      probe_error: null,
      discovered_at: '2026-08-08T00:00:00Z',
    },
  ],
  next_cursor: null,
  summary: {
    total_items: 42,
    ready_items: 36,
    attention_items: 2,
    known_duration_ms: 7_200_000,
    duration_known_items: 40,
  },
};

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel<T> {
    onmessage: (message: T) => void = () => undefined;
  }
  return {
    Channel: MockChannel,
    invoke: vi.fn((command: string, payload?: Record<string, unknown>) => {
      if (command === 'plugin:lectorbit|library_list_roots') {
        return Promise.resolve(roots);
      }
      if (command === 'plugin:lectorbit|library_pick_and_register_root') {
        return Promise.resolve(roots[0]);
      }
      if (command === 'plugin:lectorbit|library_list_scan_jobs') {
        return Promise.resolve([job]);
      }
      if (command === 'plugin:lectorbit|library_list_media') {
        return Promise.resolve(mediaPage);
      }
      if (command === 'plugin:lectorbit|library_enqueue_scan') {
        const channel = payload?.onEvent as MockChannel<unknown>;
        channel.onmessage({
          event: 'discovering',
          data: { jobId: 'job-1', visitedEntries: 20, mediaCandidates: 3 },
        });
        return Promise.resolve(job);
      }
      if (command === 'plugin:lectorbit|library_revoke_root') {
        return Promise.reject(Object.assign(new Error('unknown root'), { kind: 'not_found' }));
      }
      return Promise.reject(new Error(`unknown command ${command}`));
    }),
  };
});

describe('ipc/library', () => {
  it('parses renderer-safe roots', async () => {
    const result = await listRoots();
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('canonical_path');
  });

  it('does not expose raw bridge failures', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'invoke')"),
    );

    await expect(listRoots()).rejects.toMatchObject({
      kind: 'internal',
      message: 'The library service is unavailable.',
    });
  });

  it('delegates folder selection and registration to one command', async () => {
    const root = await pickAndRegisterRoot();
    expect(root?.id).toBe('root-1');
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|library_pick_and_register_root');
  });

  it('parses durable scan jobs', async () => {
    const result = await listScanJobs('root-1');
    expect(result[0]?.status).toBe('queued');
  });

  it('parses a renderer-safe media metadata page', async () => {
    const page = await listMedia({ limit: 25 });

    expect(page.items[0]?.duration_ms).toBe(90500);
    expect(page.items[0]).not.toHaveProperty('path');
    expect(page.summary?.total_items).toBe(42);
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|library_list_media', {
      args: { root_id: null, cursor: null, limit: 25 },
    });
  });

  it('normalizes numeric bridge values and absent optional metadata fields', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      items: [
        {
          ...mediaPage.items[0],
          size_bytes: '2048',
          duration_ms: '90500',
          width: '1920',
          height: '1080',
          audio_streams: undefined,
          subtitle_streams: undefined,
          probe_error: undefined,
        },
      ],
      next_cursor: null,
    });

    const page = await listMedia({ rootId: 'root-1' });

    expect(page.items[0]).toMatchObject({
      size_bytes: 2048,
      duration_ms: 90500,
      width: 1920,
      height: 1080,
      audio_streams: 0,
      subtitle_streams: 0,
      probe_error: null,
    });
  });

  it('scopes media pagination to one folder module', async () => {
    await listMedia({ rootId: 'root-1', cursor: 'opaque-next', limit: 20 });

    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|library_list_media', {
      args: { root_id: 'root-1', cursor: 'opaque-next', limit: 20 },
    });
  });

  it('delivers typed channel progress while enqueueing', async () => {
    const events: string[] = [];
    const result = await startScan('root-1', (event) => events.push(event.event));
    expect(result.id).toBe('job-1');
    expect(events).toEqual(['discovering']);
  });

  it('wraps stable plugin errors', async () => {
    await expect(revokeRoot('missing')).rejects.toMatchObject({
      name: 'LibraryRpcError',
      kind: 'not_found',
      message: 'unknown root',
    } satisfies Partial<LibraryRpcError>);
  });
});
