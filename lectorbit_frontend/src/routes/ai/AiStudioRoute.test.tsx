import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiStudioRoute } from './AiStudioRoute';

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  listAnalysisJobs: vi.fn(),
  analysisCapability: vi.fn(),
  cloudStatus: vi.fn(),
}));

vi.mock('../../ipc/analysis', () => ({
  listModels: mocks.listModels,
  listAnalysisJobs: mocks.listAnalysisJobs,
  getAnalysisCapability: mocks.analysisCapability,
}));
vi.mock('../../ipc/planner', () => ({ getCloudPlanningStatus: mocks.cloudStatus }));

function renderRoute() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AiStudioRoute />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('AiStudioRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.analysisCapability.mockResolvedValue({
      available: true,
      engine: 'whisper.cpp',
      expected_version: '1.9.2',
      unavailable_reason: null,
      message: 'Local English and Bangla transcription is ready.',
      supported_languages: ['en', 'bn'],
    });
  });

  it('summarizes live readiness and routes users to each available workflow', async () => {
    mocks.listModels.mockResolvedValue([
      { id: 'whisper-base', state: 'ready', supported_languages: ['en', 'bn'] },
    ]);
    mocks.cloudStatus.mockResolvedValue({
      configured: true,
      provider: 'OpenRouter',
      model: 'automatic free model',
    });
    mocks.listAnalysisJobs.mockResolvedValue([]);

    renderRoute();

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Library/ })).toHaveAttribute('href', '/library');
    expect(screen.getByRole('link', { name: /Open Plan Builder/ })).toHaveAttribute(
      'href',
      '/plan',
    );
    expect(mocks.listAnalysisJobs).toHaveBeenCalledWith('transcribe');
  });

  it('keeps the workflow guide available when desktop status cannot be loaded', async () => {
    mocks.listModels.mockRejectedValue(new Error('desktop unavailable'));
    mocks.cloudStatus.mockRejectedValue(new Error('desktop unavailable'));
    mocks.listAnalysisJobs.mockRejectedValue(new Error('desktop unavailable'));
    mocks.analysisCapability.mockRejectedValue(new Error('desktop unavailable'));

    renderRoute();

    expect(await screen.findByText(/Live AI status is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Available now' })).toBeInTheDocument();
    expect(screen.getByText('Slide and formula OCR')).toBeInTheDocument();
  });

  it('does not report ready when the model exists but the native engine is missing', async () => {
    mocks.listModels.mockResolvedValue([
      { id: 'whisper-base.en', state: 'ready', supported_languages: ['en'] },
    ]);
    mocks.analysisCapability.mockResolvedValue({
      available: false,
      engine: 'whisper.cpp',
      expected_version: '1.9.2',
      unavailable_reason: 'whisper_missing',
      message: 'Install the local whisper.cpp engine.',
      supported_languages: ['en', 'bn'],
    });
    mocks.cloudStatus.mockResolvedValue({ configured: false });
    mocks.listAnalysisJobs.mockResolvedValue([]);

    renderRoute();

    expect(await screen.findByText('Setup needed')).toBeInTheDocument();
    expect(screen.getByText('Install the local whisper.cpp engine.')).toBeInTheDocument();
  });

  it('does not claim Bangla readiness from an English-only model', async () => {
    mocks.listModels.mockResolvedValue([
      { id: 'whisper-base.en', state: 'ready', supported_languages: ['en'] },
    ]);
    mocks.cloudStatus.mockResolvedValue({ configured: false });
    mocks.listAnalysisJobs.mockResolvedValue([]);

    renderRoute();

    expect(await screen.findByText('Setup needed')).toBeInTheDocument();
    expect(
      screen.getByText('English is ready. Install the multilingual Whisper model for Bangla.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('English and Bangla transcription engine ready'),
    ).not.toBeInTheDocument();
  });

  it('asks for a model when the engine is ready but no model is installed', async () => {
    mocks.listModels.mockResolvedValue([]);
    mocks.cloudStatus.mockResolvedValue({ configured: false });
    mocks.listAnalysisJobs.mockResolvedValue([]);

    renderRoute();

    expect(await screen.findByText('Setup needed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The local engine is ready. Install a verified transcription model in Settings.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Local English and Bangla transcription is ready.'),
    ).not.toBeInTheDocument();
  });
});
