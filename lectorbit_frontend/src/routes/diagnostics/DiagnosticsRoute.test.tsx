import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DiagnosticsRoute } from './DiagnosticsRoute';
import * as diagnosticsIpc from '../../ipc/diagnostics';

const fixture = {
  generated_at: '2026-08-08T00:00:00.000Z',
  app: {
    version: '0.1.0',
    build: 'test',
    target_triple: 'x86_64-pc-windows-msvc',
    elapsed_since_launch: { secs: 3600 + 120, nanos: 0 },
  },
  database: {
    schema_version: 1,
    migrations_applied: 1,
    sqlite_version: '3.53.0',
    journal_mode: 'wal',
    foreign_keys: true,
    size_bytes: 4096,
    path_redacted: '[REDACTED]/lectordb.sqlite',
  },
  library: {
    root_count: 3,
    active_root_count: 2,
    media_count: 17,
  },
  ai: {
    whisper_model_present: false,
    ocr_model_present: false,
    embeddings_model_present: false,
    last_consent: null,
  },
  recent_errors: ['error: [REDACTED] failed'],
};

function renderWithProviders() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DiagnosticsRoute />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('routes/diagnostics/DiagnosticsRoute', () => {
  beforeEach(() => {
    vi.spyOn(diagnosticsIpc, 'getDiagnostics').mockResolvedValue(fixture);
  });

  it('renders the four KPI cards and the recent-errors card once the data arrives', async () => {
    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText('App')).toBeInTheDocument();
    });
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('AI models')).toBeInTheDocument();
    expect(screen.getByText('Recent errors')).toBeInTheDocument();
  });

  it('renders the elapsed-since-launch formatted as hours and minutes', async () => {
    renderWithProviders();
    await waitFor(() => {
      // 3720s -> "1h 2m"
      expect(screen.getByText('1h 2m')).toBeInTheDocument();
    });
  });

  it('renders an empty-state message when there are no errors', async () => {
    vi.spyOn(diagnosticsIpc, 'getDiagnostics').mockResolvedValueOnce({
      ...fixture,
      recent_errors: [],
    });
    renderWithProviders();
    await waitFor(() => {
      expect(screen.getByText('No errors recorded.')).toBeInTheDocument();
    });
  });

  it('surfaces an error state when the IPC call rejects', async () => {
    vi.spyOn(diagnosticsIpc, 'getDiagnostics').mockRejectedValueOnce(
      new Error('boom'),
    );
    renderWithProviders();
    await waitFor(() => {
      expect(screen.getByText('Diagnostics unavailable')).toBeInTheDocument();
    });
  });
});