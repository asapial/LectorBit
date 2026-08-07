import { describe, it, expect, vi } from 'vitest';
import { getAppVersion } from './app';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ version: '0.1.0', build: 'test' }),
}));

describe('ipc/app', () => {
  it('forwards to plugin:lectorbit|app_get_version and returns typed result', async () => {
    const result = await getAppVersion();
    expect(result).toEqual({ version: '0.1.0', build: 'test' });
  });
});