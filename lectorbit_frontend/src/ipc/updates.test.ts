import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdates, installUpdate, normalizeUpdateError } from './updates';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    onmessage?: (value: unknown) => void;
  },
}));

describe('ipc/updates', () => {
  beforeEach(() => invoke.mockReset());

  it('validates a signed update availability response', async () => {
    invoke.mockResolvedValue({
      status: 'available',
      current_version: '0.1.0',
      version: '0.2.0',
      notes: 'Security fixes',
      published_at: '2026-08-12T00:00:00Z',
      target: 'windows',
    });
    await expect(checkForUpdates()).resolves.toMatchObject({ version: '0.2.0' });
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|updates_check');
  });

  it('passes only the selected version and a progress channel to install', async () => {
    invoke.mockResolvedValue(undefined);
    await installUpdate('0.2.0', vi.fn());
    expect(invoke).toHaveBeenCalledWith(
      'plugin:lectorbit|updates_install',
      expect.objectContaining({ args: { version: '0.2.0' } }),
    );
  });

  it('maps stable backend errors without exposing raw details', () => {
    const error = normalizeUpdateError({
      kind: 'verification',
      message: 'Nothing was installed.',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Nothing was installed.');
    expect(error).not.toHaveProperty('kind');
  });
});
