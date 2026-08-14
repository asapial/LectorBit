import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import BookOpen from 'lucide-react/dist/esm/icons/book-open';
import Camera from 'lucide-react/dist/esm/icons/camera';
import Brain from 'lucide-react/dist/esm/icons/brain';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import FastForward from 'lucide-react/dist/esm/icons/fast-forward';
import Flag from 'lucide-react/dist/esm/icons/flag';
import Pause from 'lucide-react/dist/esm/icons/pause';
import Play from 'lucide-react/dist/esm/icons/play';
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle';
import MessageCircle from 'lucide-react/dist/esm/icons/message-circle';
import RefreshCcw from 'lucide-react/dist/esm/icons/refresh-ccw';
import Rewind from 'lucide-react/dist/esm/icons/rewind';
import Scissors from 'lucide-react/dist/esm/icons/scissors';
import Square from 'lucide-react/dist/esm/icons/square';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { PageHeader } from '../../components/layout/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/Card';
import {
  closePlayback,
  getPlaybackCapability,
  getPlaybackState,
  openPlayback,
  pausePlayback,
  playPlayback,
  recordStudyAction,
  seekPlayback,
  setPlaybackSpeed,
  syncPlayback,
  type PlaybackCapability,
  type PlaybackEvent,
  type PlaybackView,
  type StudyAction,
} from '../../ipc/playback';
import { replanActive } from '../../ipc/planner';
import {
  askCompanion,
  explainFrame,
  generateStudyMaterials,
  getLectureUnderstanding,
  listExplanationNotes,
  listStudyMaterials,
  recordReview,
  startLectureUnderstanding,
  type CompanionAction,
  type LearningProgress,
  type StudyItem,
} from '../../ipc/learning';

type Phase = 'loading' | 'ready' | 'closed' | 'error';

const actionMessages: Record<StudyAction, string> = {
  complete: 'Marked complete.',
  skip: 'Skipped. Replan to remove it from future work.',
  postpone: 'Postponed. Replan when you are ready to move it.',
  split: 'Split point saved for the next plan.',
  repeat: 'Queued to repeat in the next plan.',
  must_watch: 'Marked must watch for the next plan.',
};

const companionActions: Array<{ action: CompanionAction; label: string }> = [
  { action: 'explain_section', label: 'Explain this section' },
  { action: 'summarize_five_minutes', label: 'Summarize last five minutes' },
  { action: 'give_example', label: 'Give me an example' },
  { action: 'quiz_chapter', label: 'Quiz me on this chapter' },
  { action: 'define_terms', label: 'Define the terms used here' },
];

export function PlayerRoute() {
  const { itemId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('loading');
  const [capability, setCapability] = useState<PlaybackCapability>();
  const [view, setView] = useState<PlaybackView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionPending, setActionPending] = useState<StudyAction>();
  const [actionMessage, setActionMessage] = useState<string>();
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [seekDraft, setSeekDraft] = useState<number>();
  const [replanPending, setReplanPending] = useState(false);
  const [learningConsent, setLearningConsent] = useState(false);
  const [learningStatus, setLearningStatus] = useState<string>();
  const [revealedStudyItem, setRevealedStudyItem] = useState<string>();
  const [reviewStartedAt, setReviewStartedAt] = useState<number>();
  const [reviewConfidence, setReviewConfidence] = useState(3);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastVideoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<PlaybackView | undefined>(undefined);
  const syncPendingRef = useRef<Promise<PlaybackView> | null>(null);
  const closeRequestedRef = useRef(false);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    if (video) lastVideoRef.current = video;
  }, []);

  const lectureQuery = useQuery({
    queryKey: ['learning', 'lecture', view?.media_id] as const,
    queryFn: () => getLectureUnderstanding(view!.media_id),
    enabled: Boolean(view?.media_id),
  });
  const notesQuery = useQuery({
    queryKey: ['learning', 'notes', view?.media_id] as const,
    queryFn: () => listExplanationNotes(view!.media_id),
    enabled: Boolean(view?.media_id),
  });
  const studyQuery = useQuery({
    queryKey: ['learning', 'study-materials', view?.media_id] as const,
    queryFn: () => listStudyMaterials(view!.media_id),
    enabled: Boolean(view?.media_id),
  });
  const generateLecture = useMutation({
    mutationFn: async () => {
      if (!view) throw new Error('Open a lecture first.');
      return startLectureUnderstanding(view.media_id, learningConsent, handleLearningProgress);
    },
    onError: (cause) => setLearningStatus(messageFrom(cause)),
  });
  const createFrameNote = useMutation({
    mutationFn: async () => {
      const video = videoRef.current;
      if (!view || !video) throw new Error('Wait for the video frame to become available.');
      const atMs = Math.max(
        view.raw_start_ms,
        Math.min(view.raw_end_ms, Math.round(video.currentTime * 1_000)),
      );
      return explainFrame({
        mediaId: view.media_id,
        atMs,
        imageDataUrl: captureVideoFrame(video),
        consent: learningConsent,
      });
    },
    onSuccess: async (note) => {
      setLearningStatus(`Saved “${note.title}” at ${formatTimestamp(note.at_ms)}.`);
      await notesQuery.refetch();
    },
    onError: (cause) => setLearningStatus(messageFrom(cause)),
  });
  const generateMaterials = useMutation({
    mutationFn: async () => {
      if (!view) throw new Error('Open a lecture first.');
      setLearningStatus('Generating grounded study material…');
      return generateStudyMaterials(view.media_id, learningConsent);
    },
    onSuccess: async () => {
      setLearningStatus('Study material is ready. Review dates are scheduled locally.');
      await studyQuery.refetch();
    },
    onError: (cause) => setLearningStatus(messageFrom(cause)),
  });
  const submitReview = useMutation({
    mutationFn: async ({ item, quality }: { item: StudyItem; quality: number }) =>
      recordReview({
        studyItemId: item.id,
        quality,
        confidence: reviewConfidence,
        responseTimeMs: Math.max(0, Date.now() - (reviewStartedAt ?? Date.now())),
      }),
    onSuccess: async () => {
      setRevealedStudyItem(undefined);
      setReviewStartedAt(undefined);
      await studyQuery.refetch();
    },
    onError: (cause) => setLearningStatus(messageFrom(cause)),
  });
  const companion = useMutation({
    mutationFn: async (action: CompanionAction) => {
      if (!view) throw new Error('Open a lecture first.');
      return askCompanion({
        mediaId: view.media_id,
        atMs: view.position_ms,
        action,
        consent: learningConsent,
      });
    },
    onError: (cause) => setLearningStatus(messageFrom(cause)),
  });

  function revealStudyAnswer(itemId: string) {
    setRevealedStudyItem(itemId);
    setReviewStartedAt(Date.now());
  }

  function handleLearningProgress(event: LearningProgress) {
    if (event.event === 'queued') setLearningStatus('Lecture analysis queued.');
    if (event.event === 'generating') setLearningStatus('Reading the grounded transcript…');
    if (event.event === 'validating') setLearningStatus('Checking transcript citations…');
    if (event.event === 'failed') setLearningStatus(event.data.message);
    if (event.event === 'completed') {
      setLearningStatus('Lecture understanding is ready.');
      void lectureQuery.refetch();
    }
  }

  useEffect(() => {
    let disposed = false;
    let opened = false;

    const handleEvent = (event: PlaybackEvent) => {
      if (disposed) return;
      if (event.event === 'state') {
        setView(event.data);
        setPhase('ready');
      } else if (event.event === 'closed') {
        setPhase('closed');
      } else {
        setError(event.data.message);
        setPhase('error');
      }
    };

    async function boot() {
      closeRequestedRef.current = false;
      if (!itemId) {
        setError('This study block is missing an identifier.');
        setPhase('error');
        return;
      }
      try {
        const nextCapability = await getPlaybackCapability();
        if (disposed) return;
        setCapability(nextCapability);
        if (!nextCapability.available) {
          setError('The built-in media player is unavailable. Check Diagnostics.');
          setPhase('error');
          return;
        }
        let nextView = await openPlayback(itemId, handleEvent);
        opened = true;
        const requestedTimestampValue = searchParams.get('t');
        const requestedTimestamp =
          requestedTimestampValue === null ? Number.NaN : Number(requestedTimestampValue);
        if (
          Number.isFinite(requestedTimestamp) &&
          requestedTimestamp >= nextView.raw_start_ms &&
          requestedTimestamp <= nextView.raw_end_ms
        ) {
          nextView = await seekPlayback(requestedTimestamp);
        }
        if (disposed) {
          await closePlayback().catch(() => undefined);
          return;
        }
        setView(nextView);
        setPhase('ready');
      } catch (cause) {
        if (!disposed) {
          setError(messageFrom(cause));
          setPhase('error');
        }
      }
    }

    void boot();
    return () => {
      disposed = true;
      if (opened && !closeRequestedRef.current) flushAndClosePlayback();
    };
  }, [itemId, searchParams]);

  useEffect(() => {
    if (phase !== 'ready' || !view) return;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || syncPendingRef.current || !Number.isFinite(video.currentTime)) return;
      const position = Math.max(
        view.raw_start_ms,
        Math.min(view.raw_end_ms, Math.round(video.currentTime * 1_000)),
      );
      if (position >= view.raw_end_ms && !video.paused) video.pause();
      const pending = syncPlayback(position, video.paused, video.playbackRate);
      syncPendingRef.current = pending;
      void pending
        .then((next) =>
          setView((current) =>
            current?.completed && !next.completed ? { ...next, completed: true } : next,
          ),
        )
        .catch((cause) => setError(messageFrom(cause)))
        .finally(() => {
          if (syncPendingRef.current === pending) syncPendingRef.current = null;
        });
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [phase, view?.raw_end_ms, view?.raw_start_ms, view?.stream_url]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const syncAtVisibilityBoundary = () => {
      const video = videoRef.current;
      if (!video) return;
      void syncCurrentVideo(video)
        .then(setView)
        .catch((cause) => setError(messageFrom(cause)));
    };
    document.addEventListener('visibilitychange', syncAtVisibilityBoundary);
    window.addEventListener('pagehide', syncAtVisibilityBoundary);
    return () => {
      document.removeEventListener('visibilitychange', syncAtVisibilityBoundary);
      window.removeEventListener('pagehide', syncAtVisibilityBoundary);
    };
  }, [phase]);

  const watchedPercent = useMemo(() => {
    if (!view || view.item_duration_ms === 0) return 0;
    return Math.min(100, Math.floor((view.item_covered_ms / view.item_duration_ms) * 100));
  }, [view]);
  const actionsDisabled = busy || replanPending || phase !== 'ready' || Boolean(actionPending);

  async function runControl(operation: () => Promise<PlaybackView>) {
    setBusy(true);
    setError(undefined);
    try {
      if (syncPendingRef.current) await syncPendingRef.current.catch(() => undefined);
      const nextView = await operation();
      setView(nextView);
      setSeekDraft(undefined);
      return nextView;
    } catch (cause) {
      setError(messageFrom(cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function commitSeek(position = seekDraft) {
    if (position === undefined || !view) return;
    const clamped = Math.max(view.raw_start_ms, Math.min(view.raw_end_ms, position));
    if (videoRef.current) videoRef.current.currentTime = clamped / 1_000;
    await runControl(() => seekPlayback(clamped));
  }

  async function togglePlayback() {
    const video = videoRef.current ?? lastVideoRef.current;
    if (!video || !view) return;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        setError(mediaErrorMessage(video.error));
        return;
      }
      const nextView = await runControl(playPlayback);
      if (!nextView) video.pause();
    } else {
      video.pause();
      await runControl(async () => {
        await syncCurrentVideo(video);
        return pausePlayback();
      });
    }
  }

  function retryMedia() {
    setError(undefined);
    videoRef.current?.load();
  }

  async function changeSpeed(speed: number) {
    const video = videoRef.current;
    const previousSpeed = view?.speed ?? 1;
    const nextView = await runControl(async () => {
      if (video && view && Number.isFinite(video.currentTime)) {
        const position = Math.max(
          view.raw_start_ms,
          Math.min(view.raw_end_ms, Math.round(video.currentTime * 1_000)),
        );
        // Preserve the interval watched at the old rate. Sync updates the
        // embedded engine's live position; seeking to that same position then
        // forces the durable checkpoint before the backend changes speed.
        await syncCurrentVideo(video);
        await seekPlayback(position);
      }
      const changed = await setPlaybackSpeed(speed);
      if (video) video.playbackRate = speed;
      return changed;
    });
    if (!nextView && video) video.playbackRate = previousSpeed;
  }

  async function performAction(kind: StudyAction) {
    if (!view || actionsDisabled) return;
    setActionPending(kind);
    setActionMessage(undefined);
    setError(undefined);
    try {
      const video = videoRef.current;
      const currentPosition =
        video && Number.isFinite(video.currentTime)
          ? Math.round(video.currentTime * 1_000)
          : view.position_ms;
      const actionPosition = Math.max(
        view.raw_start_ms,
        Math.min(view.raw_end_ms, currentPosition),
      );
      if (
        kind === 'split' &&
        (actionPosition <= view.raw_start_ms || actionPosition >= view.raw_end_ms)
      ) {
        setError('Play or seek inside the study block before choosing a split point.');
        return;
      }
      if (kind === 'complete' || kind === 'skip' || kind === 'postpone') {
        video?.pause();
      }
      if (video) {
        const nextView = await syncCurrentVideo(video);
        setView(nextView);
      } else if (syncPendingRef.current) {
        await syncPendingRef.current.catch(() => undefined);
      }
      await recordStudyAction(
        view.plan_item_id,
        kind,
        kind === 'split' ? actionPosition : undefined,
      );
      await queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
      const refreshedView = await getPlaybackState();
      setActionMessage(actionMessages[kind]);
      setConfirmSkip(false);
      setView(refreshedView);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setActionPending(undefined);
    }
  }

  async function stopAndReturn() {
    setBusy(true);
    closeRequestedRef.current = true;
    try {
      if (videoRef.current && phase === 'ready') {
        setView(await syncCurrentVideo(videoRef.current));
      }
      await queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
      await closePlayback();
      void navigate('/');
    } catch (cause) {
      closeRequestedRef.current = false;
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  async function replanRemaining() {
    setReplanPending(true);
    setError(undefined);
    closeRequestedRef.current = true;
    try {
      if (videoRef.current && phase === 'ready') {
        setView(await syncCurrentVideo(videoRef.current));
      }
      await closePlayback();
      await replanActive(localIsoDate());
      await queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
      void navigate('/');
    } catch (cause) {
      closeRequestedRef.current = false;
      setError(messageFrom(cause));
      setReplanPending(false);
    }
  }

  async function syncCurrentVideo(video: HTMLVideoElement): Promise<PlaybackView> {
    if (syncPendingRef.current) await syncPendingRef.current.catch(() => undefined);
    // An action can be clicked in the first ready frame, before the effect that
    // mirrors `view` into the lifecycle ref has run. The render-local value is
    // already authoritative in that frame, so use it as the synchronization
    // fallback instead of skipping the checkpoint and only fetching state.
    const currentView = viewRef.current ?? view;
    if (!currentView || !Number.isFinite(video.currentTime)) return getPlaybackState();
    const position = Math.max(
      currentView.raw_start_ms,
      Math.min(currentView.raw_end_ms, Math.round(video.currentTime * 1_000)),
    );
    const pending = syncPlayback(position, video.paused, video.playbackRate);
    syncPendingRef.current = pending;
    try {
      return await pending;
    } finally {
      if (syncPendingRef.current === pending) syncPendingRef.current = null;
    }
  }

  function flushAndClosePlayback() {
    const video = videoRef.current ?? lastVideoRef.current;
    const currentView = viewRef.current;
    if (!video || !currentView || !Number.isFinite(video.currentTime)) {
      void closePlayback().catch(() => undefined);
      return;
    }
    const position = Math.max(
      currentView.raw_start_ms,
      Math.min(currentView.raw_end_ms, Math.round(video.currentTime * 1_000)),
    );
    const paused = video.paused;
    const speed = video.playbackRate;
    void (async () => {
      if (syncPendingRef.current) await syncPendingRef.current.catch(() => undefined);
      await syncPlayback(position, paused, speed).catch(() => undefined);
      await closePlayback().catch(() => undefined);
    })();
  }

  return (
    <>
      <PageHeader
        eyebrow="Focused study"
        title={view?.display_name ?? 'Study player'}
        description="Watch inside LectorBit with private, token-gated local streaming and durable watched coverage."
        actions={
          <button
            type="button"
            className={backLinkClass}
            disabled={busy || phase === 'closed'}
            onClick={() => void stopAndReturn()}
          >
            <ArrowLeft className="size-4" /> Routine
          </button>
        }
      />

      {phase === 'loading' ? <PlayerSkeleton /> : null}

      {phase === 'error' && !view ? (
        <Card className="border-destructive/30">
          <CardContent className="flex items-start gap-3 pt-6" role="alert">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Playback could not start</p>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
              {capability ? (
                <p className="mt-3 font-mono text-xs text-muted-foreground">
                  {capability.backend} ·{' '}
                  {capability.detected_version ?? capability.expected_version}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {view ? (
        <div className="space-y-6">
          {error ? (
            <div
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              <div className="flex min-w-0 items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
              <Button variant="outline" size="sm" onClick={retryMedia}>
                <RefreshCcw className="size-3.5" /> Retry stream
              </Button>
            </div>
          ) : null}

          <section
            className="grid gap-4 min-[1320px]:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]"
            aria-label="Playback controls"
          >
            <Card className="overflow-hidden">
              <div className="h-1 bg-primary" />
              <div className="aspect-video bg-stone-950">
                <video
                  ref={attachVideo}
                  src={view.stream_url}
                  className="size-full object-contain"
                  controls
                  crossOrigin="anonymous"
                  playsInline
                  preload="metadata"
                  aria-label={`Playing ${view.display_name}`}
                  onLoadedMetadata={(event) => {
                    event.currentTarget.currentTime = clampPosition(view) / 1_000;
                    event.currentTarget.playbackRate = view.speed;
                  }}
                  onSeeking={(event) => enforceBlockBounds(event.currentTarget, view)}
                  onCanPlay={() => setError(undefined)}
                  onPlay={() =>
                    setView((current) => (current ? { ...current, paused: false } : current))
                  }
                  onPause={() =>
                    setView((current) => (current ? { ...current, paused: true } : current))
                  }
                  onRateChange={(event) => {
                    const speed = event.currentTarget.playbackRate;
                    setView((current) => (current ? { ...current, speed } : current));
                  }}
                  onTimeUpdate={(event) => {
                    const position = enforceBlockBounds(event.currentTarget, view);
                    setView((current) =>
                      current ? { ...current, position_ms: position } : current,
                    );
                    if (position >= view.raw_end_ms) {
                      event.currentTarget.pause();
                      event.currentTarget.currentTime = view.raw_end_ms / 1_000;
                    }
                  }}
                  onError={(event) => setError(mediaErrorMessage(event.currentTarget.error))}
                >
                  {view.caption_tracks.map((track) => (
                    <track
                      key={track.url}
                      kind="captions"
                      src={track.url}
                      srcLang={track.language}
                      label={track.label}
                    />
                  ))}
                </video>
              </div>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>In-app video player</CardTitle>
                    <CardDescription className="mt-1">
                      Native volume, fullscreen, captions, and picture-in-picture controls stay in
                      this window.
                    </CardDescription>
                  </div>
                  <PlaybackBadge view={view} phase={phase} />
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
                    <span>{formatTimestamp(seekDraft ?? view.position_ms)}</span>
                    <span>{formatTimestamp(view.raw_end_ms)}</span>
                  </div>
                  <input
                    aria-label="Playback position"
                    className="w-full accent-primary"
                    type="range"
                    min={view.raw_start_ms}
                    max={view.raw_end_ms}
                    step={1_000}
                    value={seekDraft ?? clampPosition(view)}
                    onChange={(event) => setSeekDraft(Number(event.target.value))}
                    disabled={busy || phase === 'closed'}
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>Block starts at {formatTimestamp(view.raw_start_ms)}</span>
                    {seekDraft !== undefined ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void commitSeek()}
                        disabled={busy}
                      >
                        Seek here
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-[auto_minmax(7rem,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
                  <Button
                    aria-label="Rewind 10 seconds"
                    variant="outline"
                    size="icon"
                    disabled={busy || phase === 'closed'}
                    onClick={() => void commitSeek(view.position_ms - 10_000)}
                  >
                    <Rewind className="size-4" />
                  </Button>
                  <Button
                    className="min-w-0 sm:min-w-28"
                    disabled={busy || phase === 'closed'}
                    onClick={() => void togglePlayback()}
                  >
                    {view.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                    {view.paused ? 'Play' : 'Pause'}
                  </Button>
                  <Button
                    aria-label="Forward 10 seconds"
                    variant="outline"
                    size="icon"
                    disabled={busy || phase === 'closed'}
                    onClick={() => void commitSeek(view.position_ms + 10_000)}
                  >
                    <FastForward className="size-4" />
                  </Button>
                  <label className="col-span-2 flex items-center gap-2 text-sm font-medium sm:ml-auto">
                    Speed
                    <select
                      aria-label="Playback speed"
                      className="h-10 flex-1 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none"
                      value={view.speed}
                      disabled={busy || phase === 'closed'}
                      onChange={(event) => void changeSpeed(Number(event.target.value))}
                    >
                      {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
                        <option key={speed} value={speed}>
                          {speed}×
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    className="col-span-1"
                    variant="ghost"
                    disabled={busy || phase === 'closed'}
                    onClick={() => void stopAndReturn()}
                  >
                    <Square className="size-3.5" /> Close
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Watched coverage</CardTitle>
                <CardDescription>Completion is based on viewing, not the playhead.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-end justify-between gap-3">
                  <span className="font-display text-3xl font-semibold tracking-tight">
                    {watchedPercent}%
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatDuration(view.item_covered_ms)} / {formatDuration(view.item_duration_ms)}
                  </span>
                </div>
                <div
                  aria-label="Watched coverage"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={watchedPercent}
                  className="h-2 overflow-hidden rounded-full bg-secondary"
                  role="progressbar"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                    style={{ width: `${watchedPercent}%` }}
                  />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  LectorBit completes the block automatically at 90% watched coverage, or when you
                  explicitly mark it complete.
                </p>
              </CardContent>
            </Card>
          </section>

          <Card className="overflow-hidden border-primary/20">
            <div className="h-1 bg-gradient-to-r from-primary via-vermillion-400 to-amber-400" />
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" /> Lecture intelligence
                  </CardTitle>
                  <CardDescription className="mt-1 max-w-3xl">
                    Generate transcript-cited chapters and concepts, or capture the current frame
                    and save a detailed explanation note.
                  </CardDescription>
                </div>
                {lectureQuery.data ? (
                  <Badge tone="success">Grounded · {lectureQuery.data.model}</Badge>
                ) : (
                  <Badge tone="primary">Optional AI</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border bg-secondary/35 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={learningConsent}
                  onChange={(event) => setLearningConsent(event.target.checked)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  Send the transcript needed for this request and, for frame notes, the captured
                  frame to my configured OpenRouter free-model provider. Nothing is committed to a
                  plan automatically.
                </span>
              </label>

              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!learningConsent || generateLecture.isPending}
                  onClick={() => generateLecture.mutate()}
                >
                  {generateLecture.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <BookOpen className="size-4" />
                  )}
                  {lectureQuery.data ? 'Regenerate lecture analysis' : 'Analyze this lecture'}
                </Button>
                <Button
                  variant="outline"
                  disabled={!learningConsent || createFrameNote.isPending || phase !== 'ready'}
                  onClick={() => createFrameNote.mutate()}
                >
                  {createFrameNote.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Camera className="size-4" />
                  )}
                  Explain this frame and save note
                </Button>
                <Button
                  variant="outline"
                  disabled={!learningConsent || generateMaterials.isPending}
                  onClick={() => generateMaterials.mutate()}
                >
                  {generateMaterials.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Brain className="size-4" />
                  )}
                  {studyQuery.data?.length ? 'Regenerate study set' : 'Generate study set'}
                </Button>
              </div>

              <section className="rounded-xl border bg-background p-4" aria-labelledby="companion-heading">
                <div className="flex items-start gap-3">
                  <MessageCircle className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div>
                    <h3 id="companion-heading" className="text-sm font-semibold">
                      Grounded study companion
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Only a narrow transcript window around {formatTimestamp(view.position_ms)} is
                      sent for each action.
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {companionActions.map((item) => (
                    <Button
                      key={item.action}
                      size="sm"
                      variant="secondary"
                      disabled={!learningConsent || companion.isPending}
                      onClick={() => companion.mutate(item.action)}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
                {companion.isPending ? (
                  <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status">
                    <LoaderCircle className="size-4 animate-spin" /> Reading the nearby transcript…
                  </p>
                ) : null}
                {companion.data ? (
                  <div className="mt-4 rounded-lg bg-secondary/45 p-4">
                    <p className="whitespace-pre-wrap text-sm leading-7">
                      {companion.data.answer_markdown}
                    </p>
                    <EvidenceButtons
                      label="Companion evidence"
                      evidence={companion.data.evidence}
                      onSeek={(atMs) => void commitSeek(atMs)}
                    />
                  </div>
                ) : null}
              </section>

              {learningStatus ? (
                <p className="rounded-lg border bg-background p-3 text-sm" role="status">
                  {learningStatus}
                </p>
              ) : null}
              {lectureQuery.isError ? (
                <p className="text-sm text-destructive" role="alert">
                  {messageFrom(lectureQuery.error)}
                </p>
              ) : null}

              {lectureQuery.data ? (
                <div className="grid gap-5 lg:grid-cols-2">
                  <section className="space-y-3" aria-labelledby="lecture-summary-heading">
                    <h3 id="lecture-summary-heading" className="font-display font-semibold">
                      Summary
                    </h3>
                    <p className="text-sm leading-7 text-muted-foreground">
                      {lectureQuery.data.summary.text}
                    </p>
                    <EvidenceButtons
                      label="Summary evidence"
                      evidence={lectureQuery.data.summary.evidence}
                      onSeek={(atMs) => void commitSeek(atMs)}
                    />
                    {lectureQuery.data.learning_objectives.length > 0 ? (
                      <div>
                        <h4 className="text-sm font-semibold">Learning objectives</h4>
                        <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
                          {lectureQuery.data.learning_objectives.map((objective, index) => (
                            <li key={`${objective.text}-${index}`} className="flex gap-2">
                              <span aria-hidden="true">•</span>
                              <button
                                type="button"
                                className="text-left leading-6 hover:text-foreground hover:underline"
                                onClick={() => void commitSeek(objective.evidence[0].start_ms)}
                              >
                                {objective.text}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </section>

                  <section className="space-y-3" aria-labelledby="lecture-chapters-heading">
                    <div className="flex items-center justify-between gap-3">
                      <h3 id="lecture-chapters-heading" className="font-display font-semibold">
                        Timestamped chapters
                      </h3>
                      <Badge tone="neutral">
                        {lectureQuery.data.difficulty.level} difficulty ·{' '}
                        {lectureQuery.data.difficulty.confidence} confidence
                      </Badge>
                    </div>
                    <div className="max-h-72 space-y-2 overflow-auto pr-1">
                      {lectureQuery.data.chapters.map((chapter) => (
                        <button
                          key={`${chapter.start_ms}-${chapter.title}`}
                          type="button"
                          className="block w-full rounded-lg border bg-background p-3 text-left transition-colors hover:border-primary/35 hover:bg-accent/30"
                          onClick={() => void commitSeek(chapter.start_ms)}
                        >
                          <span className="font-mono text-xs text-primary">
                            {formatTimestamp(chapter.start_ms)}
                          </span>
                          <span className="ml-2 text-sm font-semibold">{chapter.title}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {chapter.summary}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>

                  {lectureQuery.data.concepts.length > 0 ? (
                    <section className="space-y-3 lg:col-span-2" aria-labelledby="concepts-heading">
                      <h3 id="concepts-heading" className="font-display font-semibold">
                        Concepts and definitions
                      </h3>
                      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {lectureQuery.data.concepts.map((concept) => (
                          <button
                            key={concept.name}
                            type="button"
                            className="rounded-lg border bg-background p-3 text-left hover:border-primary/35"
                            onClick={() => void commitSeek(concept.evidence[0].start_ms)}
                          >
                            <span className="text-sm font-semibold">{concept.name}</span>
                            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                              {concept.definition}
                            </span>
                            <span className="mt-2 block font-mono text-[11px] text-primary">
                              Open at {formatTimestamp(concept.evidence[0].start_ms)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : null}

              {notesQuery.data && notesQuery.data.length > 0 ? (
                <section className="space-y-3 border-t pt-5" aria-labelledby="frame-notes-heading">
                  <h3 id="frame-notes-heading" className="font-display font-semibold">
                    Saved frame explanations
                  </h3>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {notesQuery.data.map((note) => (
                      <article key={note.id} className="rounded-xl border bg-background p-4">
                        <button
                          type="button"
                          className="font-semibold hover:text-primary hover:underline"
                          onClick={() => void commitSeek(note.at_ms)}
                        >
                          {formatTimestamp(note.at_ms)} · {note.title}
                        </button>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                          {note.body_markdown}
                        </p>
                        <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                          {note.frame_grounded ? 'Frame + transcript grounded' : 'Transcript grounded'}
                          {' · '}
                          {note.model}
                        </p>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {studyQuery.data && studyQuery.data.length > 0 ? (
                <section className="space-y-3 border-t pt-5" aria-labelledby="study-materials-heading">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 id="study-materials-heading" className="font-display font-semibold">
                        Study materials
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        AI creates the questions; deterministic SM-2 schedules every review.
                      </p>
                    </div>
                    <Badge tone="neutral">{studyQuery.data.length} items</Badge>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {studyQuery.data.map((item) => {
                      const revealed = revealedStudyItem === item.id;
                      return (
                        <article key={item.id} className="rounded-xl border bg-background p-4">
                          <div className="flex items-center justify-between gap-3">
                            <Badge tone="primary">{studyKindLabel(item.kind)}</Badge>
                            <button
                              type="button"
                              className="font-mono text-[11px] text-primary hover:underline"
                              onClick={() => void commitSeek(item.evidence[0].start_ms)}
                            >
                              Evidence {formatTimestamp(item.evidence[0].start_ms)}
                            </button>
                          </div>
                          <p className="mt-3 text-sm font-medium leading-6">{item.prompt}</p>
                          {item.options.length > 0 ? (
                            <ol className="mt-2 list-inside list-[upper-alpha] space-y-1 text-sm text-muted-foreground">
                              {item.options.map((option) => (
                                <li key={option}>{option}</li>
                              ))}
                            </ol>
                          ) : null}
                          {item.hint ? (
                            <p className="mt-2 text-xs text-muted-foreground">Hint: {item.hint}</p>
                          ) : null}
                          {!revealed ? (
                            <Button
                              className="mt-3"
                              size="sm"
                              variant="outline"
                              onClick={() => revealStudyAnswer(item.id)}
                            >
                              Reveal answer
                            </Button>
                          ) : (
                            <div className="mt-3 rounded-lg bg-secondary/55 p-3">
                              <p className="text-sm leading-6">{item.answer}</p>
                              <div className="mt-3 flex flex-wrap items-end gap-2">
                                <label className="text-xs font-medium">
                                  Confidence
                                  <select
                                    className="ml-2 h-8 rounded-md border bg-background px-2"
                                    value={reviewConfidence}
                                    onChange={(event) => setReviewConfidence(Number(event.target.value))}
                                  >
                                    {[1, 2, 3, 4, 5].map((value) => (
                                      <option key={value} value={value}>
                                        {value}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={submitReview.isPending}
                                  onClick={() => submitReview.mutate({ item, quality: 1 })}
                                >
                                  Again
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={submitReview.isPending}
                                  onClick={() => submitReview.mutate({ item, quality: 3 })}
                                >
                                  Hard
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={submitReview.isPending}
                                  onClick={() => submitReview.mutate({ item, quality: 5 })}
                                >
                                  Easy
                                </Button>
                              </div>
                            </div>
                          )}
                          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                            Due {formatReviewDate(item.due_at)} · interval {item.interval_days}d ·{' '}
                            {item.repetitions} successful reviews
                          </p>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Study actions</CardTitle>
              <CardDescription>
                Actions are append-only and will shape the next replan without rewriting completed
                history.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <Button
                  disabled={actionsDisabled || view.completed}
                  onClick={() => void performAction('complete')}
                >
                  <CheckCircle2 className="size-4" /> Mark complete
                </Button>
                <Button
                  variant="outline"
                  disabled={actionsDisabled}
                  onClick={() => void performAction('postpone')}
                >
                  <Clock3 className="size-4" /> Postpone
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    actionsDisabled ||
                    view.position_ms <= view.raw_start_ms ||
                    view.position_ms >= view.raw_end_ms
                  }
                  onClick={() => void performAction('split')}
                >
                  <Scissors className="size-4" /> Split here
                </Button>
                <Button
                  variant="outline"
                  disabled={actionsDisabled}
                  onClick={() => void performAction('repeat')}
                >
                  <RefreshCcw className="size-4" /> Repeat
                </Button>
                <Button
                  variant="outline"
                  disabled={actionsDisabled}
                  onClick={() => void performAction('must_watch')}
                >
                  <Flag className="size-4" /> Must watch
                </Button>
                {confirmSkip ? (
                  <>
                    <Button
                      variant="destructive"
                      disabled={actionsDisabled}
                      onClick={() => void performAction('skip')}
                    >
                      Confirm skip
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmSkip(false)}
                      disabled={actionsDisabled}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={actionsDisabled}
                    onClick={() => setConfirmSkip(true)}
                  >
                    Skip
                  </Button>
                )}
                <Button
                  className="col-span-2 sm:ml-auto"
                  variant="secondary"
                  disabled={busy || Boolean(actionPending) || replanPending}
                  onClick={() => void replanRemaining()}
                >
                  <RefreshCcw className="size-4" />
                  {replanPending ? 'Replanning…' : 'Replan remaining'}
                </Button>
              </div>
              {actionMessage ? (
                <p className="mt-4 flex items-center gap-2 text-sm text-success" role="status">
                  <CheckCircle2 className="size-4" /> {actionMessage}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}

function EvidenceButtons({
  label,
  evidence,
  onSeek,
}: {
  label: string;
  evidence: Array<{ segment_id: number; start_ms: number; end_ms: number }>;
  onSeek: (atMs: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label={label}>
      {evidence.map((item) => (
        <button
          key={item.segment_id}
          type="button"
          className="rounded-md bg-secondary px-2 py-1 font-mono text-[11px] text-secondary-foreground hover:bg-accent"
          onClick={() => onSeek(item.start_ms)}
        >
          {formatTimestamp(item.start_ms)}
        </button>
      ))}
    </div>
  );
}

function captureVideoFrame(video: HTMLVideoElement): string {
  if (!video.videoWidth || !video.videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new Error('Wait until the current video frame is visible.');
  }
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This WebView cannot capture the current frame.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
  if (!dataUrl.startsWith('data:image/jpeg;base64,')) {
    throw new Error('The current frame could not be encoded safely.');
  }
  return dataUrl;
}

function studyKindLabel(kind: StudyItem['kind']): string {
  return {
    flashcard: 'Flashcard',
    multiple_choice: 'Multiple choice',
    short_answer: 'Short answer',
    explain_own_words: 'Explain it',
  }[kind];
}

function formatReviewDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'now';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function PlaybackBadge({ view, phase }: { view: PlaybackView; phase: Phase }) {
  if (phase === 'closed')
    return (
      <Badge>
        <Square className="size-3" /> Closed
      </Badge>
    );
  if (view.completed)
    return (
      <Badge tone="success">
        <CheckCircle2 className="size-3" /> Completed
      </Badge>
    );
  return view.paused ? (
    <Badge>
      <Pause className="size-3" /> Paused
    </Badge>
  ) : (
    <Badge tone="primary">
      <Play className="size-3" /> Playing
    </Badge>
  );
}

function PlayerSkeleton() {
  return (
    <div
      className="grid gap-4 min-[1320px]:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]"
      aria-label="Loading player"
    >
      <div className="h-72 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
      <div className="h-72 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}

function clampPosition(view: PlaybackView): number {
  return Math.max(view.raw_start_ms, Math.min(view.raw_end_ms, view.position_ms));
}

function enforceBlockBounds(video: HTMLVideoElement, view: PlaybackView): number {
  const rawPosition = Math.round(video.currentTime * 1_000);
  const position = Math.max(view.raw_start_ms, Math.min(view.raw_end_ms, rawPosition));
  if (position !== rawPosition) video.currentTime = position / 1_000;
  return position;
}

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Playback could not continue.';
}

function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 1:
      return 'Playback was interrupted. Retry the local stream.';
    case 2:
      return 'The private local video stream could not be read. Retry the stream.';
    case 3:
      return 'The system media engine could not decode this prepared video stream.';
    case 4:
      return 'The prepared video stream was rejected by the system media engine.';
    default:
      return 'This video could not start in the in-app player. Retry the local stream.';
  }
}

function localIsoDate(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

const backLinkClass =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg border bg-background px-4 text-sm font-semibold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
