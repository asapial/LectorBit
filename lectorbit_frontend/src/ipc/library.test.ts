import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  LibraryRpcError,
  listRoots,
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
      if (command === 'plugin:lectorbit|library_enqueue_scan') {
        const channel = payload?.onEvent as MockChannel<unknown>;
        channel.onmessage({
          event: 'discovering',
          data: { jobId: 'job-1', visitedEntries: 20, mediaCandidates: 3 },
        });
        return Promise.resolve(job);
      }
      if (command === 'plugin:lectorbit|library_revoke_root') {
        return Promise.reject(
          Object.assign(new Error('unknown root'), { kind: 'not_found' }),
        );
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

  it('delegates folder selection and registration to one command', async () => {
    const root = await pickAndRegisterRoot();
    expect(root?.id).toBe('root-1');
    expect(invoke).toHaveBeenCalledWith(
      'plugin:lectorbit|library_pick_and_register_root',
    );
  });

  it('parses durable scan jobs', async () => {
    const result = await listScanJobs('root-1');
    expect(result[0]?.status).toBe('queued');
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
