import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    onmessage?: (value: unknown) => void;
  },
}));

describe('analysis IPC', () => {
  beforeEach(() => invoke.mockReset());

  it('validates model metadata', async () => {
    invoke.mockResolvedValueOnce([
      {
        id: 'whisper-base.en',
        version: 'base.en',
        provider: 'whisper.cpp',
        expected_size_bytes: 147964211,
        architecture: 'any',
        analyzer_compatibility: '1.9.2',
        license: 'MIT',
        state: 'available',
        bytes_downloaded: 0,
        verified_at: null,
        last_error: null,
      },
    ]);
    const { listModels } = await import('./analysis');
    await expect(listModels()).resolves.toHaveLength(1);
  });

  it('rejects unsafe model wire states', async () => {
    invoke.mockResolvedValueOnce([{ id: 'model', state: 'executing' }]);
    const { listModels } = await import('./analysis');
    await expect(listModels()).rejects.toThrow();
  });
});
