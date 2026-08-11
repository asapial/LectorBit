import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryRoot, ScanEvent, ScanJob } from '../../ipc/library';
import { LibraryRoute } from './LibraryRoute';

const {
  listRootsMock,
  listScanJobsMock,
  pickAndRegisterRootMock,
  revokeRootMock,
  startScanMock,
} = vi.hoisted(() => ({
  listRootsMock: vi.fn<() => Promise<LibraryRoot[]>>(),
  listScanJobsMock: vi.fn<() => Promise<ScanJob[]>>(),
  pickAndRegisterRootMock: vi.fn<() => Promise<LibraryRoot | null>>(),
  revokeRootMock: vi.fn<(id: string) => Promise<LibraryRoot>>(),
  startScanMock:
    vi.fn<
      (rootId: string, onEvent: (event: ScanEvent) => void) => Promise<ScanJob>
    >(),
}));

vi.mock('../../ipc/library', () => ({
  listRoots: () => listRootsMock(),
  listScanJobs: () => listScanJobsMock(),
  pickAndRegisterRoot: () => pickAndRegisterRootMock(),
  revokeRoot: (id: string) => revokeRootMock(id),
  startScan: (rootId: string, onEvent: (event: ScanEvent) => void) =>
    startScanMock(rootId, onEvent),
  LibraryRpcError: class extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
      this.name = 'LibraryRpcError';
    }
  },
}));

const activeRoot: LibraryRoot = {
  id: 'root-1',
  display_name: 'Videos',
  path_redacted: '[REDACTED]/Videos',
  registered_at: '2026-08-08T10:00:00Z',
  revoked_at: null,
  is_active: true,
};

const queuedJob: ScanJob = {
  id: 'job-1',
  root_id: 'root-1',
  status: 'queued',
  attempt: 0,
  last_error: null,
  created_at: '2026-08-08T10:00:00Z',
  updated_at: '2026-08-08T10:00:00Z',
};

function renderRoute() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LibraryRoute />
    </QueryClientProvider>,
  );
}

describe('LibraryRoute', () => {
  beforeEach(() => {
    listRootsMock.mockReset();
    listScanJobsMock.mockReset();
    pickAndRegisterRootMock.mockReset();
    revokeRootMock.mockReset();
    startScanMock.mockReset();
    listRootsMock.mockResolvedValue([]);
    listScanJobsMock.mockResolvedValue([]);
    startScanMock.mockResolvedValue(queuedJob);
  });

  it('renders the actionable empty state', async () => {
    listRootsMock.mockResolvedValueOnce([]);
    renderRoute();
    expect(await screen.findByText(/no folders yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /add your first folder/i }),
    ).toBeInTheDocument();
  });

  it('shows safe root metadata and scan state', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    listScanJobsMock.mockResolvedValueOnce([queuedJob]);
    renderRoute();
    expect(await screen.findByText('Videos')).toBeInTheDocument();
    expect(screen.getByText('[REDACTED]/Videos')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  it('registers with the privileged picker and starts the first scan', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    pickAndRegisterRootMock.mockResolvedValueOnce(activeRoot);
    renderRoute();
    const addButton = await screen.findByRole('button', { name: /add folder/i });
    await waitFor(() => expect(addButton).toBeEnabled());
    fireEvent.click(addButton);
    await waitFor(() => expect(pickAndRegisterRootMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(startScanMock).toHaveBeenCalledOnce());
    expect(startScanMock.mock.calls[0]?.[0]).toBe('root-1');
  });

  it('does not scan when the native picker is cancelled', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    pickAndRegisterRootMock.mockResolvedValueOnce(null);
    renderRoute();
    const addButton = await screen.findByRole('button', { name: /add folder/i });
    await waitFor(() => expect(addButton).toBeEnabled());
    fireEvent.click(addButton);
    await waitFor(() => expect(pickAndRegisterRootMock).toHaveBeenCalledOnce());
    expect(startScanMock).not.toHaveBeenCalled();
  });

  it('queues an explicit rescan from the row action', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    renderRoute();
    const scanButton = await screen.findByRole('button', { name: /^scan$/i });
    fireEvent.click(scanButton);
    await waitFor(() => expect(startScanMock).toHaveBeenCalledOnce());
    expect(startScanMock.mock.calls[0]?.[0]).toBe('root-1');
  });

  it('confirms before revoking a folder', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    revokeRootMock.mockResolvedValueOnce({
      ...activeRoot,
      is_active: false,
      revoked_at: '2026-08-09T00:00:00Z',
    });
    renderRoute();
    fireEvent.click(await screen.findByRole('button', { name: /^revoke$/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /revoke root/i }));
    await waitFor(() => expect(revokeRootMock).toHaveBeenCalledWith('root-1'));
  });
});
