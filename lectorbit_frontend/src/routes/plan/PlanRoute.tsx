import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import CalendarClock from 'lucide-react/dist/esm/icons/calendar-clock';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { Link } from 'react-router';
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
  commitPlan,
  listPlanningCandidates,
  previewPlan,
  type AlternativePatch,
  type PlanAlternative,
  type PlanPreview,
  type PlanRequest,
  type PlannerCandidate,
  type PlanningConstraints,
  type PlanningSelection,
} from '../../ipc/planner';
import { cn } from '../../lib/cn';

const weekdays = [
  ['M', 0],
  ['T', 1],
  ['W', 2],
  ['T', 3],
  ['F', 4],
  ['S', 5],
  ['S', 6],
] as const;

const defaultConstraints: PlanningConstraints = {
  daily_budget_minutes: 45,
  allowed_weekdays: [0, 1, 2, 3, 4],
  preferred_session_minutes: 25,
  max_continuous_minutes: 30,
  minimum_break_minutes: 5,
  playback_speed_milli: 1000,
  horizon_days: 14,
};

export function PlanRoute() {
  const queryClient = useQueryClient();
  const [constraints, setConstraints] = useState(defaultConstraints);
  const [selections, setSelections] = useState<Record<string, PlanningSelection>>({});
  const [title, setTitle] = useState('My study plan');
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewedRequest, setPreviewedRequest] = useState<PlanRequest | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState<string | null>(null);

  const candidatesQuery = useInfiniteQuery({
    queryKey: ['planner', 'candidates'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listPlanningCandidates({ cursor: pageParam, limit: 100 }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const candidates = useMemo(
    () => candidatesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [candidatesQuery.data],
  );

  const previewMutation = useMutation({
    mutationFn: previewPlan,
    onSuccess: (result, request) => {
      setPreview(result);
      setPreviewedRequest(request);
      setFormError(null);
      setCommitMessage(null);
    },
    onError: (error: Error) => setFormError(error.message),
  });
  const commitMutation = useMutation({
    mutationFn: ({ request, planTitle }: { request: PlanRequest; planTitle: string }) =>
      commitPlan(planTitle, request),
    onSuccess: () => {
      setCommitMessage('Plan committed. Your Routine is ready.');
      void queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const currentRequest = useMemo<PlanRequest>(
    () => ({
      horizon_start: localIsoDate(),
      constraints,
      selections: Object.values(selections).sort((a, b) =>
        a.media_id.localeCompare(b.media_id),
      ),
    }),
    [constraints, selections],
  );

  function markEdited() {
    setPreview(null);
    setPreviewedRequest(null);
    setCommitMessage(null);
    setFormError(null);
  }

  function updateConstraints(next: PlanningConstraints) {
    setConstraints(next);
    markEdited();
  }

  function toggleCandidate(candidate: PlannerCandidate) {
    setSelections((current) => {
      const next = { ...current };
      if (next[candidate.media_id]) {
        delete next[candidate.media_id];
      } else {
        next[candidate.media_id] = {
          media_id: candidate.media_id,
          priority: 3,
          deadline: null,
          dependencies: [],
        };
      }
      return next;
    });
    markEdited();
  }

  function updateSelection(mediaId: string, patch: Partial<PlanningSelection>) {
    setSelections((current) => ({
      ...current,
      [mediaId]: { ...current[mediaId], ...patch },
    }));
    markEdited();
  }

  function requestPreview(request = currentRequest) {
    if (request.selections.length === 0) {
      setFormError('Select at least one ready media item.');
      return;
    }
    if (request.constraints.max_continuous_minutes > request.constraints.daily_budget_minutes) {
      setFormError('Maximum continuous time cannot exceed the daily budget.');
      return;
    }
    previewMutation.mutate(request);
  }

  function applyAlternative(alternative: PlanAlternative) {
    const next = patchRequest(currentRequest, alternative.patch);
    setConstraints(next.constraints);
    setSelections(Object.fromEntries(next.selections.map((item) => [item.media_id, item])));
    setPreview(null);
    setPreviewedRequest(null);
    previewMutation.mutate(next);
  }

  return (
    <>
      <PageHeader
        eyebrow="Plan Builder"
        title="Build a calm, feasible routine"
        description="Choose ready media and set the limits that matter. LectorBit owns the arithmetic and never commits a plan that breaks a hard constraint."
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>1. Choose study media</CardTitle>
                <CardDescription>
                  Only metadata-ready files appear. Selected timestamps stay backend-owned.
                </CardDescription>
              </div>
              <Badge tone="primary">{Object.keys(selections).length} selected</Badge>
            </CardHeader>
            <CardContent>
              {candidatesQuery.isLoading ? (
                <LoadingLine label="Loading ready media" />
              ) : candidatesQuery.isError ? (
                <InlineError message="Ready media could not be loaded." />
              ) : candidates.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center">
                  <p className="text-sm font-medium">No schedulable media yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add a folder and let metadata inspection finish first.
                  </p>
                  <Link to="/library" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">
                    Open Library
                  </Link>
                </div>
              ) : (
                <CandidateList
                  candidates={candidates}
                  selections={selections}
                  onToggle={toggleCandidate}
                  onUpdate={updateSelection}
                />
              )}
              {candidatesQuery.hasNextPage ? (
                <Button
                  variant="outline"
                  className="mt-3 w-full"
                  disabled={candidatesQuery.isFetchingNextPage}
                  onClick={() => void candidatesQuery.fetchNextPage()}
                >
                  {candidatesQuery.isFetchingNextPage ? 'Loading…' : 'Load more media'}
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Set your constraints</CardTitle>
              <CardDescription>
                Time budgets are hard caps. Playback speed changes effective duration, never raw timestamps.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Study days</legend>
                <div className="flex flex-wrap gap-2">
                  {weekdays.map(([label, value], index) => {
                    const active = constraints.allowed_weekdays.includes(value);
                    return (
                      <button
                        key={`${label}-${index}`}
                        type="button"
                        aria-pressed={active}
                        aria-label={weekdayName(value)}
                        onClick={() => {
                          const allowed = active
                            ? constraints.allowed_weekdays.filter((day) => day !== value)
                            : [...constraints.allowed_weekdays, value].sort();
                          updateConstraints({ ...constraints, allowed_weekdays: allowed });
                        }}
                        className={cn(
                          'grid size-9 place-items-center rounded-md border text-sm font-medium transition-colors',
                          active
                            ? 'border-primary bg-accent text-accent-foreground'
                            : 'bg-background text-muted-foreground hover:bg-secondary',
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <NumberField
                  id="daily-budget"
                  label="Daily budget"
                  suffix="min"
                  value={constraints.daily_budget_minutes}
                  min={1}
                  max={1440}
                  onChange={(value) => updateConstraints({ ...constraints, daily_budget_minutes: value })}
                />
                <NumberField
                  id="preferred-session"
                  label="Preferred session"
                  suffix="min"
                  value={constraints.preferred_session_minutes}
                  min={1}
                  max={480}
                  onChange={(value) => updateConstraints({ ...constraints, preferred_session_minutes: value })}
                />
                <NumberField
                  id="max-continuous"
                  label="Max continuous"
                  suffix="min"
                  value={constraints.max_continuous_minutes}
                  min={1}
                  max={480}
                  onChange={(value) => updateConstraints({ ...constraints, max_continuous_minutes: value })}
                />
                <NumberField
                  id="break-minutes"
                  label="Break between blocks"
                  suffix="min"
                  value={constraints.minimum_break_minutes}
                  min={0}
                  max={120}
                  onChange={(value) => updateConstraints({ ...constraints, minimum_break_minutes: value })}
                />
                <label className="space-y-1.5 text-sm font-medium" htmlFor="playback-speed">
                  Playback speed
                  <select
                    id="playback-speed"
                    value={constraints.playback_speed_milli}
                    onChange={(event) => updateConstraints({
                      ...constraints,
                      playback_speed_milli: Number(event.target.value),
                    })}
                    className={inputClass}
                  >
                    {[500, 750, 1000, 1250, 1500, 1750, 2000].map((speed) => (
                      <option key={speed} value={speed}>{(speed / 1000).toFixed(2)}x</option>
                    ))}
                  </select>
                </label>
                <NumberField
                  id="horizon-days"
                  label="Planning horizon"
                  suffix="days"
                  value={constraints.horizon_days}
                  min={1}
                  max={366}
                  onChange={(value) => updateConstraints({ ...constraints, horizon_days: value })}
                />
              </div>

              <label className="block space-y-1.5 text-sm font-medium" htmlFor="plan-title">
                Plan name
                <input
                  id="plan-title"
                  value={title}
                  maxLength={80}
                  onChange={(event) => setTitle(event.target.value)}
                  className={inputClass}
                />
              </label>

              {formError ? <InlineError message={formError} /> : null}
              <div className="flex justify-end">
                <Button
                  onClick={() => requestPreview()}
                  disabled={previewMutation.isPending}
                  leftIcon={previewMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                >
                  {previewMutation.isPending ? 'Planning…' : 'Preview plan'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <PreviewPanel
          preview={preview}
          isPending={previewMutation.isPending}
          alternativesDisabled={previewMutation.isPending}
          onApplyAlternative={applyAlternative}
          onCommit={() => {
            if (previewedRequest) commitMutation.mutate({ request: previewedRequest, planTitle: title });
          }}
          commitPending={commitMutation.isPending}
          commitMessage={commitMessage}
        />
      </div>
    </>
  );
}

function CandidateList({
  candidates,
  selections,
  onToggle,
  onUpdate,
}: {
  candidates: PlannerCandidate[];
  selections: Record<string, PlanningSelection>;
  onToggle: (candidate: PlannerCandidate) => void;
  onUpdate: (mediaId: string, patch: Partial<PlanningSelection>) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualized = candidates.length > 200;
  const virtualizer = useVirtualizer({
    count: candidates.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (selections[candidates[index].media_id] ? 136 : 76),
    overscan: 6,
    enabled: virtualized,
  });
  const renderRow = (candidate: PlannerCandidate) => (
    <CandidateRow
      key={candidate.media_id}
      candidate={candidate}
      selection={selections[candidate.media_id]}
      onToggle={() => onToggle(candidate)}
      onUpdate={(patch) => onUpdate(candidate.media_id, patch)}
    />
  );
  if (!virtualized) {
    return <div className="divide-y rounded-lg border">{candidates.map(renderRow)}</div>;
  }
  return (
    <div ref={parentRef} className="scrollbar-thin h-[34rem] overflow-auto rounded-lg border">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={candidates[row.index].media_id}
            ref={virtualizer.measureElement}
            data-index={row.index}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderRow(candidates[row.index])}
          </div>
        ))}
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  selection,
  onToggle,
  onUpdate,
}: {
  candidate: PlannerCandidate;
  selection?: PlanningSelection;
  onToggle: () => void;
  onUpdate: (patch: Partial<PlanningSelection>) => void;
}) {
  const checked = Boolean(selection);
  return (
    <div className={cn('p-3', checked && 'bg-accent/35')}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1 size-4 accent-primary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{candidate.display_name}</span>
          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
            {candidate.path_redacted} · {formatDuration(candidate.duration_ms)} · {candidate.chunk_count} chunks
          </span>
        </span>
      </label>
      {selection ? (
        <div className="ml-7 mt-3 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            Priority
            <select
              value={selection.priority}
              onChange={(event) => onUpdate({ priority: Number(event.target.value) })}
              className={inputClass}
            >
              <option value={1}>Low</option><option value={2}>Below normal</option>
              <option value={3}>Normal</option><option value={4}>High</option><option value={5}>Critical</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            Deadline <span className="font-normal text-muted-foreground">(optional)</span>
            <input
              type="date"
              value={selection.deadline ?? ''}
              min={localIsoDate()}
              onChange={(event) => onUpdate({ deadline: event.target.value || null })}
              className={inputClass}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function PreviewPanel({
  preview,
  isPending,
  alternativesDisabled,
  onApplyAlternative,
  onCommit,
  commitPending,
  commitMessage,
}: {
  preview: PlanPreview | null;
  isPending: boolean;
  alternativesDisabled: boolean;
  onApplyAlternative: (alternative: PlanAlternative) => void;
  onCommit: () => void;
  commitPending: boolean;
  commitMessage: string | null;
}) {
  return (
    <Card className="xl:sticky xl:top-6">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>3. Review and commit</CardTitle>
          {preview ? (
            <Badge tone={preview.feasible ? 'success' : 'warning'}>
              {preview.feasible ? <CheckCircle2 className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
              {preview.feasible ? 'Feasible' : 'Needs changes'}
            </Badge>
          ) : null}
        </div>
        <CardDescription>Preview is disposable. Commit creates a new immutable version.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isPending ? <LoadingLine label="Checking every hard constraint" /> : null}
        {!preview && !isPending ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            <ListChecks className="mx-auto mb-2 size-6 text-primary" />
            Your day-by-day routine will appear here.
          </div>
        ) : null}
        {preview ? (
          <>
            <SceneStrip preview={preview} />
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Study blocks" value={String(preview.items.length)} />
              <Metric label="Study days" value={String(preview.days.length)} />
            </div>
            {preview.feasible ? (
              <div className="space-y-3">
                <div className="max-h-72 space-y-2 overflow-auto pr-1 scrollbar-thin">
                  {preview.days.map((day) => (
                    <div key={day.date} className="rounded-md border bg-background p-3">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium">{formatDay(day.date)}</span>
                        <span className="text-xs text-muted-foreground">{formatDuration(day.effective_content_ms)}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{day.item_count} blocks · {formatDuration(day.break_ms)} breaks</p>
                    </div>
                  ))}
                </div>
                <Button className="w-full" onClick={onCommit} disabled={commitPending}>
                  {commitPending ? 'Committing…' : 'Commit this plan'}
                </Button>
              </div>
            ) : (
              <div className="space-y-3" role="alert">
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-warning">
                    <TriangleAlert className="size-4" /> Capacity is short
                  </div>
                  {preview.unscheduled.map((work) => (
                    <p key={work.media_id} className="mt-2 text-muted-foreground">
                      {work.display_name}: {formatDuration(work.remaining_raw_ms)} remains.
                    </p>
                  ))}
                </div>
                <div className="space-y-2">
                  {preview.alternatives.map((alternative) => (
                    <Button
                      key={alternative.id}
                      variant="outline"
                      className="w-full justify-between whitespace-normal text-left"
                      disabled={alternativesDisabled}
                      onClick={() => onApplyAlternative(alternative)}
                      rightIcon={<ChevronRight className="size-4" />}
                    >
                      {alternative.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
        {commitMessage ? (
          <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success" role="status">
            <CheckCircle2 className="mr-2 inline size-4" />{commitMessage}{' '}
            <Link to="/" className="font-medium underline">Open Routine</Link>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SceneStrip({ preview }: { preview: PlanPreview }) {
  const shown = preview.days.slice(0, 12);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
        <CalendarClock className="size-3.5" /> Routine strip
      </div>
      <div className="flex min-h-24 items-end gap-2 overflow-hidden rounded-lg bg-secondary p-3" aria-label={`${preview.days.length} scheduled days`}>
        {shown.map((day, index) => (
          <div
            key={day.date}
            className="relative aspect-[9/16] min-w-8 flex-1 overflow-hidden rounded-md border border-vermillion-200 bg-card shadow-sm dark:border-vermillion-900"
            title={`${formatDay(day.date)} · ${formatDuration(day.effective_content_ms)}`}
          >
            <div className="absolute inset-x-0 bottom-0 bg-primary/85" style={{ height: `${Math.max(18, Math.min(100, day.item_count * 22))}%` }} />
            <span className="absolute left-1.5 top-1 text-[9px] font-semibold text-muted-foreground">{index + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NumberField({ id, label, suffix, value, min, max, onChange }: {
  id: string; label: string; suffix: string; value: number; min: number; max: number; onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1.5 text-sm font-medium" htmlFor={id}>
      {label}
      <span className="relative block">
        <input
          id={id}
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))}
          className={cn(inputClass, 'pr-12')}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-normal text-muted-foreground">{suffix}</span>
      </span>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border bg-background p-3"><div className="font-mono text-lg font-semibold">{value}</div><div className="text-xs text-muted-foreground">{label}</div></div>;
}

function LoadingLine({ label }: { label: string }) {
  return <div className="flex items-center gap-2 rounded-md bg-secondary p-3 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin text-primary" />{label}</div>;
}

function InlineError({ message }: { message: string }) {
  return <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert"><TriangleAlert className="mt-0.5 size-4 shrink-0" />{message}</div>;
}

function patchRequest(request: PlanRequest, patch: AlternativePatch): PlanRequest {
  const constraints = { ...request.constraints };
  const selections = request.selections.map((selection) => ({ ...selection }));
  switch (patch.kind) {
    case 'allow_weekdays': constraints.allowed_weekdays = patch.weekdays; break;
    case 'increase_daily_budget': constraints.daily_budget_minutes = patch.minutes; break;
    case 'extend_horizon': constraints.horizon_days = patch.days; break;
    case 'increase_playback_speed': constraints.playback_speed_milli = patch.speed_milli; break;
    case 'move_deadline': {
      const selection = selections.find((item) => item.media_id === patch.media_id);
      if (selection) selection.deadline = patch.date;
      break;
    }
  }
  return { ...request, constraints, selections };
}

function localIsoDate(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

function weekdayName(day: number): string {
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day];
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDay(date: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

const inputClass = 'mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-normal text-foreground shadow-sm outline-none transition-colors focus:border-ring';
