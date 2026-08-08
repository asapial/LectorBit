import { describe, it, expect, vi } from 'vitest';
import { getDiagnostics } from './diagnostics';

vi.mock('@tauri-apps/api/core', () => {
  const fixture = {
    generated_at: '2026-08-08T00:00:00.000Z',
    app: {
      version: '0.1.0',
      build: 'test',
      target_triple: 'x86_64-pc-windows-msvc',
      elapsed_since_launch: { secs: 12, nanos: 0 },
    },
    database: {
      schema_version: 1,
      migrations_applied: 1,
      sqlite_version: '3.53.0',
      journal_mode: 'wal',
      foreign_keys: true,
      size_bytes: 1024,
      path_redacted: '[REDACTED]/lectordb.sqlite',
    },
    library: {
      root_count: 0,
      active_root_count: 0,
      media_count: 0,
    },
    ai: {
      whisper_model_present: false,
      ocr_model_present: false,
      embeddings_model_present: false,
      last_consent: null,
    },
    recent_errors: [],
  };
  return {
    invoke: vi.fn(() => Promise.resolve(fixture)),
  };
});

describe('ipc/diagnostics', () => {
  it('forwards to plugin:lectorbit|app_get_diagnostics and validates the payload', async () => {
    const result = await getDiagnostics();
    expect(result.app.version).toBe('0.1.0');
    expect(result.database.sqlite_version).toBe('3.53.0');
    expect(result.library.media_count).toBe(0);
  });

  it('rejects a payload missing required fields', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      app: {},
      database: {},
      library: {},
      ai: {},
      recent_errors: 'not-an-array',
    });
    await expect(getDiagnostics()).rejects.toThrow();
  });
});
