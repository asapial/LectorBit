import { useQuery } from '@tanstack/react-query';
import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import Play from 'lucide-react/dist/esm/icons/play';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { Link } from 'react-router';
import { EmptyState } from '../../components/feedback/EmptyState';
import { PageHeader } from '../../components/layout/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { getRoutine, type RoutinePlan } from '../../ipc/planner';
import { cn } from '../../lib/cn';

export function HomeRoute() {
  const routineQuery = useQuery({
    queryKey: ['planner', 'routine'],
    queryFn: () => getRoutine(30),
  });
  const routine = routineQuery.data;
  const today = localIsoDate();
  const focusDay = routine?.days.find((day) => day.date >= today) ?? routine?.days[0];

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

      {routineQuery.isLoading ? (
        <div className="grid gap-4 md:grid-cols-3" aria-label="Loading routine">
          {[0, 1, 2].map((item) => <div key={item} className="h-40 animate-pulse rounded-lg border bg-card" />)}
        </div>
      ) : routineQuery.isError ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          <TriangleAlert className="mt-0.5 size-4" /> Your routine could not be loaded. The committed plan is unchanged.
        </div>
      ) : !routine ? (
        <EmptyRoutine />
      ) : (
        <RoutineView routine={routine} focusDate={focusDay?.date} />
      )}
    </>
  );
}

function EmptyRoutine() {
  return (
    <EmptyState
      title="No committed routine yet"
      description="Index a library, choose your study media, then commit a feasible plan."
      action={<Link to="/plan" className={primaryLinkClass}><ListChecks className="size-4" /> Build your first plan</Link>}
    />
  );
}

function RoutineView({ routine, focusDate }: { routine: RoutinePlan; focusDate?: string }) {
  const focusDay = routine.days.find((day) => day.date === focusDate);
  const nextItem = focusDay?.items.find((item) => item.status !== 'done');
  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]" aria-label="Next study block">
        <Card className="overflow-hidden">
          <div className="h-1 bg-primary" />
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-primary">Up next</p>
                <CardTitle className="mt-2 text-lg">{nextItem?.display_name ?? 'Today is complete'}</CardTitle>
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
                  {formatTimestamp(nextItem.raw_start_ms)} – {formatTimestamp(nextItem.raw_end_ms)} · raw media timestamps
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button type="button" disabled className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground opacity-60">
                    <Play className="size-4" /> Playback wiring next
                  </button>
                  <span className="text-xs text-muted-foreground">The queue is ready; playback arrives in Feature 8.</span>
                </div>
              </>
            ) : <p className="text-sm text-muted-foreground">No unfinished blocks remain on this day.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Day load</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <RoutineMetric icon={<CalendarDays className="size-4" />} label="Study date" value={focusDay ? formatDay(focusDay.date) : 'No upcoming day'} />
            <RoutineMetric icon={<Clock3 className="size-4" />} label="Focused study" value={formatDuration(focusDay?.effective_content_ms ?? 0)} />
            <RoutineMetric icon={<ListChecks className="size-4" />} label="Study blocks" value={String(focusDay?.items.length ?? 0)} />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="routine-heading">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h2 id="routine-heading" className="text-lg font-semibold">Plan days</h2><p className="text-sm text-muted-foreground">Completed history stays attached to this version.</p></div>
          <Badge>{routine.days.length} days</Badge>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {routine.days.map((day) => (
            <Card key={day.id} className={cn(day.date === focusDate && 'border-primary/50')}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{formatDay(day.date)}</CardTitle>
                  <span className="font-mono text-xs text-muted-foreground">{formatDuration(day.effective_content_ms)}</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {day.items.map((item, index) => (
                  <div key={item.id} className="flex items-start gap-3 rounded-md border bg-background p-3">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent font-mono text-xs font-semibold text-accent-foreground">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-sm font-medium">{item.display_name}</p>
                        <Status status={item.status} />
                      </div>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">{formatTimestamp(item.raw_start_ms)}–{formatTimestamp(item.raw_end_ms)} · {formatDuration(item.effective_duration_ms)}</p>
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

function RoutineMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-md bg-secondary text-primary">{icon}</span><div><p className="text-xs text-muted-foreground">{label}</p><p className="text-sm font-medium">{value}</p></div></div>;
}

function Status({ status }: { status: string }) {
  const done = status === 'done';
  return <Badge tone={done ? 'success' : status === 'in_progress' ? 'primary' : 'neutral'}>{done ? <CheckCircle2 className="size-3" /> : <Clock3 className="size-3" />}{status.replace('_', ' ')}</Badge>;
}

function localIsoDate(): string { const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset()); return now.toISOString().slice(0, 10); }
function formatDuration(milliseconds: number): string { const minutes = Math.max(0, Math.round(milliseconds / 60_000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
function formatTimestamp(milliseconds: number): string { const seconds = Math.floor(milliseconds / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const remainder = seconds % 60; return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':'); }
function formatDay(date: string): string { return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)); }

const primaryLinkClass = 'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring';
const secondaryLinkClass = 'inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring';
