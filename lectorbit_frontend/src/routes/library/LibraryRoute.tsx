import { useEffect, useMemo, useRef, useState } from 'react';
import Ban from 'lucide-react/dist/esm/icons/ban';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import FolderSearch from 'lucide-react/dist/esm/icons/folder-search';
import FileAudio from 'lucide-react/dist/esm/icons/file-audio';
import FileVideo from 'lucide-react/dist/esm/icons/file-video';
import ScanLine from 'lucide-react/dist/esm/icons/scan-line';
import X from 'lucide-react/dist/esm/icons/x';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  listMedia,
  listRoots,
  listScanJobs,
  pickAndRegisterRoot,
  revokeRoot,
  startScan,
  LibraryRpcError,
  type LibraryErrorKind,
  type LibraryRoot,
  type MediaListItem,
  type ScanEvent,
  type ScanJob,
} from '../../ipc/library';
import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState, ErrorPanel } from '../../components/feedback/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { StatusBadge, type StatusKind } from '../../components/ui/StatusBadge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/Card';
import { cn } from '../../lib/cn';

interface LiveScan {
  status: StatusKind;
  label: string;
  current?: number;
  total?: number;
}

export function LibraryRoute() {
  const queryClient = useQueryClient();
  const [banner, setBanner] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<LibraryRoot | null>(null);
  const [liveScans, setLiveScans] = useState<Record<string, LiveScan>>({});

  const roots = useQuery({
    queryKey: ['library', 'roots'] as const,
    queryFn: listRoots,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const jobs = useQuery({
    queryKey: ['library', 'scan-jobs'] as const,
    queryFn: () => listScanJobs(),
    staleTime: 1_000,
    refetchInterval: (query) =>
      query.state.data?.some((job) => isActiveJob(job)) ? 1_500 : false,
  });

  const media = useInfiniteQuery({
    queryKey: ['library', 'media'] as const,
    queryFn: ({ pageParam }) => listMedia({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some(
          (item) => item.probe_status === 'queued' || item.probe_status === 'probing',
        ),
      )
        ? 1_500
        : false,
  });

  const scan = useMutation({
    mutationFn: ({ rootId }: { rootId: string }) =>
      startScan(rootId, (event) => {
        setLiveScans((current) => ({
          ...current,
          [rootId]: liveScanFromEvent(event),
        }));
        if (event.event === 'completed' || event.event === 'failed') {
          void queryClient.invalidateQueries({
            queryKey: ['library', 'scan-jobs'],
          });
          void queryClient.invalidateQueries({ queryKey: ['diagnostics'] });
          void queryClient.invalidateQueries({ queryKey: ['library', 'media'] });
        }
        if (event.event === 'metadata' && event.data.completed === event.data.total) {
          void queryClient.invalidateQueries({ queryKey: ['library', 'media'] });
        }
      }),
    onMutate: ({ rootId }) => {
      setLiveScans((current) => ({
        ...current,
        [rootId]: { status: 'queued', label: 'Queued locally' },
      }));
    },
    onSuccess: (_job, { rootId }) => {
      void queryClient.invalidateQueries({ queryKey: ['library', 'scan-jobs'] });
      setBanner('Scan queued. You can keep using LectorBit while it runs.');
      setLiveScans((current) => ({
        ...current,
        [rootId]: current[rootId] ?? {
          status: 'queued',
          label: 'Queued locally',
        },
      }));
    },
    onError: (error, { rootId }) => {
      setLiveScans((current) => ({
        ...current,
        [rootId]: { status: 'failed', label: humanizeError(error) },
      }));
      setBanner(humanizeError(error));
    },
  });

  const register = useMutation({
    mutationFn: pickAndRegisterRoot,
    onSuccess: (root) => {
      if (!root) return;
      void queryClient.invalidateQueries({ queryKey: ['library', 'roots'] });
      void queryClient.invalidateQueries({ queryKey: ['diagnostics'] });
      setBanner(`Added “${root.display_name}”. Starting its first local scan.`);
      scan.mutate({ rootId: root.id });
    },
    onError: (error) => setBanner(humanizeError(error)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeRoot(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['library', 'roots'] });
      const previous = queryClient.getQueryData<LibraryRoot[]>([
        'library',
        'roots',
      ]);
      queryClient.setQueryData<LibraryRoot[]>(['library', 'roots'], (current) =>
        (current ?? []).map((root) =>
          root.id === id
            ? { ...root, is_active: false, revoked_at: new Date().toISOString() }
            : root,
        ),
      );
      return { previous };
    },
    onSuccess: (root) => {
      setRevokeTarget(null);
      setBanner(`Revoked “${root.display_name}”. Future scans will skip it.`);
    },
    onError: (_error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['library', 'roots'], context.previous);
      }
      setBanner('Could not revoke that folder. Please try again.');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['library', 'roots'] });
      void queryClient.invalidateQueries({ queryKey: ['diagnostics'] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Library"
        title="Indexed media"
        description="Add approved folders, scan them without copying files, and keep the local index current."
        actions={
          <Button
            onClick={() => register.mutate()}
            disabled={register.isPending || roots.isPending}
            leftIcon={<FolderSearch className="size-4" />}
          >
            {register.isPending ? 'Adding…' : 'Add folder'}
          </Button>
        }
      />

      {banner ? (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-sm"
        >
          <span>{banner}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Dismiss"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}

      {roots.isPending ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner label="Loading registered roots" />
        </div>
      ) : null}

      {roots.isError ? (
        <ErrorPanel
          title="Could not load roots"
          error={roots.error}
          onRetry={() => void roots.refetch()}
        />
      ) : null}

      {roots.data && roots.data.length === 0 && !roots.isPending ? (
        <EmptyState
          title="No folders yet"
          description="Choose a folder of lectures or tutorials. LectorBit indexes it locally and never copies or uploads your media."
          action={
            <Button
              onClick={() => register.mutate()}
              disabled={register.isPending}
              leftIcon={<FolderSearch className="size-4" />}
            >
              Add your first folder
            </Button>
          }
        />
      ) : null}

      {roots.data && roots.data.length > 0 ? (
        <>
          <RootsTable
            roots={roots.data}
            jobs={jobs.data ?? []}
            liveScans={liveScans}
            pendingScanRootId={scan.variables?.rootId ?? null}
            pendingRevokeId={revoke.variables ?? null}
            onScan={(rootId) => scan.mutate({ rootId })}
            onRequestRevoke={setRevokeTarget}
          />
          <MediaLibraryCard
            items={media.data?.pages.flatMap((page) => page.items) ?? []}
            pending={media.isPending}
            error={media.error}
            hasNextPage={media.hasNextPage}
            loadingMore={media.isFetchingNextPage}
            onRetry={() => void media.refetch()}
            onLoadMore={() => void media.fetchNextPage()}
          />
        </>
      ) : null}

      {revokeTarget ? (
        <RevokeDialog
          root={revokeTarget}
          pending={revoke.isPending}
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => revoke.mutate(revokeTarget.id)}
        />
      ) : null}
    </div>
  );
}

function MediaLibraryCard({
  items,
  pending,
  error,
  hasNextPage,
  loadingMore,
  onRetry,
  onLoadMore,
}: {
  items: MediaListItem[];
  pending: boolean;
  error: Error | null;
  hasNextPage: boolean;
  loadingMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const mediaScrollRef = useRef<HTMLDivElement>(null);
  const virtualized = items.length > 200;
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => (virtualized ? mediaScrollRef.current : null),
    estimateSize: () => 76,
    overscan: 8,
    enabled: virtualized,
  });
  const visibleRows = virtualized
    ? rows.getVirtualItems().map((row) => ({ index: row.index, start: row.start }))
    : items.map((_, index) => ({ index, start: undefined }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Media index</CardTitle>
        <CardDescription>
          Duration and stream details are read locally with ffprobe. Files stay in place.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {pending ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Spinner label="Loading indexed media" />
          </div>
        ) : null}
        {error ? (
          <ErrorPanel title="Could not load indexed media" error={error} onRetry={onRetry} />
        ) : null}
        {!pending && !error && items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/35 px-6 py-8 text-center">
            <FileVideo aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No media indexed yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Scan an approved folder to discover supported video and audio files.
            </p>
          </div>
        ) : null}
        {items.length > 0 ? (
          <div
            ref={mediaScrollRef}
            className={cn('overflow-x-auto', virtualized && 'max-h-[640px] overflow-y-auto')}
          >
            <table className="w-full min-w-[900px] table-fixed text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  <th className="w-[32%] py-2.5 pr-4">Media</th>
                  <th className="w-[12%] py-2.5 pr-4">Duration</th>
                  <th className="w-[18%] py-2.5 pr-4">Video</th>
                  <th className="w-[20%] py-2.5 pr-4">Audio &amp; captions</th>
                  <th className="w-[18%] py-2.5">Metadata</th>
                </tr>
              </thead>
              <tbody
                className="divide-y divide-border"
                style={
                  virtualized
                    ? {
                        display: 'block',
                        height: `${rows.getTotalSize()}px`,
                        position: 'relative',
                      }
                    : undefined
                }
              >
                {visibleRows.map((row) => (
                  <MediaRow
                    key={items[row.index].id}
                    item={items[row.index]}
                    virtualStart={row.start}
                  />
                ))}
              </tbody>
            </table>
            {hasNextPage ? (
              <div className="flex justify-center border-t border-border pt-4">
                <Button variant="secondary" size="sm" disabled={loadingMore} onClick={onLoadMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MediaRow({
  item,
  virtualStart,
}: {
  item: MediaListItem;
  virtualStart?: number;
}) {
  return (
    <tr
      style={
        virtualStart === undefined
          ? undefined
          : {
              display: 'table',
              position: 'absolute',
              tableLayout: 'fixed',
              transform: `translateY(${virtualStart}px)`,
              width: '100%',
            }
      }
    >
      <td className="w-[32%] py-4 pr-4 align-top">
        <div className="flex min-w-64 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            {item.media_kind === 'audio' ? (
              <FileAudio aria-hidden="true" className="size-4" />
            ) : (
              <FileVideo aria-hidden="true" className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium">{item.display_name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {item.path_redacted} · {formatBytes(item.size_bytes)}
            </p>
          </div>
        </div>
      </td>
      <td className="w-[12%] py-4 pr-4 align-top font-mono text-xs">
        {formatDuration(item.duration_ms)}
      </td>
      <td className="w-[18%] py-4 pr-4 align-top text-xs text-muted-foreground">
        {formatVideoDetails(item)}
      </td>
      <td className="w-[20%] py-4 pr-4 align-top text-xs text-muted-foreground">
        {formatAudioDetails(item)}
      </td>
      <td className="w-[18%] py-4 align-top">
        <ProbeState item={item} />
      </td>
    </tr>
  );
}

function ProbeState({ item }: { item: MediaListItem }) {
  let status: StatusKind;
  let label: string;
  switch (item.probe_status) {
    case 'queued':
      status = 'queued';
      label = 'Waiting for metadata';
      break;
    case 'probing':
      status = 'processing';
      label = 'Inspecting locally';
      break;
    case 'ready':
      status = 'completed';
      label = 'Ready';
      break;
    case 'failed':
      status = 'failed';
      label = item.probe_error ?? 'Unreadable media';
      break;
    case 'unavailable':
      status = 'attention';
      label = 'ffprobe unavailable';
      break;
    case 'missing':
      status = 'attention';
      label = 'File unavailable';
      break;
  }
  return (
    <div className="flex flex-col items-start gap-1.5">
      <StatusBadge status={status} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function formatVideoDetails(item: MediaListItem): string {
  const resolution = item.width && item.height ? `${item.width}×${item.height}` : null;
  return [item.video_codec?.toUpperCase(), resolution, item.container?.toUpperCase()]
    .filter(Boolean)
    .join(' · ') || '—';
}

function formatAudioDetails(item: MediaListItem): string {
  const details = [];
  if (item.audio_codec) details.push(item.audio_codec.toUpperCase());
  if (item.audio_streams > 0) {
    details.push(`${item.audio_streams} audio ${item.audio_streams === 1 ? 'track' : 'tracks'}`);
  }
  if (item.subtitle_streams > 0) {
    details.push(`${item.subtitle_streams} caption ${item.subtitle_streams === 1 ? 'track' : 'tracks'}`);
  }
  return details.join(' · ') || '—';
}

function RootsTable({
  roots,
  jobs,
  liveScans,
  pendingScanRootId,
  pendingRevokeId,
  onScan,
  onRequestRevoke,
}: {
  roots: LibraryRoot[];
  jobs: ScanJob[];
  liveScans: Record<string, LiveScan>;
  pendingScanRootId: string | null;
  pendingRevokeId: string | null;
  onScan: (rootId: string) => void;
  onRequestRevoke: (root: LibraryRoot) => void;
}) {
  const sorted = useMemo(
    () =>
      [...roots].sort((left, right) => {
        if (left.is_active === right.is_active) return 0;
        return left.is_active ? -1 : 1;
      }),
    [roots],
  );
  const active = roots.filter((root) => root.is_active).length;
  const latestJobByRoot = useMemo(() => {
    const map = new Map<string, ScanJob>();
    for (const job of jobs) {
      if (!map.has(job.root_id)) map.set(job.root_id, job);
    }
    return map;
  }, [jobs]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approved folders</CardTitle>
        <CardDescription>
          {active} active · {roots.length - active} revoked
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                <th className="py-2.5 pr-4">Folder</th>
                <th className="py-2.5 pr-4">Access</th>
                <th className="py-2.5 pr-4">Latest scan</th>
                <th className="py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((root) => {
                const job = latestJobByRoot.get(root.id);
                const live = liveScans[root.id];
                const activeJob = job ? isActiveJob(job) : false;
                const scanPending =
                  pendingScanRootId === root.id || activeJob || live?.status === 'processing';
                return (
                  <tr key={root.id} className={cn(!root.is_active && 'opacity-60')}>
                    <td className="py-4 pr-4 align-top">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{root.display_name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {root.path_redacted}
                        </span>
                      </div>
                    </td>
                    <td className="py-4 pr-4 align-top">
                      {root.is_active ? (
                        <Badge tone="success">
                          <CircleCheck aria-hidden="true" className="size-3.5" />
                          Active
                        </Badge>
                      ) : (
                        <Badge tone="neutral">
                          <Ban aria-hidden="true" className="size-3.5" />
                          Revoked
                        </Badge>
                      )}
                    </td>
                    <td className="min-w-64 py-4 pr-4 align-top">
                      <ScanState live={live} job={job} />
                    </td>
                    <td className="py-4 text-right align-top">
                      {root.is_active ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={scanPending}
                            onClick={() => onScan(root.id)}
                            leftIcon={<ScanLine className="size-3.5" />}
                          >
                            {scanPending ? 'Scanning…' : job ? 'Scan again' : 'Scan'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingRevokeId === root.id}
                            onClick={() => onRequestRevoke(root)}
                          >
                            {pendingRevokeId === root.id ? 'Revoking…' : 'Revoke'}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ScanState({ live, job }: { live?: LiveScan; job?: ScanJob }) {
  const state = live ?? (job ? liveScanFromJob(job) : undefined);
  if (!state) {
    return <span className="text-xs text-muted-foreground">Not scanned yet</span>;
  }
  const hasProgress =
    state.current !== undefined && state.total !== undefined && state.total > 0;
  const progress = hasProgress
    ? Math.min(100, Math.round((state.current! / state.total!) * 100))
    : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <StatusBadge status={state.status} />
        <span className="text-xs text-muted-foreground">{state.label}</span>
      </div>
      {progress !== undefined && state.status === 'processing' ? (
        <div
          role="progressbar"
          aria-label="Scan progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function RevokeDialog({
  root,
  pending,
  onCancel,
  onConfirm,
}: {
  root: LibraryRoot;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, pending]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/60 px-4 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-md">
        <h2 id="revoke-title" className="font-display text-lg font-semibold">
          Revoke “{root.display_name}”?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Future scans will skip this folder. Existing progress stays intact and
          files remain untouched on disk.
        </p>
        <p className="mt-3 rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
          {root.path_redacted}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? 'Revoking…' : 'Revoke root'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function liveScanFromEvent(event: ScanEvent): LiveScan {
  switch (event.event) {
    case 'metadata':
      return event.data.completed === event.data.total
        ? {
            status: 'completed',
            label:
              event.data.failed > 0
                ? `Metadata finished · ${event.data.failed.toLocaleString()} unavailable`
                : 'Metadata ready',
          }
        : {
            status: 'processing',
            label: `Inspecting media ${event.data.completed.toLocaleString()} of ${event.data.total.toLocaleString()}`,
            current: event.data.completed,
            total: event.data.total,
          };
    case 'started':
      return { status: 'processing', label: 'Reading approved folder' };
    case 'discovering':
      return {
        status: 'processing',
        label: `${event.data.mediaCandidates.toLocaleString()} media found`,
      };
    case 'indexing':
      return {
        status: 'processing',
        label: `Indexing ${event.data.current.toLocaleString()} of ${event.data.total.toLocaleString()}`,
        current: event.data.current,
        total: event.data.total,
      };
    case 'completed':
      return {
        status: 'completed',
        label:
          event.data.issues > 0
            ? `${event.data.indexed.toLocaleString()} indexed · ${event.data.issues.toLocaleString()} skipped`
            : `${event.data.indexed.toLocaleString()} indexed`,
      };
    case 'failed':
      return { status: 'failed', label: event.data.message };
  }
}

function liveScanFromJob(job: ScanJob): LiveScan {
  switch (job.status) {
    case 'queued':
      return { status: 'queued', label: 'Waiting for a worker' };
    case 'running':
      return { status: 'processing', label: 'Scanning in background' };
    case 'completed':
      return { status: 'completed', label: formatTimestamp(job.updated_at) };
    case 'failed':
    case 'cancelled':
      return { status: 'failed', label: job.last_error ?? 'Scan stopped' };
    case 'paused':
    case 'retry_wait':
      return { status: 'attention', label: 'Waiting to resume' };
  }
}

function isActiveJob(job: ScanJob): boolean {
  return job.status === 'queued' || job.status === 'running' || job.status === 'retry_wait';
}

function humanizeError(error: unknown): string {
  if (error instanceof LibraryRpcError) {
    return humanize(error.kind, error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

function humanize(kind: LibraryErrorKind, fallback: string): string {
  switch (kind) {
    case 'empty_path':
      return 'No folder was selected.';
    case 'not_a_directory':
      return 'That location is not an available folder.';
    case 'not_found':
      return 'That folder is no longer available.';
    case 'io':
      return 'LectorBit could not read that folder.';
    case 'database':
      return 'The local database could not save this change.';
    case 'internal':
      return fallback;
  }
}

function formatTimestamp(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '—';
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
