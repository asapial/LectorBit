import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
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
  listMediaMock:
    vi.fn<(options?: { rootId?: string; cursor?: string; limit?: number }) => Promise<MediaPage>>(),
  listScanJobsMock: vi.fn<() => Promise<ScanJob[]>>(),
  pickAndRegisterRootMock: vi.fn<() => Promise<LibraryRoot | null>>(),
  revokeRootMock: vi.fn<(id: string) => Promise<LibraryRoot>>(),
  startScanMock: vi.fn<(rootId: string, onEvent: (event: ScanEvent) => void) => Promise<ScanJob>>(),
}));

vi.mock('../../ipc/library', () => ({
  listRoots: () => listRootsMock(),
  listMedia: (options?: { rootId?: string; cursor?: string; limit?: number }) =>
    listMediaMock(options),
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
    <MemoryRouter initialEntries={['/library']}>
      <QueryClientProvider client={queryClient}>
        <LibraryRoute />
      </QueryClientProvider>
    </MemoryRouter>,
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
    expect(screen.getByRole('button', { name: /add your first folder/i })).toBeInTheDocument();
  });

  it('shows safe root metadata and scan state', async () => {
    listRootsMock.mockResolvedValueOnce([activeRoot]);
    listScanJobsMock.mockResolvedValueOnce([queuedJob]);
    renderRoute();
    expect(await screen.findByRole('heading', { name: 'Videos' })).toBeInTheDocument();
    expect(screen.getAllByText('[REDACTED]/Videos')).toHaveLength(2);
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
    fireEvent.click(await screen.findByRole('button', { name: /^next$/i }));

    expect(await screen.findByText('second.mp4')).toBeInTheDocument();
    expect(screen.queryByText('first.mp4')).not.toBeInTheDocument();
    expect(screen.getAllByText('Page 2 of 2')).toHaveLength(2);
    expect(listMediaMock).toHaveBeenLastCalledWith({
      rootId: 'root-1',
      cursor: 'cursor-1',
      limit: 10,
    });
  });

  it('renders every selected folder as an independent media module', async () => {
    const secondRoot: LibraryRoot = {
      ...activeRoot,
      id: 'root-2',
      display_name: 'Statistics',
      path_redacted: '[REDACTED]/Statistics',
    };
    listRootsMock.mockResolvedValueOnce([activeRoot, secondRoot]);
    listMediaMock.mockImplementation(({ rootId } = {}) =>
      Promise.resolve({
        items:
          rootId === 'root-2'
            ? [
                {
                  id: 'stats-media',
                  root_id: 'root-2',
                  display_name: 'Regression.mp4',
                  path_redacted: '[REDACTED]/Statistics/Regression.mp4',
                  media_kind: 'video',
                  size_bytes: 2_048,
                  duration_ms: 600_000,
                  container: 'mp4',
                  video_codec: 'h264',
                  audio_codec: 'aac',
                  width: 1280,
                  height: 720,
                  audio_streams: 1,
                  subtitle_streams: 0,
                  probe_status: 'ready',
                  probe_error: null,
                  discovered_at: '2026-08-08T00:00:00Z',
                },
              ]
            : rootId === 'root-1'
              ? [
                  {
                    id: 'videos-media',
                    root_id: 'root-1',
                    display_name: 'Introduction.mp4',
                    path_redacted: '[REDACTED]/Videos/Introduction.mp4',
                    media_kind: 'video',
                    size_bytes: 1_024,
                    duration_ms: 120_000,
                    container: 'mp4',
                    video_codec: 'h264',
                    audio_codec: 'aac',
                    width: 1280,
                    height: 720,
                    audio_streams: 1,
                    subtitle_streams: 0,
                    probe_status: 'ready',
                    probe_error: null,
                    discovered_at: '2026-08-08T00:00:00Z',
                  },
                ]
              : [],
        next_cursor: null,
      }),
    );

    renderRoute();

    const videosModule = await screen.findByRole('region', { name: 'Videos' });
    const statisticsModule = screen.getByRole('region', { name: 'Statistics' });

    expect(await within(videosModule).findByText('Introduction.mp4')).toBeInTheDocument();
    expect(within(videosModule).queryByText('Regression.mp4')).not.toBeInTheDocument();
    expect(within(videosModule).getByText('2m')).toBeInTheDocument();
    expect(await within(statisticsModule).findByText('Regression.mp4')).toBeInTheDocument();
    expect(within(statisticsModule).queryByText('Introduction.mp4')).not.toBeInTheDocument();
    expect(within(statisticsModule).getByText('10m')).toBeInTheDocument();
    expect(
      within(statisticsModule).getByRole('link', {
        name: 'Plan Statistics module with AI',
      }),
    ).toHaveAttribute('href', '/plan?module=root-2');
    expect(listMediaMock).toHaveBeenCalledWith({ rootId: 'root-1', cursor: undefined, limit: 10 });
    expect(listMediaMock).toHaveBeenCalledWith({ rootId: 'root-2', cursor: undefined, limit: 10 });
  });

  it('keeps pagination independent for each folder module', async () => {
    const secondRoot: LibraryRoot = {
      ...activeRoot,
      id: 'root-2',
      display_name: 'Statistics',
      path_redacted: '[REDACTED]/Statistics',
    };
    const base = {
      path_redacted: '[REDACTED]/lesson.mp4',
      media_kind: 'video' as const,
      size_bytes: 100,
      duration_ms: 60_000,
      container: 'mp4',
      video_codec: 'h264',
      audio_codec: 'aac',
      width: 1280,
      height: 720,
      audio_streams: 1,
      subtitle_streams: 0,
      probe_status: 'ready' as const,
      probe_error: null,
      discovered_at: '2026-08-08T00:00:00Z',
    };
    listRootsMock.mockResolvedValueOnce([activeRoot, secondRoot]);
    listMediaMock.mockImplementation(({ rootId, cursor } = {}) => {
      if (rootId === 'root-2' && cursor === 'stats-next') {
        return Promise.resolve({
          items: [{ ...base, id: 'stats-2', root_id: 'root-2', display_name: 'Statistics 2.mp4' }],
          next_cursor: null,
          summary: {
            total_items: 20,
            ready_items: 20,
            attention_items: 0,
            known_duration_ms: 1_200_000,
            duration_known_items: 20,
          },
        });
      }
      if (rootId === 'root-2') {
        return Promise.resolve({
          items: [{ ...base, id: 'stats-1', root_id: 'root-2', display_name: 'Statistics 1.mp4' }],
          next_cursor: 'stats-next',
          summary: {
            total_items: 20,
            ready_items: 20,
            attention_items: 0,
            known_duration_ms: 1_200_000,
            duration_known_items: 20,
          },
        });
      }
      return Promise.resolve({
        items: [{ ...base, id: 'video-1', root_id: 'root-1', display_name: 'Video 1.mp4' }],
        next_cursor: 'videos-next',
      });
    });

    renderRoute();

    const statisticsModule = await screen.findByRole('region', { name: 'Statistics' });
    expect(await within(statisticsModule).findByText('20m')).toBeInTheDocument();
    expect(within(statisticsModule).getByText('20 of 20 durations known')).toBeInTheDocument();
    fireEvent.click(await within(statisticsModule).findByRole('button', { name: /^next$/i }));

    expect(await within(statisticsModule).findByText('Statistics 2.mp4')).toBeInTheDocument();
    expect(listMediaMock).toHaveBeenCalledWith({
      rootId: 'root-2',
      cursor: 'stats-next',
      limit: 10,
    });
    expect(listMediaMock).not.toHaveBeenCalledWith({
      rootId: 'root-1',
      cursor: 'videos-next',
      limit: 10,
    });
    expect(
      within(screen.getByRole('region', { name: 'Videos' })).queryByText('Statistics 2.mp4'),
    ).not.toBeInTheDocument();
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

  it('does not render a metadata retry button on individual video rows', async () => {
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
    expect(await screen.findByText('needs-metadata.mp4')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry metadata/i })).not.toBeInTheDocument();
    expect(startScanMock).not.toHaveBeenCalled();
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
