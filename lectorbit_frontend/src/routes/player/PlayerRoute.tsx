import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import FastForward from 'lucide-react/dist/esm/icons/fast-forward';
import Flag from 'lucide-react/dist/esm/icons/flag';
import Pause from 'lucide-react/dist/esm/icons/pause';
import Play from 'lucide-react/dist/esm/icons/play';
import RefreshCcw from 'lucide-react/dist/esm/icons/refresh-ccw';
import Rewind from 'lucide-react/dist/esm/icons/rewind';
import Scissors from 'lucide-react/dist/esm/icons/scissors';
import Square from 'lucide-react/dist/esm/icons/square';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
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

type Phase = 'loading' | 'ready' | 'closed' | 'error';

const actionMessages: Record<StudyAction, string> = {
  complete: 'Marked complete.',
  skip: 'Skipped. Replan to remove it from future work.',
  postpone: 'Postponed. Replan when you are ready to move it.',
  split: 'Split point saved for the next plan.',
  repeat: 'Queued to repeat in the next plan.',
  must_watch: 'Marked must watch for the next plan.',
};

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const syncPendingRef = useRef(false);

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
        const requestedTimestamp = Number(searchParams.get('t'));
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
      if (opened) void closePlayback().catch(() => undefined);
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
      syncPendingRef.current = true;
      void syncPlayback(position, video.paused, video.playbackRate)
        .then(setView)
        .catch((cause) => setError(messageFrom(cause)))
        .finally(() => {
          syncPendingRef.current = false;
        });
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [phase, view?.raw_end_ms, view?.raw_start_ms, view?.stream_url]);

  const watchedPercent = useMemo(() => {
    if (!view || view.item_duration_ms === 0) return 0;
    return Math.min(100, Math.round((view.item_covered_ms / view.item_duration_ms) * 100));
  }, [view]);

  async function runControl(operation: () => Promise<PlaybackView>) {
    setBusy(true);
    setError(undefined);
    try {
      setView(await operation());
      setSeekDraft(undefined);
    } catch (cause) {
      setError(messageFrom(cause));
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
    const video = videoRef.current;
    if (!video || !view) return;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        setError(mediaErrorMessage(video.error));
        return;
      }
      await runControl(playPlayback);
    } else {
      video.pause();
      await runControl(pausePlayback);
    }
  }

  function retryMedia() {
    setError(undefined);
    videoRef.current?.load();
  }

  async function changeSpeed(speed: number) {
    if (videoRef.current) videoRef.current.playbackRate = speed;
    await runControl(() => setPlaybackSpeed(speed));
  }

  async function performAction(kind: StudyAction) {
    if (!view) return;
    setActionPending(kind);
    setActionMessage(undefined);
    setError(undefined);
    try {
      await recordStudyAction(
        view.plan_item_id,
        kind,
        kind === 'split' ? view.position_ms : undefined,
      );
      setActionMessage(actionMessages[kind]);
      setConfirmSkip(false);
      setView(await getPlaybackState());
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setActionPending(undefined);
    }
  }

  async function stopAndReturn() {
    setBusy(true);
    try {
      await closePlayback();
      void navigate('/');
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  async function replanRemaining() {
    setReplanPending(true);
    setError(undefined);
    try {
      await closePlayback();
      await replanActive(localIsoDate());
      await queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
      void navigate('/');
    } catch (cause) {
      setError(messageFrom(cause));
      setReplanPending(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Focused study"
        title={view?.display_name ?? 'Study player'}
        description="Watch inside LectorBit with private, token-gated local streaming and durable watched coverage."
        actions={
          <Link to="/" className={backLinkClass}>
            <ArrowLeft className="size-4" /> Routine
          </Link>
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
                  ref={videoRef}
                  src={view.stream_url}
                  className="size-full object-contain"
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={`Playing ${view.display_name}`}
                  onLoadedMetadata={(event) => {
                    event.currentTarget.currentTime = clampPosition(view) / 1_000;
                    event.currentTarget.playbackRate = view.speed;
                  }}
                  onCanPlay={() => setError(undefined)}
                  onTimeUpdate={(event) => {
                    if (event.currentTarget.currentTime * 1_000 >= view.raw_end_ms) {
                      event.currentTarget.pause();
                      event.currentTarget.currentTime = view.raw_end_ms / 1_000;
                    }
                  }}
                  onError={(event) => setError(mediaErrorMessage(event.currentTarget.error))}
                />
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
                  <Button className="col-span-1" variant="ghost" disabled={busy} onClick={() => void stopAndReturn()}>
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
                  disabled={Boolean(actionPending)}
                  onClick={() => void performAction('complete')}
                >
                  <CheckCircle2 className="size-4" /> Mark complete
                </Button>
                <Button
                  variant="outline"
                  disabled={Boolean(actionPending)}
                  onClick={() => void performAction('postpone')}
                >
                  <Clock3 className="size-4" /> Postpone
                </Button>
                <Button
                  variant="outline"
                  disabled={Boolean(actionPending)}
                  onClick={() => void performAction('split')}
                >
                  <Scissors className="size-4" /> Split here
                </Button>
                <Button
                  variant="outline"
                  disabled={Boolean(actionPending)}
                  onClick={() => void performAction('repeat')}
                >
                  <RefreshCcw className="size-4" /> Repeat
                </Button>
                <Button
                  variant="outline"
                  disabled={Boolean(actionPending)}
                  onClick={() => void performAction('must_watch')}
                >
                  <Flag className="size-4" /> Must watch
                </Button>
                {confirmSkip ? (
                  <>
                    <Button
                      variant="destructive"
                      disabled={Boolean(actionPending)}
                      onClick={() => void performAction('skip')}
                    >
                      Confirm skip
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmSkip(false)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={Boolean(actionPending)}
                    onClick={() => setConfirmSkip(true)}
                  >
                    Skip
                  </Button>
                )}
                <Button
                  className="col-span-2 sm:ml-auto"
                  variant="secondary"
                  disabled={Boolean(actionPending) || replanPending}
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
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg border bg-background px-4 text-sm font-semibold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
