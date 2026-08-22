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
        display_name: 'Whisper Base English',
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
        supported_languages: ['en'],
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

  it('validates local engine capability', async () => {
    invoke.mockResolvedValueOnce({
      available: true,
      engine: 'whisper.cpp',
      expected_version: '1.9.2',
      unavailable_reason: null,
      message: 'Local transcription is ready.',
      supported_languages: ['en', 'bn'],
    });
    const { getAnalysisCapability } = await import('./analysis');

    await expect(getAnalysisCapability()).resolves.toMatchObject({
      available: true,
      supported_languages: ['en', 'bn'],
    });
    expect(invoke).toHaveBeenCalledWith('plugin:lectorbit|analysis_get_capability');
  });

  it('sends the selected transcription language', async () => {
    invoke.mockResolvedValueOnce({
      id: 'job-1',
      kind: 'transcribe',
      status: 'queued',
      attempt: 0,
      last_error: null,
      created_at: '2026-08-20T00:00:00Z',
      updated_at: '2026-08-20T00:00:00Z',
    });
    const { startTranscription } = await import('./analysis');

    await startTranscription('media-1', 'whisper-base', 'bn', vi.fn());

    expect(invoke).toHaveBeenCalledWith(
      'plugin:lectorbit|analysis_start_transcription',
      expect.objectContaining({
        args: { media_id: 'media-1', model_id: 'whisper-base', language: 'bn' },
      }),
    );
  });

  it('validates transcript language and model identity', async () => {
    invoke.mockResolvedValueOnce({
      media_id: 'media-1',
      status: 'completed',
      segment_count: 24,
      language: 'bn',
      model_id: 'whisper-base',
      updated_at: '2026-08-20T00:00:00Z',
      job: null,
    });
    const { getTranscriptState } = await import('./analysis');

    await expect(getTranscriptState('media-1')).resolves.toMatchObject({
      language: 'bn',
      model_id: 'whisper-base',
    });
  });

  it('preserves structured analysis errors for actionable recovery', async () => {
    invoke.mockRejectedValueOnce({
      kind: 'sidecar_unavailable',
      message: 'Local transcription is unavailable on this installation.',
    });
    const { AnalysisRpcError, getAnalysisCapability } = await import('./analysis');

    const error = await getAnalysisCapability().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AnalysisRpcError);
    expect(error).toMatchObject({ kind: 'sidecar_unavailable' });
  });

  it('preserves a safe busy error when another transcription owns the media', async () => {
    invoke.mockRejectedValueOnce({
      kind: 'transcription_busy',
      message: 'This lecture is already being transcribed in English.',
    });
    const { getTranscriptState } = await import('./analysis');

    const error = await getTranscriptState('media-1').catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: 'AnalysisRpcError',
      kind: 'transcription_busy',
      message: 'This lecture is already being transcribed in English.',
    });
  });
});
