import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import Play from 'lucide-react/dist/esm/icons/play';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import Brain from 'lucide-react/dist/esm/icons/brain';
import Eye from 'lucide-react/dist/esm/icons/eye';
import { useState } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../../components/feedback/EmptyState';
import { PageHeader } from '../../components/layout/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { getRoutine, type RoutinePlan } from '../../ipc/planner';
import { listDueReviews, recordReview, type StudyItem } from '../../ipc/learning';
import { cn } from '../../lib/cn';

export function HomeRoute() {
  const routineQuery = useQuery({
    queryKey: ['planner', 'routine'],
    queryFn: () => getRoutine(30),
  });
  const routine = routineQuery.data;
  const dueReviewsQuery = useQuery({
    queryKey: ['learning', 'due-reviews'],
    queryFn: () => listDueReviews(),
  });
  const today = localIsoDate();
  const focusDay =
    routine?.days.find(
      (day) => day.date >= today && day.items.some((item) => isActionable(item.status)),
    ) ??
    routine?.days.find((day) => day.date >= today) ??
    routine?.days[0];

  return (
    <>
      <PageHeader
        eyebrow="Routine"
        title={routine ? routine.title : 'Today'}
        description={
          routine
            ? `Active immutable version · ${formatDay(routine.horizon_start)} to ${formatDay(routine.horizon_end)}`
            : 'A focused daily queue, built from your real time limits.'
        }
        actions={
          <Link to="/plan" className={secondaryLinkClass}>
            <ListChecks className="size-4" /> {routine ? 'Rebuild plan' : 'Build a plan'}
          </Link>
        }
      />

      <DueReviewQueue
        items={dueReviewsQuery.data ?? []}
        loading={dueReviewsQuery.isLoading}
        failed={dueReviewsQuery.isError}
      />

      {routineQuery.isLoading ? (
        <div className="grid gap-4 md:grid-cols-3" aria-label="Loading routine">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-40 animate-pulse rounded-lg border bg-card" />
          ))}
        </div>
      ) : routineQuery.isError ? (
        <div
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
          role="alert"
        >
          <TriangleAlert className="mt-0.5 size-4" /> Your routine could not be loaded. The
          committed plan is unchanged.
        </div>
      ) : !routine ? (
        <EmptyRoutine />
      ) : (
        <RoutineView routine={routine} focusDate={focusDay?.date} />
      )}
    </>
  );
}

function DueReviewQueue({
  items,
  loading,
  failed,
}: {
  items: StudyItem[];
  loading: boolean;
  failed: boolean;
}) {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [startedAt, setStartedAt] = useState<Record<string, number>>({});
  const review = useMutation({
    mutationFn: ({ item, quality }: { item: StudyItem; quality: number }) =>
      recordReview({
        studyItemId: item.id,
        quality,
        confidence: quality <= 1 ? 2 : quality >= 4 ? 4 : 3,
        responseTimeMs: Math.max(0, Date.now() - (startedAt[item.id] ?? Date.now())),
      }),
    onSuccess: async (_result, variables) => {
      setRevealed((current) => {
        const next = new Set(current);
        next.delete(variables.item.id);
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['learning', 'due-reviews'] });
    },
  });

  return (
    <section className="mb-6" aria-labelledby="due-reviews-heading">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id="due-reviews-heading" className="text-lg font-semibold">
            Due reviews
          </h2>
          <p className="text-sm text-muted-foreground">
            Review timing is calculated locally from your attempts.
          </p>
        </div>
        <Badge tone={items.length ? 'primary' : 'success'}>{items.length} due</Badge>
      </div>
      {loading ? (
        <div
          className="h-28 animate-pulse rounded-lg border bg-card"
          aria-label="Loading due reviews"
        />
      ) : failed ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
          role="alert"
        >
          Due reviews could not be loaded. Your review history is unchanged.
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-24 items-center gap-3 py-5">
            <span className="grid size-10 place-items-center rounded-full bg-success/10 text-success">
              <CheckCircle2 className="size-5" />
            </span>
            <div>
              <p className="font-medium">Review queue complete</p>
              <p className="text-sm text-muted-foreground">
                New items appear here when they become due.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {items.map((item) => {
            const isRevealed = revealed.has(item.id);
            return (
              <Card key={item.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Brain className="size-4 text-primary" /> {formatStudyKind(item.kind)}
                    </CardTitle>
                    <span className="font-mono text-xs text-muted-foreground">
                      {item.evidence[0]
                        ? formatTimestamp(item.evidence[0].start_ms)
                        : 'Evidence linked'}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm font-medium leading-6">{item.prompt}</p>
                  {item.hint ? (
                    <p className="mt-2 text-xs text-muted-foreground">Hint: {item.hint}</p>
                  ) : null}
                  {isRevealed ? (
                    <div className="mt-4 rounded-md border border-primary/20 bg-primary/5 p-3 text-sm leading-6">
                      {item.answer}
                    </div>
                  ) : null}
                  {review.isError && review.variables?.item.id === item.id ? (
                    <p className="mt-3 text-sm text-destructive" role="alert">
                      This review could not be saved. Try again; the due date was not changed.
                    </p>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {!isRevealed ? (
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        onClick={() => {
                          setStartedAt((current) => ({ ...current, [item.id]: Date.now() }));
                          setRevealed((current) => new Set(current).add(item.id));
                        }}
                      >
                        <Eye className="size-4" /> Reveal answer
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={secondaryButtonClass}
                          disabled={review.isPending}
                          onClick={() => review.mutate({ item, quality: 1 })}
                        >
                          Again
                        </button>
                        <button
                          type="button"
                          className={secondaryButtonClass}
                          disabled={review.isPending}
                          onClick={() => review.mutate({ item, quality: 3 })}
                        >
                          Hard
                        </button>
                        <button
                          type="button"
                          className={primaryButtonClass}
                          disabled={review.isPending}
                          onClick={() => review.mutate({ item, quality: 5 })}
                        >
                          Remembered
                        </button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EmptyRoutine() {
  return (
    <EmptyState
      title="No committed routine yet"
      description="Index a library, choose your study media, then commit a feasible plan."
      action={
        <Link to="/plan" className={primaryLinkClass}>
          <ListChecks className="size-4" /> Build your first plan
        </Link>
      }
    />
  );
}

function RoutineView({ routine, focusDate }: { routine: RoutinePlan; focusDate?: string }) {
  const focusDay = routine.days.find((day) => day.date === focusDate);
  const nextItem = focusDay?.items.find((item) => isActionable(item.status));
  return (
    <div className="space-y-6">
      <section
        className="grid gap-4 min-[1320px]:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]"
        aria-label="Next study block"
      >
        <Card className="featured-card relative overflow-hidden">
          <div className="pointer-events-none absolute right-0 top-0 size-48 translate-x-1/3 -translate-y-1/3 rounded-full border-[28px] border-primary/5" />
          <div className="h-1 bg-gradient-to-r from-primary via-vermillion-400 to-amber-300" />
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-primary">
                  Up next
                </p>
                <CardTitle className="mt-2 text-lg">
                  {nextItem?.display_name ?? 'Today is complete'}
                </CardTitle>
              </div>
              <Badge tone={nextItem ? 'primary' : 'success'}>
                {nextItem ? <Clock3 className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                {nextItem ? formatDuration(nextItem.effective_duration_ms) : 'Completed'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {nextItem ? (
              <>
                <p className="font-mono text-xs text-muted-foreground">
                  {formatTimestamp(nextItem.raw_start_ms)}–{formatTimestamp(nextItem.raw_end_ms)} ·
                  raw media timestamps
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Link to={`/player/${nextItem.id}`} className={primaryLinkClass}>
                    <Play className="size-4" /> Start focused study
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    Plays the authorized media privately inside LectorBit.
                  </span>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No unfinished blocks remain on this day.
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-card to-secondary/55">
          <CardHeader>
            <CardTitle>Day load</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <RoutineMetric
              icon={<CalendarDays className="size-4" />}
              label="Study date"
              value={focusDay ? formatDay(focusDay.date) : 'No upcoming day'}
            />
            <RoutineMetric
              icon={<Clock3 className="size-4" />}
              label="Focused study"
              value={formatDuration(focusDay?.effective_content_ms ?? 0)}
            />
            <RoutineMetric
              icon={<ListChecks className="size-4" />}
              label="Study blocks"
              value={String(focusDay?.items.length ?? 0)}
            />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="routine-heading">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 id="routine-heading" className="text-lg font-semibold">
              Plan days
            </h2>
            <p className="text-sm text-muted-foreground">
              Completed history stays attached to this version.
            </p>
          </div>
          <Badge>{routine.days.length} days</Badge>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {routine.days.map((day) => (
            <Card key={day.id} className={cn(day.date === focusDate && 'border-primary/50')}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{formatDay(day.date)}</CardTitle>
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatDuration(day.effective_content_ms)}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {day.items.map((item, index) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 rounded-md border bg-background p-3"
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent font-mono text-xs font-semibold text-accent-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-sm font-medium">{item.display_name}</p>
                        <Status status={item.status} />
                      </div>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {formatTimestamp(item.raw_start_ms)}–{formatTimestamp(item.raw_end_ms)} ·{' '}
                        {formatDuration(item.effective_duration_ms)}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

function isActionable(status: string): boolean {
  return !['done', 'skipped', 'postponed'].includes(status);
}

function RoutineMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-8 place-items-center rounded-md bg-secondary text-primary">
        {icon}
      </span>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}

function Status({ status }: { status: string }) {
  const done = status === 'done';
  const attention = status === 'postponed';
  return (
    <Badge
      tone={
        done ? 'success' : attention ? 'warning' : status === 'in_progress' ? 'primary' : 'neutral'
      }
    >
      {done ? (
        <CheckCircle2 className="size-3" />
      ) : attention ? (
        <TriangleAlert className="size-3" />
      ) : (
        <Clock3 className="size-3" />
      )}
      {status.replace('_', ' ')}
    </Badge>
  );
}

function localIsoDate(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}
function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}
function formatDay(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatStudyKind(kind: StudyItem['kind']): string {
  return kind
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');
}

const primaryLinkClass =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring';
const secondaryLinkClass =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring';
const secondaryButtonClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
