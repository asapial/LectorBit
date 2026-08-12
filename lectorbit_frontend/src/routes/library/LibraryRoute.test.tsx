import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryRoot, MediaPage, ScanEvent, ScanJob } from '../../ipc/library';
import { LibraryRoute } from './LibraryRoute';

const {
  listRootsMock,
  listMediaMock,
  listScanJobsMock,
  pickAndRegisterRootMock,
  revokeRootMock,
  startScanMock,
} = vi.hoisted(() => ({
  listRootsMock: vi.fn<() => Promise<LibraryRoot[]>>(),
  listMediaMock: vi.fn<(options?: { cursor?: string }) => Promise<MediaPage>>(),
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
  listMedia: (options?: { cursor?: string }) => listMediaMock(options),
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
    listMediaMock.mockReset();
    listScanJobsMock.mockReset();
    pickAndRegisterRootMock.mockReset();
    revokeRootMock.mockReset();
    startScanMock.mockReset();
    listRootsMock.mockResolvedValue([]);
    listMediaMock.mockResolvedValue({ items: [], next_cursor: null });
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

  it('shows duration, streams, and an icon-labelled metadata state', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    listMediaMock.mockResolvedValue({
      items: [
        {
          id: 'media-1',
          root_id: 'root-1',
          display_name: 'lesson.mp4',
          path_redacted: '[REDACTED]/lesson.mp4',
          media_kind: 'video',
          size_bytes: 1_048_576,
          duration_ms: 90_000,
          container: 'matroska',
          video_codec: 'h264',
          audio_codec: 'aac',
          width: 1920,
          height: 1080,
          audio_streams: 1,
          subtitle_streams: 1,
          probe_status: 'ready',
          probe_error: null,
          discovered_at: '2026-08-08T00:00:00Z',
        },
      ],
      next_cursor: null,
    });

    renderRoute();

    expect(await screen.findByText('lesson.mp4')).toBeInTheDocument();
    expect(screen.getByText('1:30')).toBeInTheDocument();
    expect(screen.getByText(/H264 · 1920×1080 · MATROSKA/)).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('[REDACTED]/lesson.mp4 · 1.0 MB')).toBeInTheDocument();
  });

  it('loads the next media page from the opaque cursor', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    const base = {
      root_id: 'root-1',
      path_redacted: '[REDACTED]/lesson.mp4',
      media_kind: 'video' as const,
      size_bytes: 100,
      duration_ms: null,
      container: null,
      video_codec: null,
      audio_codec: null,
      width: null,
      height: null,
      audio_streams: 0,
      subtitle_streams: 0,
      probe_status: 'ready' as const,
      probe_error: null,
      discovered_at: '2026-08-08T00:00:00Z',
    };
    listMediaMock
      .mockResolvedValueOnce({
        items: [{ ...base, id: 'media-1', display_name: 'first.mp4' }],
        next_cursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        items: [{ ...base, id: 'media-2', display_name: 'second.mp4' }],
        next_cursor: null,
      });

    renderRoute();
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }));

    expect(await screen.findByText('second.mp4')).toBeInTheDocument();
    expect(listMediaMock).toHaveBeenLastCalledWith({ cursor: 'cursor-1', limit: 50 });
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
    const scanButton = await screen.findByRole('button', { name: /^scan folder$/i });
    fireEvent.click(scanButton);
    await waitFor(() => expect(startScanMock).toHaveBeenCalledOnce());
    expect(startScanMock.mock.calls[0]?.[0]).toBe('root-1');
  });

  it('confirms before removing a folder from the active library', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    revokeRootMock.mockResolvedValueOnce({
      ...activeRoot,
      is_active: false,
      revoked_at: '2026-08-09T00:00:00Z',
    });
    renderRoute();
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/original files and folders remain untouched/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove folder/i }));
    await waitFor(() => expect(revokeRootMock).toHaveBeenCalledWith('root-1'));
  });

  it('retries unavailable metadata by rescanning the owning folder', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    listMediaMock.mockResolvedValue({
      items: [
        {
          id: 'media-unavailable',
          root_id: 'root-1',
          display_name: 'needs-metadata.mp4',
          path_redacted: '[REDACTED]/needs-metadata.mp4',
          media_kind: 'video',
          size_bytes: 1_024,
          duration_ms: null,
          container: null,
          video_codec: null,
          audio_codec: null,
          width: null,
          height: null,
          audio_streams: 0,
          subtitle_streams: 0,
          probe_status: 'unavailable',
          probe_error: 'Media inspection is not available in this installation.',
          discovered_at: '2026-08-08T00:00:00Z',
        },
      ],
      next_cursor: null,
    });

    renderRoute();
    fireEvent.click(await screen.findByRole('button', { name: /retry metadata/i }));

    await waitFor(() => expect(startScanMock).toHaveBeenCalledOnce());
    expect(startScanMock.mock.calls[0]?.[0]).toBe('root-1');
  });

  it('does not show previously removed folders in the active folder list', async () => {
    listRootsMock.mockResolvedValueOnce([
      { ...activeRoot, is_active: false, revoked_at: '2026-08-09T00:00:00Z' },
    ]);

    renderRoute();

    expect(await screen.findByText(/no folders yet/i)).toBeInTheDocument();
    expect(screen.queryByText('[REDACTED]/Videos')).not.toBeInTheDocument();
  });
});
