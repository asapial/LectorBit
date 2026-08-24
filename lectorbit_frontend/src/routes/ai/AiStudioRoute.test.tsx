import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisJob, AnalysisProgress } from '../../ipc/analysis';
import { AiStudioRoute } from './AiStudioRoute';

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  listAnalysisJobs: vi.fn(),
  installModel: vi.fn(),
  analysisCapability: vi.fn(),
  cloudStatus: vi.fn(),
  dueReviews: vi.fn(),
  artifacts: vi.fn(),
  requestActivity: vi.fn(),
  allJobs: vi.fn(),
  cancelJob: vi.fn(),
  retryJob: vi.fn(),
}));

vi.mock('../../ipc/analysis', () => ({
  listModels: mocks.listModels,
  listAnalysisJobs: mocks.listAnalysisJobs,
  installModel: mocks.installModel,
  getAnalysisCapability: mocks.analysisCapability,
}));
vi.mock('../../ipc/learning', () => ({ listDueReviews: mocks.dueReviews }));
vi.mock('../../ipc/planner', () => ({ getCloudPlanningStatus: mocks.cloudStatus }));
vi.mock('../../ipc/aiStudio', () => ({
  listAiArtifacts: mocks.artifacts,
  listAiRequestActivity: mocks.requestActivity,
  listAiStudioJobs: mocks.allJobs,
  cancelAiStudioJob: mocks.cancelJob,
  retryAiStudioJob: mocks.retryJob,
}));

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

const bilingualModel = {
  id: 'whisper-base',
  display_name: 'Whisper Base Multilingual',
  version: '1',
  provider: 'whisper.cpp',
  expected_size_bytes: 147_951_465,
  architecture: 'base',
  analyzer_compatibility: '1.9.2',
  license: 'MIT',
  state: 'ready',
  bytes_downloaded: 147_951_465,
  verified_at: '2026-08-20T10:00:00Z',
  last_error: null,
  supported_languages: ['en', 'bn'],
};

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
    mocks.listModels.mockResolvedValue([bilingualModel]);
    mocks.cloudStatus.mockResolvedValue({
      configured: true,
      provider: 'OpenRouter',
      model: 'automatic free model',
    });
    mocks.listAnalysisJobs.mockResolvedValue([]);
    mocks.dueReviews.mockResolvedValue([]);
    mocks.artifacts.mockResolvedValue([]);
    mocks.requestActivity.mockResolvedValue([]);
    mocks.allJobs.mockResolvedValue([]);
    mocks.cancelJob.mockResolvedValue({});
    mocks.retryJob.mockResolvedValue({});
  });

  it('summarizes the evidence pipeline and routes users to operational workflows', async () => {
    renderRoute();

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
    expect(screen.getByLabelText('Evidence pipeline')).toHaveTextContent('Timestamp evidence');
    expect(screen.getByRole('link', { name: /Open Library/ })).toHaveAttribute('href', '/library');
    expect(screen.getByRole('link', { name: /Search evidence/ })).toHaveAttribute(
      'href',
      '/search',
    );
    expect(mocks.listAnalysisJobs).toHaveBeenCalledWith('transcribe');
    expect(mocks.listAnalysisJobs).toHaveBeenCalledWith('model_download');
    expect(mocks.dueReviews).toHaveBeenCalled();
  });

  it('checks every live capability again from one control', async () => {
    renderRoute();
    await screen.findByText('Ready');

    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));

    await waitFor(() => expect(mocks.analysisCapability).toHaveBeenCalledTimes(2));
    expect(mocks.listModels).toHaveBeenCalledTimes(2);
    expect(mocks.cloudStatus).toHaveBeenCalledTimes(2);
    expect(mocks.listAnalysisJobs).toHaveBeenCalledTimes(4);
    expect(await screen.findByText('AI Studio status is up to date.')).toBeInTheDocument();
  });

  it('keeps the workflow guide available when desktop status cannot be loaded', async () => {
    mocks.listModels.mockRejectedValue(new Error('desktop unavailable'));
    mocks.cloudStatus.mockRejectedValue(new Error('desktop unavailable'));
    mocks.listAnalysisJobs.mockRejectedValue(new Error('desktop unavailable'));
    mocks.analysisCapability.mockRejectedValue(new Error('desktop unavailable'));
    mocks.dueReviews.mockRejectedValue(new Error('desktop unavailable'));

    renderRoute();

    expect(await screen.findByText(/Live AI status is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Launch a grounded workflow' })).toBeInTheDocument();
    expect(screen.getByText('Private media')).toBeInTheDocument();
  });

  it('does not report ready when the model exists but the native engine is missing', async () => {
    mocks.analysisCapability.mockResolvedValue({
      available: false,
      engine: 'whisper.cpp',
      expected_version: '1.9.2',
      unavailable_reason: 'whisper_missing',
      message: 'Install the local whisper.cpp engine.',
      supported_languages: ['en', 'bn'],
    });

    renderRoute();

    expect(await screen.findByText('Setup needed')).toBeInTheDocument();
    expect(screen.getByText('Install the local whisper.cpp engine.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open engine diagnostics' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('offers an inline verified bilingual model install with progress', async () => {
    mocks.listModels.mockResolvedValue([
      { ...bilingualModel, state: 'available', bytes_downloaded: 0 },
    ]);
    mocks.installModel.mockImplementation(
      (_modelId: string, onEvent: (event: AnalysisProgress) => void) => {
        onEvent({
          event: 'downloading',
          data: { jobId: 'model-job', downloadedBytes: 73_975_733, totalBytes: 147_951_465 },
        });
        return Promise.resolve({
          id: 'model-job',
          kind: 'model_download',
          status: 'running',
          attempt: 0,
          last_error: null,
          created_at: '2026-08-20T10:00:00Z',
          updated_at: '2026-08-20T10:00:00Z',
        } satisfies AnalysisJob);
      },
    );

    renderRoute();

    fireEvent.click(await screen.findByRole('button', { name: /Install 141 MB model/ }));

    await waitFor(() =>
      expect(mocks.installModel).toHaveBeenCalledWith('whisper-base', expect.any(Function)),
    );
    expect(
      await screen.findByRole('progressbar', { name: 'Bilingual model download' }),
    ).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText(/Model installation queued/)).toBeInTheDocument();
  });

  it('replaces queued copy with a clear verified-ready model notice', async () => {
    mocks.listModels.mockResolvedValue([
      { ...bilingualModel, state: 'available', bytes_downloaded: 0 },
    ]);
    mocks.installModel.mockImplementation(
      (_modelId: string, onEvent: (event: AnalysisProgress) => void) => {
        onEvent({ event: 'completed', data: { jobId: 'model-job' } });
        return Promise.resolve({
          id: 'model-job',
          kind: 'model_download',
          status: 'completed',
          attempt: 0,
          last_error: null,
          created_at: '2026-08-20T10:00:00Z',
          updated_at: '2026-08-20T10:01:00Z',
        } satisfies AnalysisJob);
      },
    );

    renderRoute();
    fireEvent.click(await screen.findByRole('button', { name: /Install 141 MB model/ }));

    expect(
      await screen.findByText(
        'Whisper Base Multilingual is verified and ready for English and Bangla.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Model installation queued/)).not.toBeInTheDocument();
  });

  it('turns due learning items into the recommended next action', async () => {
    mocks.dueReviews.mockResolvedValue([{ id: 'review-1' }, { id: 'review-2' }]);

    renderRoute();

    expect(await screen.findByText('2 due')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '2 grounded questions are ready' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start due review' })).toHaveAttribute('href', '/');
  });

  it('surfaces recent durable work and failed-job recovery context', async () => {
    mocks.listAnalysisJobs.mockImplementation((kind: AnalysisJob['kind']) =>
      Promise.resolve(
        kind === 'transcribe'
          ? [
              {
                id: 'transcribe-1',
                kind: 'transcribe',
                status: 'failed',
                attempt: 1,
                last_error: 'Audio stream could not be decoded.',
                created_at: '2026-08-20T10:00:00Z',
                updated_at: '2026-08-20T10:01:00Z',
              },
            ]
          : [],
      ),
    );

    renderRoute();

    expect(await screen.findByText('1 need help')).toBeInTheDocument();
    expect(screen.getByText('Lecture transcription')).toBeInTheDocument();
    expect(screen.getByText('Audio stream could not be decoded.')).toBeInTheDocument();
    expect(screen.getByText('Needs help')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Lecture transcription' }));
    await waitFor(() => expect(mocks.retryJob).toHaveBeenCalledWith('transcribe-1'));
  });

  it('only offers cancellation for work that has not started', async () => {
    mocks.allJobs.mockResolvedValue([
      {
        id: 'queued-1',
        kind: 'lecture_understanding',
        status: 'queued',
        attempt: 0,
        last_error: null,
        created_at: '2026-08-20T10:00:00Z',
        updated_at: '2026-08-20T10:00:00Z',
      },
      {
        id: 'running-1',
        kind: 'transcribe',
        status: 'running',
        attempt: 1,
        last_error: null,
        created_at: '2026-08-20T10:00:00Z',
        updated_at: '2026-08-20T10:01:00Z',
      },
    ]);

    renderRoute();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Lecture understanding' }));
    await waitFor(() => expect(mocks.cancelJob).toHaveBeenCalledWith('queued-1'));
    expect(screen.queryByRole('button', { name: 'Cancel Lecture transcription' })).toBeNull();
  });

  it('does not claim Bangla readiness from an English-only model', async () => {
    mocks.listModels.mockResolvedValue([
      { ...bilingualModel, id: 'whisper-base.en', supported_languages: ['en'] },
    ]);

    renderRoute();

    expect(await screen.findByText('Setup needed')).toBeInTheDocument();
    expect(
      screen.getByText('English is ready. Add the multilingual model for Bangla.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('English and Bangla models are verified locally'),
    ).not.toBeInTheDocument();
  });
});
