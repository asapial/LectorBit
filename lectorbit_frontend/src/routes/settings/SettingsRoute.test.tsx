import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRoute } from './SettingsRoute';

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  models: vi.fn(),
  jobs: vi.fn(),
  installModel: vi.fn(),
  removeModel: vi.fn(),
  cloudStatus: vi.fn(),
  saveKey: vi.fn(),
  removeKey: vi.fn(),
  checkUpdates: vi.fn(),
  installUpdate: vi.fn(),
}));

vi.mock('../../ipc/analysis', () => ({
  getAnalysisCapability: mocks.capability,
  listModels: mocks.models,
  listAnalysisJobs: mocks.jobs,
  installModel: mocks.installModel,
  removeModel: mocks.removeModel,
}));

vi.mock('../../ipc/planner', () => ({
  getCloudPlanningStatus: mocks.cloudStatus,
  saveOpenRouterKey: mocks.saveKey,
  removeOpenRouterKey: mocks.removeKey,
}));

vi.mock('../../ipc/updates', () => ({
  checkForUpdates: mocks.checkUpdates,
  installUpdate: mocks.installUpdate,
}));

function renderRoute() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <SettingsRoute />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('SettingsRoute transcription setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capability.mockResolvedValue({
      available: true,
      engine: 'whisper.cpp',
      expected_version: '1.9.2',
      unavailable_reason: null,
      message: 'Local transcription is ready.',
      supported_languages: ['en', 'bn'],
    });
    mocks.models.mockResolvedValue([
      {
        id: 'whisper-base',
        display_name: 'Whisper Base Multilingual',
        version: '1',
        provider: 'ggerganov/whisper.cpp',
        expected_size_bytes: 150_000_000,
        architecture: 'any',
        analyzer_compatibility: '1.9.2',
        license: 'MIT',
        state: 'ready',
        bytes_downloaded: 150_000_000,
        verified_at: '2026-08-20T00:00:00Z',
        last_error: null,
        supported_languages: ['en', 'bn'],
      },
    ]);
    mocks.jobs.mockResolvedValue([]);
    mocks.cloudStatus.mockResolvedValue({
      configured: false,
      provider: 'OpenRouter',
      model: 'openrouter/free',
    });
  });

  it('shows engine readiness and model-provided language metadata', async () => {
    renderRoute();

    expect(await screen.findByText('Local transcription engine ready')).toBeInTheDocument();
    expect(screen.getByText('Whisper Base Multilingual')).toBeInTheDocument();
    expect(screen.getAllByText('English')).not.toHaveLength(0);
    expect(screen.getAllByText('বাংলা · Bangla')).not.toHaveLength(0);
  });

  it('shows actionable setup guidance when the local engine is missing', async () => {
    mocks.capability.mockResolvedValue({
      available: false,
      engine: 'whisper.cpp',
      expected_version: '1.9.2',
      unavailable_reason: 'whisper_missing',
      message: 'The Whisper transcription component was not found.',
      supported_languages: ['en', 'bn'],
    });
    renderRoute();

    expect(await screen.findByText('Local transcription engine unavailable')).toBeInTheDocument();
    expect(screen.getByText(/LECTORBIT_WHISPER_PATH/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });
});
