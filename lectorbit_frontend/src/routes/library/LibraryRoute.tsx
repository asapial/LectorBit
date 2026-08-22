import { useEffect, useMemo, useRef, useState } from 'react';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import FolderSearch from 'lucide-react/dist/esm/icons/folder-search';
import FileAudio from 'lucide-react/dist/esm/icons/file-audio';
import FileVideo from 'lucide-react/dist/esm/icons/file-video';
import ScanLine from 'lucide-react/dist/esm/icons/scan-line';
import Captions from 'lucide-react/dist/esm/icons/captions';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import X from 'lucide-react/dist/esm/icons/x';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from 'react-router';
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
  type MediaSummary,
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
import { listModels, startTranscription, type AnalysisProgress } from '../../ipc/analysis';

interface LiveScan {
  status: StatusKind;
  label: string;
  current?: number;
  total?: number;
}

const MEDIA_PAGE_SIZE = 10;

export function LibraryRoute() {
  const queryClient = useQueryClient();
  const [banner, setBanner] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LibraryRoot | null>(null);
  const [liveScans, setLiveScans] = useState<Record<string, LiveScan>>({});
  const [analysisProgress, setAnalysisProgress] = useState<Record<string, AnalysisProgress>>({});

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
    refetchInterval: (query) => (query.state.data?.some((job) => isActiveJob(job)) ? 1_500 : false),
  });

  // Media is queried per-root (see FolderMediaCard below) so each folder shows
  // its own independent list with separate pagination and per-folder counters.

  const models = useQuery({
    queryKey: ['analysis', 'models'] as const,
    queryFn: listModels,
    staleTime: 5_000,
  });
  const readyModelId = models.data?.find((model) => model.state === 'ready')?.id;
  const activeRoots = (roots.data ?? []).filter((root) => root.is_active);

  const transcribe = useMutation({
    mutationFn: ({ mediaId, modelId }: { mediaId: string; modelId: string }) =>
      startTranscription(mediaId, modelId, (event) => {
        setAnalysisProgress((current) => ({ ...current, [mediaId]: event }));
        if (event.event === 'completed') {
          setBanner('Transcript indexed. Its timestamped moments are now searchable.');
          void queryClient.invalidateQueries({ queryKey: ['search'] });
        }
        if (event.event === 'failed') setBanner(event.data.message);
      }),
    onSuccess: () =>
      setBanner('Transcription queued locally. You can keep studying while it runs.'),
    onError: (error) =>
      setBanner(error instanceof Error ? error.message : 'Transcription could not start.'),
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

  const busyScanRootIds = useMemo(() => {
    const ids = new Set<string>();
    for (const job of jobs.data ?? []) {
      if (isActiveJob(job)) ids.add(job.root_id);
    }
    for (const [rootId, live] of Object.entries(liveScans)) {
      if (live.status === 'processing') ids.add(rootId);
    }
    if (scan.isPending && scan.variables?.rootId) ids.add(scan.variables.rootId);
    return ids;
  }, [jobs.data, liveScans, scan.isPending, scan.variables]);

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

  const removeFolder = useMutation({
    mutationFn: (id: string) => revokeRoot(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['library', 'roots'] });
      const previous = queryClient.getQueryData<LibraryRoot[]>(['library', 'roots']);
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
      setRemoveTarget(null);
      setBanner(`Removed “${root.display_name}” from LectorBit. Files on disk were not changed.`);
      void queryClient.invalidateQueries({ queryKey: ['library', 'media'] });
    },
    onError: (_error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['library', 'roots'], context.previous);
      }
      setBanner('Could not remove that folder. Please try again.');
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
        description="Add a course folder once. LectorBit scans every subfolder, reads each video locally, and prepares metadata for planning."
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

      {roots.data && activeRoots.length === 0 && !roots.isPending ? (
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

      {activeRoots.length > 0 ? (
        <>
          <RootsTable
            roots={activeRoots}
            jobs={jobs.data ?? []}
            liveScans={liveScans}
            busyScanRootIds={busyScanRootIds}
            pendingRemoveId={removeFolder.isPending ? (removeFolder.variables ?? null) : null}
            onScan={(rootId) => scan.mutate({ rootId })}
            onRequestRemove={setRemoveTarget}
          />
          {activeRoots.map((root) => (
            <FolderMediaCard
              key={root.id}
              root={root}
              readyModelId={readyModelId}
              analysisProgress={analysisProgress}
              pendingMediaId={transcribe.isPending ? transcribe.variables?.mediaId : undefined}
              onTranscribe={(mediaId, modelId) => transcribe.mutate({ mediaId, modelId })}
            />
          ))}
        </>
      ) : null}

      {removeTarget ? (
        <RemoveFolderDialog
          root={removeTarget}
          pending={removeFolder.isPending}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => removeFolder.mutate(removeTarget.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * Per-folder wrapper: owns a single `useInfiniteQuery` scoped to one root.
 * This ensures each library folder is its own independent module — pagination,
 * counters, and media rows never mix across different roots.
 */
function FolderMediaCard({
  root,
  readyModelId,
  analysisProgress,
  pendingMediaId,
  onTranscribe,
}: {
  root: LibraryRoot;
  readyModelId?: string;
  analysisProgress: Record<string, AnalysisProgress>;
  pendingMediaId?: string;
  onTranscribe: (mediaId: string, modelId: string) => void;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const media = useInfiniteQuery({
    queryKey: ['library', 'media', root.id] as const,
    queryFn: ({ pageParam }) =>
      listMedia({ rootId: root.id, cursor: pageParam, limit: MEDIA_PAGE_SIZE }),
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

  const pages = media.data?.pages ?? [];
  const currentPage = pages[pageIndex];
  // Treat the root boundary defensively as well as at the database query. A
  // malformed/stale page can never leak another folder's media into this module.
  const items = currentPage?.items.filter((item) => item.root_id === root.id) ?? [];
  const summary = pages[0]?.summary;
  const totalPages = summary
    ? Math.max(1, Math.ceil(summary.total_items / MEDIA_PAGE_SIZE))
    : Math.max(1, pages.length + (media.hasNextPage ? 1 : 0));
  const canGoBack = pageIndex > 0;
  const canGoForward = pageIndex < pages.length - 1 || media.hasNextPage;

  useEffect(() => {
    if (pageIndex >= pages.length && pages.length > 0) setPageIndex(pages.length - 1);
  }, [pageIndex, pages.length]);

  const goForward = async () => {
    if (pageIndex < pages.length - 1) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (!media.hasNextPage || media.isFetchingNextPage) return;
    const result = await media.fetchNextPage();
    if ((result.data?.pages.length ?? 0) > pages.length) {
      setPageIndex((current) => current + 1);
    }
  };

  return (
    <MediaLibraryCard
      root={root}
      items={items}
      summary={summary}
      pageNumber={pageIndex + 1}
      totalPages={totalPages}
      pending={media.isPending}
      error={media.error}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      changingPage={media.isFetchingNextPage}
      onRetry={() => void media.refetch()}
      onPreviousPage={() => setPageIndex((current) => Math.max(0, current - 1))}
      onNextPage={() => void goForward()}
      readyModelId={readyModelId}
      analysisProgress={analysisProgress}
      pendingMediaId={pendingMediaId}
      onTranscribe={onTranscribe}
    />
  );
}

function MediaLibraryCard({
  root,
  items,
  summary,
  pageNumber,
  totalPages,
  pending,
  error,
  canGoBack,
  canGoForward,
  changingPage,
  onRetry,
  onPreviousPage,
  onNextPage,
  readyModelId,
  analysisProgress,
  pendingMediaId,
  onTranscribe,
}: {
  root: LibraryRoot;
  items: MediaListItem[];
  summary?: MediaSummary;
  pageNumber: number;
  totalPages: number;
  pending: boolean;
  error: Error | null;
  canGoBack: boolean;
  canGoForward: boolean;
  changingPage: boolean;
  onRetry: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  readyModelId?: string;
  analysisProgress: Record<string, AnalysisProgress>;
  pendingMediaId?: string;
  onTranscribe: (mediaId: string, modelId: string) => void;
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
  const loadedReadyCount = items.filter((item) => item.probe_status === 'ready').length;
  const loadedAttentionCount = items.filter((item) =>
    ['failed', 'unavailable', 'missing'].includes(item.probe_status),
  ).length;
  const loadedDurationMs = items.reduce((total, item) => total + (item.duration_ms ?? 0), 0);
  const loadedDurationKnownCount = items.filter((item) => item.duration_ms !== null).length;
  const totalCount = summary?.total_items ?? items.length;
  const readyCount = summary?.ready_items ?? loadedReadyCount;
  const attentionCount = summary?.attention_items ?? loadedAttentionCount;
  const knownDurationMs = summary?.known_duration_ms ?? loadedDurationMs;
  const durationKnownCount = summary?.duration_known_items ?? loadedDurationKnownCount;
  const totalsAreExact = summary !== undefined;
  const pageDetail = `Page ${pageNumber.toLocaleString()} of ${totalPages.toLocaleString()}`;
  const mediaMetricLabel = totalsAreExact || !canGoForward ? 'Media in module' : 'Media loaded';
  const mediaMetricDetail = totalsAreExact
    ? `${items.length.toLocaleString()} shown · ${pageDetail}`
    : pageDetail;
  const readyMetricDetail = totalsAreExact
    ? `${readyCount.toLocaleString()} metadata-ready in this module`
    : `${readyCount.toLocaleString()} metadata-ready on loaded pages`;
  const attentionMetricDetail =
    attentionCount === 0
      ? 'module is healthy'
      : loadedAttentionCount > 0
        ? 'affected videos are visible on this page'
        : 'review the remaining video pages';
  const moduleHeadingId = `library-module-${root.id}`;
  return (
    <section aria-labelledby={moduleHeadingId}>
      <Card className="overflow-hidden border-border/90">
        <CardHeader className="gap-4 border-b border-border/70 bg-muted/15 pb-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <Badge tone="primary">Independent folder module</Badge>
              <CardTitle id={moduleHeadingId} className="mt-2 text-lg">
                {root.display_name}
              </CardTitle>
              <CardDescription
                className="mt-1.5 truncate font-mono text-xs"
                title={root.path_redacted}
              >
                {root.path_redacted}
              </CardDescription>
            </div>
            <Link
              to={{ pathname: '/plan', search: `?module=${encodeURIComponent(root.id)}` }}
              aria-label={`Plan ${root.display_name} module with AI`}
              className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-primary/15 bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-sm transition-[background-color,box-shadow,transform] hover:-translate-y-px hover:bg-primary/90 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Sparkles aria-hidden="true" className="size-3.5" />
              Plan module with AI
            </Link>
          </div>
          {!pending && !error ? (
            <div
              className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
              aria-label={`${root.display_name} module summary`}
            >
              <ModuleMetric
                label={mediaMetricLabel}
                value={totalCount.toLocaleString()}
                detail={mediaMetricDetail}
              />
              <ModuleMetric
                label="Ready to plan"
                value={readyCount.toLocaleString()}
                detail={readyMetricDetail}
                tone="success"
              />
              <ModuleMetric
                label={summary || !canGoForward ? 'Known study time' : 'Loaded study time'}
                value={formatModuleDuration(knownDurationMs)}
                detail={`${durationKnownCount.toLocaleString()} of ${totalCount.toLocaleString()} durations known`}
              />
              <ModuleMetric
                label="Needs attention"
                value={attentionCount.toLocaleString()}
                detail={attentionMetricDetail}
                tone={attentionCount > 0 ? 'warning' : 'neutral'}
              />
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="pt-5">
          {pending ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Spinner label="Loading indexed media" />
            </div>
          ) : null}
          {error ? (
            <ErrorPanel title="Could not load indexed media" error={error} onRetry={onRetry} />
          ) : null}
          {!pending && !error && loadedAttentionCount > 0 ? (
            <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
              />
              <div>
                <p className="font-medium">Some metadata needs another pass</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Use Rescan folder in the folder table above after the media inspector is
                  available. LectorBit leaves the media files untouched.
                </p>
              </div>
            </div>
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
              className={cn(
                'responsive-table-shell',
                virtualized && 'max-h-[640px] overflow-y-auto',
              )}
            >
              <table className="w-full min-w-[900px] table-fixed text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-left text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
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
                      readyModelId={readyModelId}
                      analysisEvent={analysisProgress[items[row.index].id]}
                      pending={pendingMediaId === items[row.index].id}
                      onTranscribe={onTranscribe}
                    />
                  ))}
                </tbody>
              </table>
              {totalPages > 1 ? (
                <nav
                  aria-label={`${root.display_name} video pages`}
                  className="flex items-center justify-between gap-3 border-t border-border pt-4"
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canGoBack || changingPage}
                    onClick={onPreviousPage}
                  >
                    Previous
                  </Button>
                  <span className="text-xs font-medium tabular-nums text-muted-foreground">
                    {pageDetail}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canGoForward || changingPage}
                    onClick={onNextPage}
                  >
                    {changingPage ? 'Loading…' : 'Next'}
                  </Button>
                </nav>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function ModuleMetric({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'success' | 'warning';
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/75 px-3.5 py-3 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 font-display text-xl font-semibold tabular-nums',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function MediaRow({
  item,
  virtualStart,
  readyModelId,
  analysisEvent,
  pending,
  onTranscribe,
}: {
  item: MediaListItem;
  virtualStart?: number;
  readyModelId?: string;
  analysisEvent?: AnalysisProgress;
  pending: boolean;
  onTranscribe: (mediaId: string, modelId: string) => void;
}) {
  return (
    <tr
      className="transition-colors hover:bg-muted/25"
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
        {item.probe_status === 'ready' ? (
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!readyModelId || pending || isAnalysisActive(analysisEvent)}
              onClick={() => readyModelId && onTranscribe(item.id, readyModelId)}
              leftIcon={<Captions className="size-3.5" />}
              title={
                readyModelId
                  ? 'Create or refresh the local transcript'
                  : 'Install a model in Settings first'
              }
            >
              {analysisLabel(analysisEvent, pending)}
            </Button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function isAnalysisActive(event?: AnalysisProgress) {
  return (
    event !== undefined &&
    ['queued', 'extracting', 'transcribing', 'indexing'].includes(event.event)
  );
}

function analysisLabel(event: AnalysisProgress | undefined, pending: boolean) {
  if (pending || event?.event === 'queued') return 'Queued';
  if (event?.event === 'extracting') return 'Extracting audio…';
  if (event?.event === 'transcribing') return 'Transcribing…';
  if (event?.event === 'indexing') return 'Indexing…';
  if (event?.event === 'completed') return 'Transcribed';
  if (event?.event === 'failed') return 'Try transcript again';
  return 'Transcribe';
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
      label = item.probe_error ?? 'Metadata could not be read';
      break;
    case 'unavailable':
      status = 'attention';
      label = item.probe_error ?? 'Metadata service unavailable';
      break;
    case 'missing':
      status = 'attention';
      label = 'File was not found during the last scan';
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

function formatModuleDuration(durationMs: number): string {
  if (durationMs <= 0) return '0m';
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function formatVideoDetails(item: MediaListItem): string {
  const resolution = item.width && item.height ? `${item.width}×${item.height}` : null;
  return (
    [item.video_codec?.toUpperCase(), resolution, item.container?.toUpperCase()]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

function formatAudioDetails(item: MediaListItem): string {
  const details = [];
  if (item.audio_codec) details.push(item.audio_codec.toUpperCase());
  if (item.audio_streams > 0) {
    details.push(`${item.audio_streams} audio ${item.audio_streams === 1 ? 'track' : 'tracks'}`);
  }
  if (item.subtitle_streams > 0) {
    details.push(
      `${item.subtitle_streams} caption ${item.subtitle_streams === 1 ? 'track' : 'tracks'}`,
    );
  }
  return details.join(' · ') || '—';
}

function RootsTable({
  roots,
  jobs,
  liveScans,
  busyScanRootIds,
  pendingRemoveId,
  onScan,
  onRequestRemove,
}: {
  roots: LibraryRoot[];
  jobs: ScanJob[];
  liveScans: Record<string, LiveScan>;
  busyScanRootIds: ReadonlySet<string>;
  pendingRemoveId: string | null;
  onScan: (rootId: string) => void;
  onRequestRemove: (root: LibraryRoot) => void;
}) {
  const latestJobByRoot = useMemo(() => {
    const map = new Map<string, ScanJob>();
    for (const job of jobs) {
      if (!map.has(job.root_id)) map.set(job.root_id, job);
    }
    return map;
  }, [jobs]);

  return (
    <Card>
      <CardHeader className="border-b border-border/70 pb-5">
        <CardTitle>Library folders</CardTitle>
        <CardDescription>
          {roots.length.toLocaleString()} {roots.length === 1 ? 'folder' : 'folders'} indexed
          locally
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="responsive-table-shell">
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
              {roots.map((root) => {
                const job = latestJobByRoot.get(root.id);
                const live = liveScans[root.id];
                const scanPending = busyScanRootIds.has(root.id);
                return (
                  <tr key={root.id} className="transition-colors hover:bg-muted/25">
                    <td className="py-4 pr-4 align-top">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{root.display_name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {root.path_redacted}
                        </span>
                      </div>
                    </td>
                    <td className="py-4 pr-4 align-top">
                      <Badge tone="success">
                        <CircleCheck aria-hidden="true" className="size-3.5" />
                        Active
                      </Badge>
                    </td>
                    <td className="min-w-64 py-4 pr-4 align-top">
                      <ScanState live={live} job={job} />
                    </td>
                    <td className="py-4 text-right align-top">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={scanPending}
                          onClick={() => onScan(root.id)}
                          leftIcon={<ScanLine className="size-3.5" />}
                        >
                          {scanPending ? 'Scanning folder…' : job ? 'Rescan folder' : 'Scan folder'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={pendingRemoveId === root.id}
                          onClick={() => onRequestRemove(root)}
                          leftIcon={<Trash2 className="size-3.5" />}
                        >
                          {pendingRemoveId === root.id ? 'Removing…' : 'Remove'}
                        </Button>
                      </div>
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
  const hasProgress = state.current !== undefined && state.total !== undefined && state.total > 0;
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

function RemoveFolderDialog({
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
      aria-labelledby="remove-folder-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/60 p-3 backdrop-blur-[2px] sm:items-center sm:px-4"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-2xl sm:p-6">
        <div className="mb-4 grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
          <Trash2 aria-hidden="true" className="size-5" />
        </div>
        <h2 id="remove-folder-title" className="font-display text-lg font-semibold">
          Remove “{root.display_name}”?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This removes the folder and its media from the active LectorBit library. Your original
          files and folders remain untouched on disk.
        </p>
        <p className="mt-3 rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
          {root.path_redacted}
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? 'Removing…' : 'Remove folder'}
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
