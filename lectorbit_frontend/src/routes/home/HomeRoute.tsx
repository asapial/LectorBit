import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import BookOpen from 'lucide-react/dist/esm/icons/book-open';
import Brain from 'lucide-react/dist/esm/icons/brain';
import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import Eye from 'lucide-react/dist/esm/icons/eye';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import Play from 'lucide-react/dist/esm/icons/play';
import RefreshCcw from 'lucide-react/dist/esm/icons/refresh-ccw';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorPanel } from '../../components/feedback/EmptyState';
import { PageHeader } from '../../components/layout/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { listDueReviews, recordReview, type StudyItem } from '../../ipc/learning';
import { getRoutine, replanActive, type RoutinePlan } from '../../ipc/planner';
import { cn } from '../../lib/cn';

type RoutineDay = RoutinePlan['days'][number];
type RoutineItem = RoutineDay['items'][number];

const LEGACY_MICRO_BLOCK_MS = 2_000;
const REVIEW_SPRINT_SIZE = 12;
const UPCOMING_DAY_PREVIEW = 3;

export function HomeRoute() {
  const routineQuery = useQuery({
    queryKey: ['planner', 'routine'],
    queryFn: () => getRoutine(60),
  });
  const dueReviewsQuery = useQuery({
    queryKey: ['learning', 'due-reviews'],
    queryFn: () => listDueReviews(new Date().toISOString(), REVIEW_SPRINT_SIZE),
  });
  const routine = routineQuery.data;
  const today = localIsoDate();

  return (
    <>
      <PageHeader
        eyebrow="Daily command center"
        title="Today"
        description={
          routine
            ? `${formatLongDay(today)} · Following ${routine.title} · ${formatDay(routine.horizon_start)} to ${formatDay(routine.horizon_end)}`
            : `${formatLongDay(today)} · Turn available time into one clear next step.`
        }
        actions={
          <Link to="/plan" className={secondaryLinkClass}>
            <ListChecks aria-hidden="true" className="size-4" />
            {routine ? 'Adjust plan' : 'Build a plan'}
          </Link>
        }
      />

      {routineQuery.isLoading ? (
        <FocusSkeleton />
      ) : routineQuery.isError ? (
        <ErrorPanel
          title="Your routine could not be loaded"
          error="The committed plan is unchanged."
          onRetry={() => void routineQuery.refetch()}
        />
      ) : routine ? (
        <RoutineView
          routine={routine}
          today={today}
          dueReviewCount={dueReviewsQuery.data?.length ?? 0}
        />
      ) : (
        <EmptyRoutine />
      )}

      <DueReviewSprint
        items={dueReviewsQuery.data ?? []}
        loading={dueReviewsQuery.isLoading}
        error={dueReviewsQuery.error}
        onRetry={() => void dueReviewsQuery.refetch()}
        routine={routine}
      />
    </>
  );
}

function RoutineView({
  routine,
  today,
  dueReviewCount,
}: {
  routine: RoutinePlan;
  today: string;
  dueReviewCount: number;
}) {
  const queryClient = useQueryClient();
  const [showAllDays, setShowAllDays] = useState(false);
  const focus = selectDailyFocus(routine, today);
  const relevantDays = routine.days.filter((day) => day.date >= today);
  const visibleDays = showAllDays ? relevantDays : relevantDays.slice(0, UPCOMING_DAY_PREVIEW);
  const legacyBlocks = routine.days.flatMap((day) => day.items).filter(isLegacyMicroBlock);
  const repair = useMutation({
    mutationFn: () => replanActive(today),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
    },
  });
  const snapshotDay = focus.day ?? routine.days.find((day) => day.date === today);

  return (
    <div className="space-y-7">
      <section
        className="grid gap-4 min-[1180px]:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.55fr)]"
        aria-labelledby="daily-focus-heading"
      >
        <Card className="featured-card relative overflow-hidden border-primary/20">
          <div className="pointer-events-none absolute -right-16 -top-16 size-52 rounded-full border-[34px] border-primary/5" />
          <div className="h-1 bg-gradient-to-r from-primary via-vermillion-400 to-amber-300" />
          <CardHeader className="relative">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                  Daily focus
                </p>
                <CardTitle id="daily-focus-heading" className="mt-2 text-xl sm:text-2xl">
                  {focus.item?.display_name ?? focus.title}
                </CardTitle>
              </div>
              <FocusBadge focus={focus} />
            </div>
          </CardHeader>
          <CardContent className="relative">
            {focus.item && focus.day ? (
              <>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  {focus.description}
                </p>
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-muted-foreground">
                  <span>{formatDay(focus.day.date)}</span>
                  <span>
                    {formatTimestamp(focus.item.raw_start_ms)}–
                    {formatTimestamp(focus.item.raw_end_ms)}
                  </span>
                  <span>{formatDuration(focus.item.effective_duration_ms)} focus</span>
                </div>
                <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Link
                    to={`/player/${focus.item.id}`}
                    className={cn(primaryLinkClass, 'w-full sm:w-auto')}
                  >
                    <Play aria-hidden="true" className="size-4" /> {focus.actionLabel}
                  </Link>
                  <span className="text-xs leading-5 text-muted-foreground">
                    Progress is checkpointed privately on this device.
                  </span>
                </div>
              </>
            ) : (
              <div className="max-w-2xl">
                <p className="text-sm leading-6 text-muted-foreground">{focus.description}</p>
                {focus.needsAttention ? (
                  <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                    <Button
                      className="w-full sm:w-auto"
                      disabled={repair.isPending}
                      leftIcon={
                        <RefreshCcw className={cn('size-4', repair.isPending && 'animate-spin')} />
                      }
                      onClick={() => repair.mutate()}
                    >
                      {repair.isPending ? 'Repairing schedule…' : 'Repair remaining schedule'}
                    </Button>
                    <Link to="/plan" className={cn(secondaryLinkClass, 'w-full sm:w-auto')}>
                      Review plan settings
                    </Link>
                  </div>
                ) : null}
              </div>
            )}

            {legacyBlocks.length > 0 && focus.item ? (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/25 bg-warning/10 p-3 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <TriangleAlert aria-hidden="true" className="size-4 text-warning" />
                  {legacyBlocks.length} obsolete micro-
                  {legacyBlocks.length === 1 ? 'block was' : 'blocks were'} hidden.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={repair.isPending}
                  onClick={() => repair.mutate()}
                >
                  {repair.isPending ? 'Repairing…' : 'Repair schedule'}
                </Button>
              </div>
            ) : null}
            {repair.isError ? (
              <p className="mt-3 text-sm text-destructive" role="alert">
                The schedule could not be repaired. Your existing plan is unchanged.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <DaySnapshot day={snapshotDay} dueReviewCount={dueReviewCount} />
      </section>

      <section aria-labelledby="upcoming-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="upcoming-heading" className="font-display text-lg font-semibold">
              Today and upcoming
            </h2>
            <p className="text-sm text-muted-foreground">
              A compact look ahead; completed history stays on this plan version.
            </p>
          </div>
          <Badge>{relevantDays.length} scheduled days</Badge>
        </div>

        {visibleDays.length ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {visibleDays.map((day) => (
              <DayCard key={day.id} day={day} focused={day.id === focus.day?.id} />
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex items-center gap-3 py-5">
              <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
              <p className="text-sm text-muted-foreground">
                No upcoming days are loaded in this plan version.
              </p>
            </CardContent>
          </Card>
        )}

        {relevantDays.length > UPCOMING_DAY_PREVIEW ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              aria-expanded={showAllDays}
              onClick={() => setShowAllDays((current) => !current)}
            >
              {showAllDays ? 'Show less' : `Show all ${relevantDays.length} days`}
              <ChevronDown
                aria-hidden="true"
                className={cn('size-4 transition-transform', showAllDays && 'rotate-180')}
              />
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DaySnapshot({ day, dueReviewCount }: { day?: RoutineDay; dueReviewCount: number }) {
  const handled = day?.items.filter((item) => !isActionable(item.status)).length ?? 0;
  const total = day?.items.length ?? 0;
  const remainingMs =
    day?.items
      .filter((item) => isActionable(item.status) && !isLegacyMicroBlock(item))
      .reduce((sum, item) => sum + item.effective_duration_ms, 0) ?? 0;
  const percent = total ? Math.round((handled / total) * 100) : 100;

  return (
    <Card className="bg-gradient-to-br from-card to-secondary/55">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Study snapshot</CardTitle>
          <span className="font-mono text-xs text-muted-foreground">
            {day ? formatDay(day.date) : 'No active day'}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Blocks handled</span>
            <span className="font-mono font-medium text-foreground">
              {handled}/{total}
            </span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            aria-label="Daily blocks handled"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${handled} of ${total} blocks handled`}
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <SnapshotMetric
          icon={<Clock3 className="size-4" />}
          label="Focused time left"
          value={formatDuration(remainingMs)}
        />
        <SnapshotMetric
          icon={<CalendarDays className="size-4" />}
          label="Planned breaks"
          value={formatDuration(day?.break_ms ?? 0)}
        />
        <SnapshotMetric
          icon={<Brain className="size-4" />}
          label="Review sprint"
          value={dueReviewCount ? `${dueReviewCount} ready` : 'Clear'}
        />
      </CardContent>
    </Card>
  );
}

function DayCard({ day, focused }: { day: RoutineDay; focused: boolean }) {
  const handled = day.items.filter((item) => !isActionable(item.status)).length;
  return (
    <Card className={cn(focused && 'border-primary/45 ring-1 ring-primary/10')}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{formatDay(day.date)}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {handled}/{day.items.length} handled
            </p>
          </div>
          <Badge tone={handled === day.items.length ? 'success' : focused ? 'primary' : 'neutral'}>
            {formatDuration(day.effective_content_ms)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {day.items.map((item, index) => {
          const playable = isActionable(item.status) && !isLegacyMicroBlock(item);
          return (
            <div
              key={item.id}
              className="flex items-start gap-3 rounded-xl border bg-background p-3"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent font-mono text-xs font-semibold text-accent-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  {playable ? (
                    <Link
                      to={`/player/${item.id}`}
                      className="text-sm font-medium leading-5 hover:text-primary hover:underline"
                    >
                      {item.display_name}
                    </Link>
                  ) : (
                    <p className="text-sm font-medium leading-5">{item.display_name}</p>
                  )}
                  <Status status={item.status} micro={isLegacyMicroBlock(item)} />
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {formatTimestamp(item.raw_start_ms)}–{formatTimestamp(item.raw_end_ms)} ·{' '}
                  {formatPreciseDuration(item.effective_duration_ms)}
                </p>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function DueReviewSprint({
  items,
  loading,
  error,
  onRetry,
  routine,
}: {
  items: StudyItem[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  routine?: RoutinePlan | null;
}) {
  const queryClient = useQueryClient();
  const active = items[0];
  const [revealed, setRevealed] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const review = useMutation({
    mutationFn: ({ item, quality }: { item: StudyItem; quality: number }) =>
      recordReview({
        studyItemId: item.id,
        quality,
        confidence: quality <= 1 ? 2 : quality >= 4 ? 4 : 3,
        responseTimeMs: Math.max(0, Date.now() - startedAt),
        answerText: answerText.trim() || undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['learning', 'due-reviews'] });
    },
  });

  useEffect(() => {
    setRevealed(false);
    setAnswerText('');
    setStartedAt(Date.now());
  }, [active?.id]);

  const evidenceLink = active ? findEvidenceLink(active, routine) : undefined;
  const answerId = active ? `review-answer-${active.id}` : undefined;

  return (
    <section className="mt-8" aria-labelledby="review-sprint-heading">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id="review-sprint-heading" className="font-display text-lg font-semibold">
            Review sprint
          </h2>
          <p className="text-sm text-muted-foreground">
            One retrieval prompt at a time, scheduled locally from your attempts.
          </p>
        </div>
        <Badge tone={loading ? 'neutral' : error ? 'danger' : items.length ? 'primary' : 'success'}>
          {loading
            ? 'Loading'
            : error
              ? 'Unavailable'
              : items.length
                ? `${items.length} in sprint`
                : 'Queue clear'}
        </Badge>
      </div>

      {loading ? (
        <div
          className="h-56 animate-pulse rounded-2xl border bg-card motion-reduce:animate-none"
          aria-busy="true"
          aria-label="Loading review sprint"
        />
      ) : error ? (
        <ErrorPanel title="Due reviews could not be loaded" error={error} onRetry={onRetry} />
      ) : !active ? (
        <Card>
          <CardContent className="flex min-h-28 items-center gap-3 py-5">
            <span className="grid size-10 place-items-center rounded-full bg-success/10 text-success">
              <CheckCircle2 aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="font-medium">Review queue complete</p>
              <p className="text-sm text-muted-foreground">
                New prompts appear here when they become due.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card aria-busy={review.isPending}>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Brain aria-hidden="true" className="size-4 text-primary" />
                {formatStudyKind(active.kind)}
              </CardTitle>
              <span className="font-mono text-xs text-muted-foreground">
                Prompt 1 of {items.length}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-base font-medium leading-7">{active.prompt}</p>
            {active.hint ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">Hint: {active.hint}</p>
            ) : null}

            {active.kind === 'multiple_choice' && active.options.length ? (
              <fieldset className="mt-4 space-y-2">
                <legend className="sr-only">Choose an answer</legend>
                {active.options.map((option) => (
                  <label
                    key={option}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors',
                      answerText === option && 'border-primary/50 bg-primary/5',
                    )}
                  >
                    <input
                      type="radio"
                      name={`review-${active.id}`}
                      value={option}
                      checked={answerText === option}
                      onChange={(event) => setAnswerText(event.target.value)}
                      className="accent-primary"
                    />
                    {option}
                  </label>
                ))}
              </fieldset>
            ) : (
              <label className="mt-4 block text-xs font-medium text-muted-foreground">
                Your recall (optional)
                <textarea
                  value={answerText}
                  onChange={(event) => setAnswerText(event.target.value)}
                  rows={2}
                  className="mt-2 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="Write what you remember before revealing the answer…"
                />
              </label>
            )}

            {revealed ? (
              <div
                id={answerId}
                className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6"
              >
                {active.answer}
              </div>
            ) : null}
            {review.isError ? (
              <p className="mt-3 text-sm text-destructive" role="alert">
                This review could not be saved. Your due date was not changed; try again.
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              {!revealed ? (
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  leftIcon={<Eye className="size-4" />}
                  aria-expanded={false}
                  aria-controls={answerId}
                  onClick={() => setRevealed(true)}
                >
                  Reveal answer
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    disabled={review.isPending}
                    onClick={() => review.mutate({ item: active, quality: 1 })}
                  >
                    Again
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    disabled={review.isPending}
                    onClick={() => review.mutate({ item: active, quality: 3 })}
                  >
                    Hard
                  </Button>
                  <Button
                    className="w-full sm:w-auto"
                    disabled={review.isPending}
                    onClick={() => review.mutate({ item: active, quality: 5 })}
                  >
                    Remembered
                  </Button>
                </>
              )}
              {evidenceLink ? (
                <Link
                  to={evidenceLink.href}
                  className="inline-flex min-h-11 items-center justify-center gap-2 text-sm font-medium text-primary hover:underline sm:ml-auto"
                >
                  <Play aria-hidden="true" className="size-4" /> Replay evidence at{' '}
                  {formatTimestamp(evidenceLink.atMs)}
                </Link>
              ) : null}
            </div>
            <p className="sr-only" aria-live="polite">
              {review.isPending ? 'Saving review' : review.isSuccess ? 'Review saved' : ''}
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function EmptyRoutine() {
  return (
    <EmptyState
      title="No committed routine yet"
      description="Add lectures to your private library, then commit a feasible routine for the time you actually have."
      action={
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link to="/library" className={secondaryLinkClass}>
            <BookOpen aria-hidden="true" className="size-4" /> Add lectures
          </Link>
          <Link to="/plan" className={primaryLinkClass}>
            <ListChecks aria-hidden="true" className="size-4" /> Build your first plan
          </Link>
        </div>
      }
    />
  );
}

type DailyFocus = {
  item?: RoutineItem;
  day?: RoutineDay;
  title: string;
  description: string;
  actionLabel: string;
  tone: 'primary' | 'success' | 'warning';
  badge: string;
  needsAttention: boolean;
};

function selectDailyFocus(routine: RoutinePlan, today: string): DailyFocus {
  const todayDay = routine.days.find((day) => day.date === today);
  const todayItem = pickItem(todayDay?.items ?? []);
  if (todayItem && todayDay) {
    return {
      item: todayItem,
      day: todayDay,
      title: todayItem.display_name,
      description:
        todayItem.status === 'in_progress'
          ? 'Continue where you left off; verified watching and your playhead remain separate.'
          : 'This is the clearest next block in today’s committed routine.',
      actionLabel: todayItem.status === 'in_progress' ? 'Continue block' : 'Start focused study',
      tone: 'primary',
      badge: todayItem.status === 'in_progress' ? 'In progress' : 'Up next',
      needsAttention: false,
    };
  }

  const futureDay = routine.days.find(
    (day) => day.date > today && day.items.some(isMeaningfulActionable),
  );
  const futureItem = pickItem(futureDay?.items ?? []);
  if (futureDay && futureItem) {
    return {
      item: futureItem,
      day: futureDay,
      title: futureItem.display_name,
      description: todayDay
        ? 'Today’s scheduled work is handled. Here is the next block without pulling future work into today.'
        : 'Nothing is scheduled for today. This is your next committed study block.',
      actionLabel: 'Open next scheduled block',
      tone: todayDay ? 'success' : 'primary',
      badge: todayDay ? 'Today complete' : 'Next scheduled',
      needsAttention: false,
    };
  }

  const actionable = routine.days
    .flatMap((day) => day.items)
    .filter((item) => isActionable(item.status));
  const hasLegacyOnly = actionable.length > 0 && actionable.every(isLegacyMicroBlock);
  const hasPastWork = routine.days.some(
    (day) => day.date < today && day.items.some(isMeaningfulActionable),
  );
  if (hasLegacyOnly || hasPastWork || routine.horizon_end >= today) {
    return {
      title: 'Schedule needs attention',
      description: hasLegacyOnly
        ? 'The remaining work is made of obsolete timing seams from an older replan. Repairing creates a clean active version without rewriting study history.'
        : hasPastWork
          ? 'Unfinished work is only scheduled in the past. Repair the remaining schedule instead of silently opening an overdue block.'
          : 'No actionable future block is loaded even though this plan horizon is still active.',
      actionLabel: '',
      tone: 'warning',
      badge: 'Action needed',
      needsAttention: true,
    };
  }

  return {
    title: 'Routine complete',
    description:
      'Every block in this committed version has been handled. Build the next plan when you are ready.',
    actionLabel: '',
    tone: 'success',
    badge: 'Complete',
    needsAttention: false,
  };
}

function FocusBadge({ focus }: { focus: DailyFocus }) {
  return (
    <Badge tone={focus.tone}>
      {focus.tone === 'success' ? (
        <CheckCircle2 aria-hidden="true" className="size-3.5" />
      ) : focus.tone === 'warning' ? (
        <TriangleAlert aria-hidden="true" className="size-3.5" />
      ) : (
        <Clock3 aria-hidden="true" className="size-3.5" />
      )}
      {focus.badge}
    </Badge>
  );
}

function FocusSkeleton() {
  return (
    <div
      className="grid gap-4 min-[1180px]:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.55fr)]"
      aria-busy="true"
      aria-label="Loading daily focus"
    >
      <div className="h-72 animate-pulse rounded-2xl border bg-card motion-reduce:animate-none" />
      <div className="h-72 animate-pulse rounded-2xl border bg-card motion-reduce:animate-none" />
    </div>
  );
}

function SnapshotMetric({
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
      <span
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-xl bg-secondary text-primary"
      >
        {icon}
      </span>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}

function Status({ status, micro }: { status: string; micro: boolean }) {
  if (micro && isActionable(status)) return <Badge tone="warning">Repair</Badge>;
  const done = status === 'done';
  const attention = status === 'postponed';
  return (
    <Badge
      tone={
        done ? 'success' : attention ? 'warning' : status === 'in_progress' ? 'primary' : 'neutral'
      }
    >
      {done ? (
        <CheckCircle2 aria-hidden="true" className="size-3" />
      ) : attention ? (
        <TriangleAlert aria-hidden="true" className="size-3" />
      ) : (
        <Clock3 aria-hidden="true" className="size-3" />
      )}
      {status.replace('_', ' ')}
    </Badge>
  );
}

function pickItem(items: RoutineItem[]): RoutineItem | undefined {
  return (
    items.find((item) => item.status === 'in_progress' && !isLegacyMicroBlock(item)) ??
    items.find(isMeaningfulActionable)
  );
}
function isMeaningfulActionable(item: RoutineItem): boolean {
  return isActionable(item.status) && !isLegacyMicroBlock(item);
}
function isLegacyMicroBlock(item: RoutineItem): boolean {
  return item.raw_end_ms - item.raw_start_ms <= LEGACY_MICRO_BLOCK_MS;
}
function isActionable(status: string): boolean {
  return !['done', 'skipped', 'postponed'].includes(status);
}

function findEvidenceLink(item: StudyItem, routine?: RoutinePlan | null) {
  const evidence = item.evidence[0];
  if (!evidence || !routine) return undefined;
  const routineItem = routine.days
    .flatMap((day) => day.items)
    .find(
      (candidate) =>
        candidate.media_id === item.media_id &&
        evidence.start_ms >= candidate.raw_start_ms &&
        evidence.start_ms <= candidate.raw_end_ms &&
        !isLegacyMicroBlock(candidate),
    );
  return routineItem
    ? { href: `/player/${routineItem.id}?t=${evidence.start_ms}`, atMs: evidence.start_ms }
    : undefined;
}

function localIsoDate(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}
function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function formatPreciseDuration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${Math.max(1, Math.ceil(milliseconds / 1_000))}s`
    : formatDuration(milliseconds);
}
function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
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
function formatLongDay(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
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
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-primary/10 bg-gradient-to-br from-vermillion-500 to-vermillion-700 px-5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:from-vermillion-400 hover:to-vermillion-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const secondaryLinkClass =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border bg-background px-4 text-sm font-semibold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
