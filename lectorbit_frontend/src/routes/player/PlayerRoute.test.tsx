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
};

function renderRoute() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/player/item-1']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/player/:itemId" element={<PlayerRoute />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('PlayerRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(screen.getByLabelText('Playing Graph theory')).toHaveAttribute('src', view.stream_url);
    expect(screen.getByRole('progressbar', { name: 'Watched coverage' })).toHaveAttribute(
      'aria-valuenow',
      '20',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(mocks.play).toHaveBeenCalled());
  });

  it('requires confirmation before recording skip', async () => {
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(mocks.action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm skip' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('item-1', 'skip', undefined));
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
