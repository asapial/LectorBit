import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerRoute } from './PlayerRoute';
import type { AnalysisProgress } from '../../ipc/analysis';
import type { LearningProgress } from '../../ipc/learning';

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
  routine: vi.fn(),
  replan: vi.fn(),
  cloudStatus: vi.fn(),
  analysisCapability: vi.fn(),
  models: vi.fn(),
  installModel: vi.fn(),
  transcriptState: vi.fn(),
  transcriptDocument: vi.fn(),
  correctTranscript: vi.fn(),
  transcribe: vi.fn(),
  getLecture: vi.fn(),
  startLecture: vi.fn(),
  explainFrame: vi.fn(),
  listNotes: vi.fn(),
  generateMaterials: vi.fn(),
  listMaterials: vi.fn(),
  recordReview: vi.fn(),
  companion: vi.fn(),
  listAnnotations: vi.fn(),
  createAnnotation: vi.fn(),
  setAnnotationReviewed: vi.fn(),
  removeAnnotation: vi.fn(),
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
vi.mock('../../ipc/planner', () => ({
  getRoutine: mocks.routine,
  replanActive: mocks.replan,
  getCloudPlanningStatus: mocks.cloudStatus,
}));
vi.mock('../../ipc/analysis', () => ({
  getAnalysisCapability: mocks.analysisCapability,
  listModels: mocks.models,
  installModel: mocks.installModel,
  getTranscriptState: mocks.transcriptState,
  getTranscriptDocument: mocks.transcriptDocument,
  correctTranscriptSegment: mocks.correctTranscript,
  startTranscription: mocks.transcribe,
}));
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
vi.mock('../../ipc/annotations', () => ({
  listLearningAnnotations: mocks.listAnnotations,
  createLearningAnnotation: mocks.createAnnotation,
  setLearningAnnotationReviewed: mocks.setAnnotationReviewed,
  removeLearningAnnotation: mocks.removeAnnotation,
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

const evidence = [{ segment_id: 1, start_ms: 120_000, end_ms: 132_000 }];

const lectureUnderstanding = {
  artifact_id: 'artifact-1',
  media_id: 'media-1',
  transcript_id: 'transcript-1',
  summary: { text: 'A grounded summary of graph traversal.', evidence },
  learning_objectives: [{ text: 'Compare breadth-first and depth-first search.', evidence }],
  chapters: [
    {
      title: 'Graph traversal',
      summary: 'Introduces traversal strategies.',
      start_ms: 120_000,
      end_ms: 300_000,
      evidence,
    },
  ],
  concepts: [{ name: 'Frontier', definition: 'The next nodes available to visit.', evidence }],
  prerequisites: [],
  key_examples: [],
  difficulty: {
    level: 'medium',
    confidence: 'high',
    reason: 'Uses prior data structures.',
    evidence,
  },
  model: 'openrouter/free',
  created_at: '2026-08-14T00:00:00Z',
};

const frameNote = {
  id: 'note-1',
  media_id: 'media-1',
  transcript_id: 'transcript-1',
  at_ms: 321_000,
  title: 'Traversal diagram',
  body_markdown: 'The highlighted edge is the next traversal step.',
  evidence,
  model: 'openrouter/free',
  frame_grounded: true,
  created_at: '2026-08-14T00:00:00Z',
};

const studyItem = {
  id: 'study-1',
  media_id: 'media-1',
  chapter_start_ms: 120_000,
  kind: 'flashcard',
  prompt: 'What is a traversal frontier?',
  answer: 'The collection of nodes available to visit next.',
  hint: 'Think about the boundary between visited and unvisited nodes.',
  options: [],
  evidence,
  due_at: '2026-08-15T00:00:00Z',
  interval_days: 0,
  repetitions: 0,
  ease_milli: 2500,
  last_quality: null,
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
    window.localStorage.clear();
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
    mocks.routine.mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version',
      title: 'Study plan',
      horizon_start: '2026-08-14',
      horizon_end: '2026-08-14',
      created_at: '2026-08-14T00:00:00Z',
      days: [
        {
          id: 'day-1',
          date: '2026-08-14',
          effective_content_ms: 1_500_000,
          break_ms: 0,
          items: [
            {
              id: 'item-1',
              media_id: 'media-1',
              display_name: 'Graph theory',
              chunk_id: 'chunk-1',
              sequence: 0,
              raw_start_ms: 60_000,
              raw_end_ms: 1_560_000,
              effective_duration_ms: 1_500_000,
              break_after_ms: 0,
              status: 'in_progress',
            },
          ],
        },
      ],
    });
    mocks.cloudStatus.mockResolvedValue({
      configured: true,
      provider: 'OpenRouter',
      model: 'openrouter/free',
    });
    mocks.analysisCapability.mockResolvedValue({
      available: true,
      engine: 'whisper.cpp',
      expected_version: '1.9.2',
      unavailable_reason: null,
      message: 'Local transcription is ready.',
      supported_languages: ['en', 'bn'],
    });
    mocks.models.mockResolvedValue([
      {
        id: 'whisper-small',
        display_name: 'Whisper Small Multilingual',
        version: '1',
        provider: 'local',
        expected_size_bytes: 1,
        architecture: 'whisper',
        analyzer_compatibility: '1',
        license: 'MIT',
        state: 'ready',
        bytes_downloaded: 1,
        verified_at: '2026-08-14T00:00:00Z',
        last_error: null,
        supported_languages: ['en', 'bn'],
      },
    ]);
    mocks.transcriptDocument.mockResolvedValue(null);
    mocks.correctTranscript.mockResolvedValue(undefined);
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'completed',
      segment_count: 42,
      language: 'en',
      model_id: 'whisper-small',
      updated_at: '2026-08-14T00:00:00Z',
      job: null,
    });
    mocks.transcribe.mockResolvedValue({
      id: 'transcription-job',
      kind: 'transcribe',
      status: 'queued',
      attempt: 0,
      last_error: null,
      created_at: '2026-08-14T00:00:00Z',
      updated_at: '2026-08-14T00:00:00Z',
    });
    mocks.installModel.mockResolvedValue({
      id: 'model-job',
      kind: 'model_download',
      status: 'queued',
      attempt: 0,
      last_error: null,
      created_at: '2026-08-14T00:00:00Z',
      updated_at: '2026-08-14T00:00:00Z',
    });
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
    mocks.explainFrame.mockResolvedValue(frameNote);
    mocks.generateMaterials.mockResolvedValue([studyItem]);
    mocks.recordReview.mockResolvedValue({
      study_item_id: 'study-1',
      due_at: '2026-08-16T00:00:00Z',
      interval_days: 1,
      repetitions: 1,
      ease_milli: 2500,
      last_quality: 5,
      updated_at: '2026-08-14T00:00:00Z',
    });
    mocks.companion.mockResolvedValue({
      action: 'explain_section',
      answer_markdown: 'This section compares two traversal frontiers.',
      evidence,
      model: 'openrouter/free',
    });
    mocks.listAnnotations.mockResolvedValue([]);
    mocks.createAnnotation.mockResolvedValue({
      id: 'annotation-1',
      media_id: 'media-1',
      at_ms: 245_000,
      kind: 'question',
      text: 'Why does breadth-first search guarantee the shortest path?',
      reviewed: false,
      created_at: '2026-08-23T00:00:00Z',
      updated_at: '2026-08-23T00:00:00Z',
    });
    mocks.setAnnotationReviewed.mockResolvedValue({
      id: 'annotation-1',
      media_id: 'media-1',
      at_ms: 245_000,
      kind: 'question',
      text: 'Why does breadth-first search guarantee the shortest path?',
      reviewed: true,
      created_at: '2026-08-23T00:00:00Z',
      updated_at: '2026-08-23T00:01:00Z',
    });
    mocks.removeAnnotation.mockResolvedValue(undefined);
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

  it('offers a distraction-free focus mode that Escape can close', async () => {
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Focus mode' }));
    expect(screen.getByRole('button', { name: 'Exit focus' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Routine' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Focus mode' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'f' });
    expect(screen.getByRole('button', { name: 'Exit focus' })).toBeInTheDocument();
  });

  it('moves to the previous or next scheduled video and saves the current position', async () => {
    mocks.routine.mockResolvedValue({
      plan_id: 'plan',
      plan_version_id: 'version',
      title: 'Study plan',
      horizon_start: '2026-08-14',
      horizon_end: '2026-08-16',
      created_at: '2026-08-14T00:00:00Z',
      days: [
        {
          id: 'day-1',
          date: '2026-08-14',
          effective_content_ms: 4_500_000,
          break_ms: 0,
          items: [
            {
              id: 'item-previous',
              media_id: 'media-previous',
              display_name: 'Sets',
              chunk_id: 'chunk-previous',
              sequence: 0,
              raw_start_ms: 0,
              raw_end_ms: 1_500_000,
              effective_duration_ms: 1_500_000,
              break_after_ms: 0,
              status: 'done',
            },
            {
              id: 'item-1',
              media_id: 'media-1',
              display_name: 'Graph theory',
              chunk_id: 'chunk-1',
              sequence: 1,
              raw_start_ms: 60_000,
              raw_end_ms: 1_560_000,
              effective_duration_ms: 1_500_000,
              break_after_ms: 0,
              status: 'in_progress',
            },
            {
              id: 'item-next',
              media_id: 'media-next',
              display_name: 'Trees',
              chunk_id: 'chunk-next',
              sequence: 2,
              raw_start_ms: 0,
              raw_end_ms: 1_500_000,
              effective_duration_ms: 1_500_000,
              break_after_ms: 0,
              status: 'pending',
            },
          ],
        },
      ],
    });

    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    expect(screen.getByRole('button', { name: 'Previous video' })).toHaveAttribute('title', 'Sets');
    expect(screen.getByText('Study block 2 of 3')).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next video' });
    expect(next).toHaveAttribute('title', 'Trees');

    fireEvent.click(next);
    await waitFor(() => expect(mocks.sync).toHaveBeenCalled());
    await waitFor(() => expect(mocks.close).toHaveBeenCalled());
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('item-next', expect.any(Function)));
  });

  it('supports keyboard playback and seeking shortcuts outside form controls', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });

    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(mocks.play).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(130_000));

    mocks.pause.mockClear();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Session intention' }), { key: ' ' });
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it('keeps a private session intention for the study block', async () => {
    const firstRender = renderRoute();
    const goal = await screen.findByRole('textbox', { name: 'Session intention' });
    fireEvent.change(goal, { target: { value: 'Understand shortest-path tradeoffs' } });
    firstRender.unmount();

    renderRoute();
    expect(await screen.findByRole('textbox', { name: 'Session intention' })).toHaveValue(
      'Understand shortest-path tradeoffs',
    );
  });

  it('keeps a private timestamped learning trail across study sessions', async () => {
    const reviewedMarker = {
      id: 'annotation-1',
      media_id: 'media-1',
      at_ms: 245_000,
      kind: 'question',
      text: 'Why does breadth-first search guarantee the shortest path?',
      reviewed: true,
      created_at: '2026-08-23T00:00:00Z',
      updated_at: '2026-08-23T00:01:00Z',
    };
    mocks.listAnnotations.mockResolvedValueOnce([]).mockResolvedValueOnce([reviewedMarker]);
    const firstRender = renderRoute();
    const video = await screen.findByLabelText<HTMLVideoElement>('Playing Graph theory');
    Object.defineProperties(video, {
      currentTime: { configurable: true, writable: true, value: 245 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    });

    const markerNote = screen.getByRole('textbox', {
      name: 'What should future-you remember?',
    });
    fireEvent.change(markerNote, {
      target: { value: 'Why does breadth-first search guarantee the shortest path?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save question' }));

    expect(
      await screen.findByText('Why does breadth-first search guarantee the shortest path?'),
    ).toBeInTheDocument();
    expect(screen.getByText('Question saved privately at 00:04:05.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replay 00:04:05' }));
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(245_000));

    fireEvent.click(screen.getByRole('button', { name: 'Mark understood' }));
    expect(await screen.findByText('Reviewed')).toBeInTheDocument();
    expect(mocks.createAnnotation).toHaveBeenCalledWith({
      mediaId: 'media-1',
      atMs: 245_000,
      kind: 'question',
      text: 'Why does breadth-first search guarantee the shortest path?',
    });
    expect(mocks.setAnnotationReviewed).toHaveBeenCalledWith({
      mediaId: 'media-1',
      annotationId: 'annotation-1',
      reviewed: true,
    });

    firstRender.unmount();
    renderRoute();
    expect(
      await screen.findByText('Why does breadth-first search guarantee the shortest path?'),
    ).toBeInTheDocument();
    expect(screen.getByText('Reviewed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(
        screen.queryByText('Why does breadth-first search guarantee the shortest path?'),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.removeAnnotation).toHaveBeenCalledWith({
      mediaId: 'media-1',
      annotationId: 'annotation-1',
    });
  });

  it('does not overwrite a new lecture draft when an old marker request finishes late', async () => {
    const oldMarker = {
      id: 'annotation-late',
      media_id: 'media-1',
      at_ms: 245_000,
      kind: 'question',
      text: 'Old lecture question',
      reviewed: false,
      created_at: '2026-08-23T00:00:00Z',
      updated_at: '2026-08-23T00:00:00Z',
    } as const;
    let finishCreate: (marker: typeof oldMarker) => void = () => undefined;
    mocks.createAnnotation.mockReturnValue(
      new Promise<typeof oldMarker>((resolve) => {
        finishCreate = resolve;
      }),
    );

    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    const draft = screen.getByRole('textbox', { name: 'What should future-you remember?' });
    fireEvent.change(draft, { target: { value: oldMarker.text } });
    fireEvent.click(screen.getByRole('button', { name: 'Save question' }));

    const playbackSink = mocks.open.mock.calls[0]?.[1] as (event: {
      event: 'state';
      data: typeof view;
    }) => void;
    act(() => {
      playbackSink({
        event: 'state',
        data: {
          ...view,
          plan_item_id: 'item-2',
          media_id: 'media-2',
          display_name: 'A different lecture',
        },
      });
    });
    const newDraft = await screen.findByRole('textbox', {
      name: 'What should future-you remember?',
    });
    fireEvent.change(newDraft, { target: { value: 'Keep this new lecture draft' } });

    act(() => finishCreate(oldMarker));
    await waitFor(() => expect(mocks.createAnnotation).toHaveBeenCalledTimes(1));
    expect(newDraft).toHaveValue('Keep this new lecture draft');
    expect(screen.queryByText(/Question saved privately/)).not.toBeInTheDocument();
  });

  it('replays a local concept window without leaving the scheduled block', async () => {
    renderRoute();
    const video = await screen.findByLabelText<HTMLVideoElement>('Playing Graph theory');
    Object.defineProperties(video, {
      currentTime: { configurable: true, writable: true, value: 120 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Last 30s' }));
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(90_000));
    expect(screen.getByText(/Looping 00:01:30–00:02:00/)).toBeInTheDocument();

    video.currentTime = 120;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBe(90);

    fireEvent.click(screen.getByRole('button', { name: 'Forward 10 seconds' }));
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(100_000));
    expect(screen.queryByText(/Looping 00:01:30–00:02:00/)).not.toBeInTheDocument();
    video.currentTime = 120;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBe(120);
  });

  it('keeps optional study tools collapsed until requested', async () => {
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    expect(screen.queryByRole('button', { name: 'Analyze this lecture' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    expect(screen.getByRole('button', { name: 'Analyze this lecture' })).toBeInTheDocument();
  });

  it('shows the completed transcript language and can retranscribe in another language', async () => {
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'completed',
      segment_count: 42,
      language: 'bn',
      model_id: 'whisper-small',
      updated_at: '2026-08-14T00:00:00Z',
      job: null,
    });
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));

    expect(await screen.findByText('বাংলা (Bangla) transcript ready')).toBeInTheDocument();
    expect(screen.getByText(/42 cited segments · whisper-small/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'বাংলা (Bangla)' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retranscribe in English' }));

    await waitFor(() =>
      expect(mocks.transcribe).toHaveBeenCalledWith(
        'media-1',
        'whisper-small',
        'en',
        expect.any(Function),
      ),
    );
  });

  it('turns a missing transcript into an actionable local transcription workflow', async () => {
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'not_started',
      segment_count: 0,
      updated_at: null,
      job: null,
    });
    mocks.transcribe.mockImplementation(
      (
        _mediaId: string,
        _modelId: string,
        _language: 'en' | 'bn',
        onEvent: (event: AnalysisProgress) => void,
      ) => {
        onEvent({ event: 'queued', data: { jobId: 'transcription-job' } });
        return Promise.resolve({
          id: 'transcription-job',
          kind: 'transcribe',
          status: 'queued',
          attempt: 0,
          last_error: null,
          created_at: '2026-08-14T00:00:00Z',
          updated_at: '2026-08-14T00:00:00Z',
        });
      },
    );
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));

    const consent = await screen.findByRole('checkbox');
    expect(consent).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Analyze this lecture' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe this lecture' }));
    await waitFor(() =>
      expect(mocks.transcribe).toHaveBeenCalledWith(
        'media-1',
        'whisper-small',
        'en',
        expect.any(Function),
      ),
    );
    expect(await screen.findByText('Transcription queued locally.')).toBeInTheDocument();
  });

  it('selects a compatible multilingual model for Bangla transcription', async () => {
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'not_started',
      segment_count: 0,
      updated_at: null,
      job: null,
    });
    mocks.models.mockResolvedValue([
      {
        id: 'whisper-base.en',
        display_name: 'Whisper Base English',
        version: '1',
        provider: 'local',
        expected_size_bytes: 1,
        architecture: 'whisper',
        analyzer_compatibility: '1',
        license: 'MIT',
        state: 'ready',
        bytes_downloaded: 1,
        verified_at: '2026-08-14T00:00:00Z',
        last_error: null,
        supported_languages: ['en'],
      },
      {
        id: 'whisper-base',
        display_name: 'Whisper Base Multilingual',
        version: '1',
        provider: 'local',
        expected_size_bytes: 1,
        architecture: 'whisper',
        analyzer_compatibility: '1',
        license: 'MIT',
        state: 'ready',
        bytes_downloaded: 1,
        verified_at: '2026-08-14T00:00:00Z',
        last_error: null,
        supported_languages: ['en', 'bn'],
      },
    ]);
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'বাংলা (Bangla)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe this lecture' }));

    await waitFor(() =>
      expect(mocks.transcribe).toHaveBeenCalledWith(
        'media-1',
        'whisper-base',
        'bn',
        expect.any(Function),
      ),
    );
  });

  it('shows engine setup before allowing transcription when the sidecar is unavailable', async () => {
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'not_started',
      segment_count: 0,
      updated_at: null,
      job: null,
    });
    mocks.analysisCapability.mockResolvedValue({
      available: false,
      engine: 'whisper.cpp',
      expected_version: '1.9.2',
      unavailable_reason: 'whisper_missing',
      message: 'The Whisper transcription component was not found.',
      supported_languages: ['en', 'bn'],
    });
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));

    expect(await screen.findByText('Local transcription engine unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open transcription settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(
      screen.queryByRole('button', { name: 'Transcribe this lecture' }),
    ).not.toBeInTheDocument();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it('clears stale starting status when transcription startup fails', async () => {
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'not_started',
      segment_count: 0,
      updated_at: null,
      job: null,
    });
    mocks.transcribe.mockRejectedValue(
      Object.assign(new Error('Local transcription is unavailable on this installation.'), {
        kind: 'sidecar_unavailable',
      }),
    );
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe this lecture' }));

    expect(
      await screen.findByText('Local transcription is unavailable on this installation.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Starting local transcription…')).not.toBeInTheDocument();
  });

  it('shows the safe busy message when another transcription already owns the lecture', async () => {
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'not_started',
      segment_count: 0,
      language: null,
      model_id: null,
      updated_at: null,
      job: null,
    });
    mocks.transcribe.mockRejectedValue(
      Object.assign(new Error('This lecture is already being transcribed in English.'), {
        kind: 'transcription_busy',
      }),
    );
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe this lecture' }));

    expect(
      await screen.findByText('This lecture is already being transcribed in English.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Starting local transcription…')).not.toBeInTheDocument();
  });

  it('unlocks grounded actions as soon as local transcription completes', async () => {
    mocks.transcriptState
      .mockResolvedValueOnce({
        media_id: 'media-1',
        status: 'not_started',
        segment_count: 0,
        updated_at: null,
        job: null,
      })
      .mockResolvedValue({
        media_id: 'media-1',
        status: 'completed',
        segment_count: 42,
        language: 'en',
        model_id: 'whisper-small',
        updated_at: '2026-08-14T00:00:00Z',
        job: null,
      });
    mocks.transcribe.mockImplementation(
      (
        _mediaId: string,
        _modelId: string,
        _language: 'en' | 'bn',
        onEvent: (event: AnalysisProgress) => void,
      ) => {
        onEvent({ event: 'completed', data: { jobId: 'transcription-job' } });
        return Promise.resolve({
          id: 'transcription-job',
          kind: 'transcribe',
          status: 'completed',
          attempt: 0,
          last_error: null,
          created_at: '2026-08-14T00:00:00Z',
          updated_at: '2026-08-14T00:00:00Z',
        });
      },
    );
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe this lecture' }));

    const consent = screen.getByRole('checkbox');
    await waitFor(() => expect(consent).not.toBeDisabled());
    expect(screen.getAllByText(/42 cited segments/)).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Analyze this lecture' })).toBeDisabled();
    fireEvent.click(consent);
    expect(screen.getByRole('button', { name: 'Analyze this lecture' })).toBeEnabled();
  });

  it('installs the bilingual model inline and enables Bangla transcription', async () => {
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'not_started',
      segment_count: 0,
      updated_at: null,
      job: null,
    });
    let modelReady = false;
    let emitInstallProgress: ((event: AnalysisProgress) => void) | undefined;
    mocks.models.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'whisper-base',
          display_name: 'Whisper Base Multilingual',
          version: '1',
          provider: 'local',
          expected_size_bytes: 100,
          architecture: 'whisper',
          analyzer_compatibility: '1.9.2',
          license: 'MIT',
          state: modelReady ? 'ready' : 'available',
          bytes_downloaded: modelReady ? 100 : 0,
          verified_at: modelReady ? '2026-08-14T00:00:00Z' : null,
          last_error: null,
          supported_languages: ['en', 'bn'],
        },
      ]),
    );
    mocks.installModel.mockImplementation(
      (_modelId: string, onEvent: (event: AnalysisProgress) => void) => {
        emitInstallProgress = onEvent;
        onEvent({ event: 'queued', data: { jobId: 'model-job' } });
        return Promise.resolve({
          id: 'model-job',
          kind: 'model_download',
          status: 'queued',
          attempt: 0,
          last_error: null,
          created_at: '2026-08-14T00:00:00Z',
          updated_at: '2026-08-14T00:00:00Z',
        });
      },
    );
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'বাংলা (Bangla)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install Bangla + English model' }));

    await waitFor(() =>
      expect(mocks.installModel).toHaveBeenCalledWith('whisper-base', expect.any(Function)),
    );
    act(() => {
      emitInstallProgress?.({
        event: 'downloading',
        data: { jobId: 'model-job', downloadedBytes: 50, totalBytes: 100 },
      });
    });
    expect(
      screen.getByRole('progressbar', { name: 'Transcription model download' }),
    ).toHaveAttribute('aria-valuenow', '50');

    modelReady = true;
    act(() => {
      emitInstallProgress?.({ event: 'completed', data: { jobId: 'model-job' } });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe this lecture' }));
    await waitFor(() =>
      expect(mocks.transcribe).toHaveBeenCalledWith(
        'media-1',
        'whisper-base',
        'bn',
        expect.any(Function),
      ),
    );
  });

  it('surfaces an inline model download failure and allows retry', async () => {
    mocks.transcriptState.mockResolvedValue({
      media_id: 'media-1',
      status: 'not_started',
      segment_count: 0,
      updated_at: null,
      job: null,
    });
    mocks.models.mockResolvedValue([
      {
        id: 'whisper-base',
        display_name: 'Whisper Base Multilingual',
        version: '1',
        provider: 'local',
        expected_size_bytes: 100,
        architecture: 'whisper',
        analyzer_compatibility: '1.9.2',
        license: 'MIT',
        state: 'available',
        bytes_downloaded: 0,
        verified_at: null,
        last_error: null,
        supported_languages: ['en', 'bn'],
      },
    ]);
    mocks.installModel.mockImplementation(
      (_modelId: string, onEvent: (event: AnalysisProgress) => void) => {
        onEvent({ event: 'queued', data: { jobId: 'model-job' } });
        onEvent({
          event: 'failed',
          data: { jobId: 'model-job', message: 'The verified model download was interrupted.' },
        });
        return Promise.resolve({
          id: 'model-job',
          kind: 'model_download',
          status: 'queued',
          attempt: 0,
          last_error: null,
          created_at: '2026-08-14T00:00:00Z',
          updated_at: '2026-08-14T00:00:00Z',
        });
      },
    );
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install Bangla + English model' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The verified model download was interrupted.',
    );
    expect(screen.getByRole('button', { name: 'Retry Bangla + English model' })).toBeEnabled();
  });

  it('blocks cloud learning actions until OpenRouter is configured', async () => {
    mocks.cloudStatus.mockResolvedValue({
      configured: false,
      provider: 'OpenRouter',
      model: 'openrouter/free',
    });
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    expect(await screen.findByRole('link', { name: 'Open AI settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Analyze this lecture' })).toBeDisabled();
  });

  it('generates lecture understanding and refreshes cited content', async () => {
    mocks.getLecture.mockResolvedValueOnce(null).mockResolvedValue(lectureUnderstanding);
    mocks.startLecture.mockImplementation(
      (_mediaId: string, _consent: boolean, onEvent: (event: LearningProgress) => void) => {
        onEvent({ event: 'completed', data: { jobId: 'learning-job' } });
        return Promise.resolve({
          id: 'learning-job',
          kind: 'lecture_understanding',
          status: 'completed',
          attempt: 0,
          last_error: null,
          created_at: '2026-08-14T00:00:00Z',
          updated_at: '2026-08-14T00:00:00Z',
        });
      },
    );
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    const consent = await screen.findByRole('checkbox');
    await waitFor(() => expect(consent).not.toBeDisabled());
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze this lecture' }));

    expect(await screen.findByText('A grounded summary of graph traversal.')).toBeInTheDocument();
    expect(mocks.startLecture).toHaveBeenCalledWith('media-1', true, expect.any(Function));
  });

  it('runs companion actions against the current grounded timestamp', async () => {
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    const consent = await screen.findByRole('checkbox');
    await waitFor(() => expect(consent).not.toBeDisabled());
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Explain this section' }));

    expect(
      await screen.findByText('This section compares two traversal frontiers.'),
    ).toBeInTheDocument();
    expect(mocks.companion).toHaveBeenCalledWith({
      mediaId: 'media-1',
      atMs: 120_000,
      action: 'explain_section',
      consent: true,
    });
  });

  it('captures the live frame and saves a grounded explanation note', async () => {
    mocks.listNotes.mockResolvedValueOnce([]).mockResolvedValue([frameNote]);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,cWEtZnJhbWU=',
    );
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperties(video, {
      currentTime: { configurable: true, writable: true, value: 321 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    const consent = await screen.findByRole('checkbox');
    await waitFor(() => expect(consent).not.toBeDisabled());
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Explain this frame and save note' }));

    await waitFor(() =>
      expect(mocks.explainFrame).toHaveBeenCalledWith({
        mediaId: 'media-1',
        atMs: 321_000,
        imageDataUrl: 'data:image/jpeg;base64,cWEtZnJhbWU=',
        consent: true,
      }),
    );
    expect(await screen.findByText(/Saved “Traversal diagram”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '00:02:00' }));
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(120_000));
  });

  it('renders detailed frame-note sections as readable grounded prose', async () => {
    mocks.listNotes.mockResolvedValue([
      {
        ...frameNote,
        body_markdown:
          '## Why it matters\n- The frontier separates visited nodes.\n1. Compare the next candidate.',
      },
    ]);
    renderRoute();

    expect(await screen.findByRole('heading', { name: 'Why it matters' })).toBeInTheDocument();
    expect(screen.getByText('The frontier separates visited nodes.')).toBeInTheDocument();
    expect(screen.getByText('Compare the next candidate.')).toBeInTheDocument();
    expect(screen.queryByText(/## Why it matters/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Evidence for Traversal diagram' }),
    ).toBeInTheDocument();
  });

  it('does not leave a stale study-set success beside a later frame-note error', async () => {
    mocks.listMaterials.mockResolvedValueOnce([]).mockResolvedValue([studyItem]);
    mocks.explainFrame.mockRejectedValueOnce(new Error('Frame explanation failed.'));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,cWEtZnJhbWU=',
    );
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 321 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    const consent = await screen.findByRole('checkbox');
    await waitFor(() => expect(consent).not.toBeDisabled());
    fireEvent.click(consent);

    fireEvent.click(screen.getByRole('button', { name: 'Generate study set' }));
    expect(
      await screen.findByText('Study material is ready. Review dates are scheduled locally.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Explain this frame and save note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Frame explanation failed.');
    expect(
      screen.queryByText('Study material is ready. Review dates are scheduled locally.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Capturing this frame and its transcript context…'),
    ).not.toBeInTheDocument();
  });

  it('generates review cards and records spaced-repetition feedback', async () => {
    mocks.listMaterials.mockResolvedValueOnce([]).mockResolvedValue([studyItem]);
    renderRoute();
    await screen.findByRole('heading', { name: 'Graph theory' });
    fireEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    const consent = await screen.findByRole('checkbox');
    await waitFor(() => expect(consent).not.toBeDisabled());
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Generate study set' }));

    expect(await screen.findByText('What is a traversal frontier?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Easy' }));
    await waitFor(() =>
      expect(mocks.recordReview).toHaveBeenCalledWith(
        expect.objectContaining({ studyItemId: 'study-1', quality: 5, confidence: 3 }),
      ),
    );
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

  it('reports stream failures precisely and retries with a fresh stream grant', async () => {
    const refreshedView = {
      ...view,
      stream_url: 'http://lector-media.localhost/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    mocks.open.mockResolvedValueOnce(view).mockResolvedValueOnce(refreshedView);
    renderRoute();
    const video = await screen.findByLabelText('Playing Graph theory');
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 2, message: 'network failure' },
    });

    fireEvent.error(video);
    expect(screen.getByText(/private local video stream could not be read/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry stream/i }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalled());
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText('Playing Graph theory')).toHaveAttribute(
      'src',
      refreshedView.stream_url,
    );
  });

  it('blocks legacy micro-sessions and repairs the remaining schedule', async () => {
    mocks.open.mockResolvedValue({
      ...view,
      raw_start_ms: 105_788,
      raw_end_ms: 106_591,
      position_ms: 105_788,
      item_duration_ms: 803,
    });
    renderRoute();

    expect(
      await screen.findByText('This legacy study block is too short to play'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Repair schedule' }));
    await waitFor(() => expect(mocks.replan).toHaveBeenCalled());
  });
});
