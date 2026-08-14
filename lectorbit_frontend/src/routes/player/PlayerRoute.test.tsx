import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerRoute } from './PlayerRoute';

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  speed: vi.fn(),
  sync: vi.fn(),
  state: vi.fn(),
  action: vi.fn(),
  replan: vi.fn(),
  getLecture: vi.fn(),
  startLecture: vi.fn(),
  explainFrame: vi.fn(),
  listNotes: vi.fn(),
  generateMaterials: vi.fn(),
  listMaterials: vi.fn(),
  recordReview: vi.fn(),
  companion: vi.fn(),
}));

vi.mock('../../ipc/playback', () => ({
  getPlaybackCapability: mocks.capability,
  openPlayback: mocks.open,
  closePlayback: mocks.close,
  playPlayback: mocks.play,
  pausePlayback: mocks.pause,
  seekPlayback: mocks.seek,
  setPlaybackSpeed: mocks.speed,
  syncPlayback: mocks.sync,
  getPlaybackState: mocks.state,
  recordStudyAction: mocks.action,
}));
vi.mock('../../ipc/planner', () => ({ replanActive: mocks.replan }));
vi.mock('../../ipc/learning', () => ({
  getLectureUnderstanding: mocks.getLecture,
  startLectureUnderstanding: mocks.startLecture,
  explainFrame: mocks.explainFrame,
  listExplanationNotes: mocks.listNotes,
  generateStudyMaterials: mocks.generateMaterials,
  listStudyMaterials: mocks.listMaterials,
  recordReview: mocks.recordReview,
  askCompanion: mocks.companion,
}));

const view = {
  plan_item_id: 'item-1',
  media_id: 'media-1',
  display_name: 'Graph theory',
  raw_start_ms: 60_000,
  raw_end_ms: 1_560_000,
  position_ms: 120_000,
  duration_ms: 3_600_000,
  paused: true,
  speed: 1,
  progress_version: 3,
  item_covered_ms: 300_000,
  item_duration_ms: 1_500_000,
  completed: false,
  stream_url: 'http://lector-media.localhost/0123456789abcdef0123456789abcdef',
  caption_tracks: [
    {
      label: 'Captions',
      language: 'en',
      url: 'http://lector-media.localhost/fedcba9876543210fedcba9876543210',
    },
  ],
};

function renderRoute(initialEntry = '/player/item-1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/player/:itemId" element={<PlayerRoute />} />
          <Route path="/" element={<div>Routine destination</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...rendered, queryClient };
}

describe('PlayerRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    mocks.capability.mockResolvedValue({
      available: true,
      backend: 'lectorbit-media',
      expected_version: 'built-in',
      detected_version: 'WebView media',
    });
    mocks.open.mockResolvedValue(view);
    mocks.close.mockResolvedValue(undefined);
    mocks.play.mockResolvedValue({ ...view, paused: false });
    mocks.pause.mockResolvedValue(view);
    mocks.seek.mockResolvedValue(view);
    mocks.speed.mockResolvedValue(view);
    mocks.sync.mockResolvedValue(view);
    mocks.state.mockResolvedValue(view);
    mocks.action.mockResolvedValue(undefined);
    mocks.getLecture.mockResolvedValue(null);
    mocks.listNotes.mockResolvedValue([]);
    mocks.listMaterials.mockResolvedValue([]);
    mocks.startLecture.mockResolvedValue({
      id: 'learning-job',
      kind: 'lecture_understanding',
      status: 'queued',
      attempt: 0,
      last_error: null,
      created_at: '2026-08-14T00:00:00Z',
      updated_at: '2026-08-14T00:00:00Z',
    });
    mocks.replan.mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version-2',
      created_at: '2026-08-12T00:00:00Z',
    });
  });

  it('opens the route item and renders coverage-based controls', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    renderRoute();
    expect(await screen.findByRole('heading', { name: 'Graph theory' })).toBeInTheDocument();
    expect(mocks.open).toHaveBeenCalledWith('item-1', expect.any(Function));
    const video = screen.getByLabelText('Playing Graph theory');
    expect(video).toHaveAttribute('src', view.stream_url);
    expect(video).toHaveAttribute('crossorigin', 'anonymous');
    expect(video.querySelector('track[kind="captions"]')).toMatchObject({
      src: view.caption_tracks[0].url,
      srclang: view.caption_tracks[0].language,
      label: view.caption_tracks[0].label,
    });
    expect(screen.getByRole('progressbar', { name: 'Watched coverage' })).toHaveAttribute(
      'aria-valuenow',
      '20',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(mocks.play).toHaveBeenCalled());
  });

  it('preserves the saved resume point when no timestamp query is present', async () => {
    mocks.open.mockResolvedValue({ ...view, raw_start_ms: 0, position_ms: 120_000 });
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it('applies an explicit in-block timestamp from search results', async () => {
    mocks.seek.mockResolvedValue({ ...view, position_ms: 300_000 });
    renderRoute('/player/item-1?t=300000');
    await screen.findByRole('heading', { name: 'Graph theory' });
    expect(mocks.seek).toHaveBeenCalledWith(300_000);
  });

  it('requires confirmation before recording skip', async () => {
    const { queryClient } = renderRoute();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(mocks.action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm skip' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('item-1', 'skip', undefined));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['planner', 'routine'] });
    expect(mocks.action.mock.invocationCallOrder[0]).toBeLessThan(
      invalidate.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['Mark complete', 'complete'],
    ['Postpone', 'postpone'],
    ['Repeat', 'repeat'],
    ['Must watch', 'must_watch'],
  ] as const)('records the %s study action', async (buttonName, action) => {
    const { queryClient } = renderRoute();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('item-1', action, undefined));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['planner', 'routine'] });
    expect(mocks.action.mock.invocationCallOrder[0]).toBeLessThan(
      invalidate.mock.invocationCallOrder[0],
    );
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.state.mock.invocationCallOrder[0],
    );
    expect(mocks.state).toHaveBeenCalled();
  });

  it('refreshes the visible completion state after marking the block complete', async () => {
    mocks.state.mockResolvedValue({ ...view, paused: true, completed: true });
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }));
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark complete' })).toBeDisabled();
  });

  it('records split at the live video position instead of a stale synced position', async () => {
    const { queryClient } = renderRoute();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 321 });
    fireEvent.click(screen.getByRole('button', { name: 'Split here' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('item-1', 'split', 321_000));
    expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.action.mock.invocationCallOrder[0],
    );
    expect(mocks.action.mock.invocationCallOrder[0]).toBeLessThan(
      invalidate.mock.invocationCallOrder[0],
    );
  });

  it('rejects a split at the block boundary before sending an invalid action', async () => {
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 1_560 });
    fireEvent.click(screen.getByRole('button', { name: 'Split here' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/inside the study block/i);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('checkpoints at the old playback rate before changing speed', async () => {
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 321 });
    mocks.sync.mockResolvedValue({ ...view, position_ms: 321_000 });
    mocks.seek.mockResolvedValue({ ...view, position_ms: 321_000 });
    mocks.speed.mockResolvedValue({ ...view, position_ms: 321_000, speed: 1.5 });
    mocks.sync.mockClear();
    mocks.seek.mockClear();
    fireEvent.change(screen.getByLabelText('Playback speed'), { target: { value: '1.5' } });
    await waitFor(() => expect(mocks.speed).toHaveBeenCalledWith(1.5));
    expect(mocks.sync).toHaveBeenCalledWith(321_000, expect.any(Boolean), 1);
    expect(mocks.seek).toHaveBeenCalledWith(321_000);
    expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.seek.mock.invocationCallOrder[0],
    );
    expect(mocks.seek.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.speed.mock.invocationCallOrder[0],
    );
    expect((video as HTMLVideoElement).playbackRate).toBe(1.5);
  });

  it('keeps native video seeking inside the scheduled study block', async () => {
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 10 });
    fireEvent.seeking(video);
    expect((video as HTMLVideoElement).currentTime).toBe(60);
  });

  it('flushes the latest position when the page is being hidden', async () => {
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 360 });
    fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith(360_000, expect.any(Boolean), 1));
  });

  it('flushes the latest video position before closing', async () => {
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 240 });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalled());
    expect(mocks.sync).toHaveBeenCalledWith(240_000, expect.any(Boolean), 1);
    expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0],
    );
  });

  it('uses the awaited close flow when the header returns to Routine', async () => {
    let finishClose: (() => void) | undefined;
    mocks.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const { queryClient } = renderRoute();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 240 });

    fireEvent.click(screen.getByRole('button', { name: 'Routine' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalled());
    expect(screen.queryByText('Routine destination')).not.toBeInTheDocument();
    expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(
      invalidate.mock.invocationCallOrder[0],
    );
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0],
    );

    finishClose?.();
    expect(await screen.findByText('Routine destination')).toBeInTheDocument();
  });

  it('flushes progress before route cleanup closes an open playback session', async () => {
    const rendered = renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 480 });
    rendered.unmount();
    await waitFor(() => expect(mocks.close).toHaveBeenCalled());
    expect(mocks.sync).toHaveBeenCalledWith(480_000, expect.any(Boolean), 1);
    expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0],
    );
  });

  it('does not display 90 percent before the completion threshold is reached', async () => {
    mocks.open.mockResolvedValue({
      ...view,
      item_covered_ms: 1_349_999,
      item_duration_ms: 1_500_000,
    });
    renderRoute();
    expect(await screen.findByRole('progressbar', { name: 'Watched coverage' })).toHaveAttribute(
      'aria-valuenow',
      '89',
    );
  });

  it('closes playback before creating a remaining-work plan version', async () => {
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Replan remaining' }));
    await waitFor(() =>
      expect(mocks.replan).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)),
    );
    expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replan.mock.invocationCallOrder[0],
    );
    expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0],
    );
  });

  it('shows a stable unavailable message without opening media', async () => {
    mocks.capability.mockResolvedValue({
      available: false,
      backend: 'lectorbit-media',
      expected_version: 'built-in',
      detected_version: null,
    });
    renderRoute();
    expect(await screen.findByText('Playback could not start')).toBeInTheDocument();
    expect(screen.getByText(/lectorbit-media/)).toBeInTheDocument();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('reports stream failures precisely and can retry the media element', async () => {
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 2, message: 'network failure' },
    });

    fireEvent.error(video);
    expect(screen.getByText(/private local video stream could not be read/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry stream/i }));
    expect(load).toHaveBeenCalled();
  });
});
