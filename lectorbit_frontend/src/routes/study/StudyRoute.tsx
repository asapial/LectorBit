import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import Brain from 'lucide-react/dist/esm/icons/brain';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Eye from 'lucide-react/dist/esm/icons/eye';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import Play from 'lucide-react/dist/esm/icons/play';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Search from 'lucide-react/dist/esm/icons/search';
import { Link } from 'react-router';
import { EmptyState, ErrorPanel } from '../../components/feedback/EmptyState';
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
  listStudyLibrary,
  recordReview,
  updateStudyItem,
  type StudyItem,
} from '../../ipc/learning';
import { getRoutine, type RoutinePlan } from '../../ipc/planner';
import { cn } from '../../lib/cn';

type Filter = 'all' | 'due' | 'difficult' | 'archived';

export function StudyRoute() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [activeReviewId, setActiveReviewId] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [editing, setEditing] = useState<StudyItem>();

  const library = useQuery({
    queryKey: ['learning', 'study-library', true] as const,
    queryFn: () => listStudyLibrary(true, 1000),
    retry: false,
  });
  const routine = useQuery({
    queryKey: ['planner', 'routine', 'study-hub'] as const,
    queryFn: () => getRoutine(366),
    retry: false,
  });
  const update = useMutation({
    mutationFn: (input: Parameters<typeof updateStudyItem>[0]) => updateStudyItem(input),
    onSuccess: async () => {
      setEditing(undefined);
      await queryClient.invalidateQueries({ queryKey: ['learning'] });
    },
  });
  const review = useMutation({
    mutationFn: ({ item, quality }: { item: StudyItem; quality: number }) =>
      recordReview({
        studyItemId: item.id,
        quality,
        confidence: quality <= 1 ? 2 : quality >= 4 ? 4 : 3,
        responseTimeMs: Math.max(0, Date.now() - startedAt),
      }),
    onSuccess: async () => {
      setRevealed(false);
      setActiveReviewId(undefined);
      setStartedAt(Date.now());
      await queryClient.invalidateQueries({ queryKey: ['learning'] });
    },
  });

  const items = library.data ?? [];
  const now = Date.now();
  const counts = {
    active: items.filter((item) => !item.archived).length,
    due: items.filter((item) => !item.archived && Date.parse(item.due_at) <= now).length,
    difficult: items.filter((item) => !item.archived && (item.last_quality ?? 5) < 3).length,
    mastered: items.filter(
      (item) => !item.archived && item.repetitions >= 3 && (item.last_quality ?? 0) >= 4,
    ).length,
  };
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (filter === 'all' && item.archived) return false;
      if (filter === 'due' && (item.archived || Date.parse(item.due_at) > now)) return false;
      if (filter === 'difficult' && (item.archived || (item.last_quality ?? 5) >= 3)) return false;
      if (filter === 'archived' && !item.archived) return false;
      return (
        !term ||
        `${item.prompt} ${item.answer} ${item.hint ?? ''}`.toLocaleLowerCase().includes(term)
      );
    });
  }, [filter, items, now, search]);
  const activeReview = items.find((item) => item.id === activeReviewId);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Learning library"
        title="Study Hub"
        description="Review, correct, and organize every evidence-linked learning item across your library."
        actions={
          <Badge tone={counts.due ? 'warning' : 'success'}>
            {counts.due ? `${counts.due} due now` : 'Review queue clear'}
          </Badge>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Study progress">
        <Metric
          label="Active material"
          value={counts.active}
          detail="Available across your library"
        />
        <Metric
          label="Due now"
          value={counts.due}
          detail="Scheduled locally"
          tone={counts.due ? 'warning' : 'success'}
        />
        <Metric
          label="Needs practice"
          value={counts.difficult}
          detail="Last recall score below 3"
          tone={counts.difficult ? 'warning' : 'neutral'}
        />
        <Metric
          label="Strong recall"
          value={counts.mastered}
          detail="3+ successful repetitions"
          tone="success"
        />
      </section>

      {activeReview ? (
        <ReviewCard
          item={activeReview}
          revealed={revealed}
          pending={review.isPending}
          routine={routine.data}
          onReveal={() => setRevealed(true)}
          onRate={(quality) => review.mutate({ item: activeReview, quality })}
          onClose={() => {
            setActiveReviewId(undefined);
            setRevealed(false);
          }}
        />
      ) : null}

      <Card>
        <CardHeader className="border-b border-border/70">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <CardTitle>Learning material</CardTitle>
              <CardDescription className="mt-1">
                Generated items remain editable; your corrections always take precedence.
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="relative min-w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  aria-label="Search study material"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search prompts and answers"
                  className="form-control pl-9"
                />
              </label>
              <div
                className="flex flex-wrap gap-1 rounded-lg border bg-muted/25 p-1"
                aria-label="Study material filters"
              >
                {(['all', 'due', 'difficult', 'archived'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={cn(
                      'rounded-md px-3 py-2 text-xs font-semibold capitalize',
                      filter === value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground',
                    )}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          {library.isPending ? (
            <div className="h-64 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
          ) : null}
          {library.isError ? (
            <ErrorPanel
              title="Study library could not be loaded"
              error={library.error}
              onRetry={() => void library.refetch()}
            />
          ) : null}
          {!library.isPending && !library.isError && visible.length === 0 ? (
            <EmptyState
              title={items.length ? 'No material matches this view' : 'No study material yet'}
              description={
                items.length
                  ? 'Change the filter or search terms.'
                  : 'Generate a grounded study set from a transcribed lecture in the Player.'
              }
            />
          ) : null}
          <div className="grid gap-3 xl:grid-cols-2">
            {visible.map((item) => (
              <StudyItemCard
                key={item.id}
                item={item}
                routine={routine.data}
                pending={update.isPending}
                onReview={() => {
                  setActiveReviewId(item.id);
                  setRevealed(false);
                  setStartedAt(Date.now());
                }}
                onEdit={() => setEditing(item)}
                onArchive={() =>
                  update.mutate({
                    studyItemId: item.id,
                    prompt: item.prompt,
                    answer: item.answer,
                    hint: item.hint ?? undefined,
                    archived: !item.archived,
                  })
                }
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {editing ? (
        <EditDialog
          item={editing}
          pending={update.isPending}
          error={update.error}
          onCancel={() => setEditing(undefined)}
          onSave={(values) =>
            update.mutate({ studyItemId: editing.id, archived: editing.archived, ...values })
          }
        />
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  detail: string;
  tone?: 'neutral' | 'success' | 'warning';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            'mt-2 font-display text-3xl font-semibold',
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
          )}
        >
          {value.toLocaleString()}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function StudyItemCard({
  item,
  routine,
  pending,
  onReview,
  onEdit,
  onArchive,
}: {
  item: StudyItem;
  routine?: RoutinePlan | null;
  pending: boolean;
  onReview: () => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const target = evidenceTarget(item, routine);
  return (
    <article className={cn('rounded-xl border bg-background p-4', item.archived && 'opacity-70')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Badge
            tone={
              item.archived
                ? 'neutral'
                : Date.parse(item.due_at) <= Date.now()
                  ? 'warning'
                  : 'primary'
            }
          >
            {item.archived ? 'Archived' : kindLabel(item.kind)}
          </Badge>
          {item.user_edited ? (
            <Badge tone="success">
              <Pencil className="size-3" /> Corrected
            </Badge>
          ) : null}
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {item.repetitions} reviews · {Math.round(item.ease_milli / 10)}% ease
        </span>
      </div>
      <h2 className="mt-3 text-sm font-semibold leading-6">{item.prompt}</h2>
      {item.hint ? <p className="mt-1 text-xs text-muted-foreground">Hint: {item.hint}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {!item.archived ? (
          <Button size="sm" onClick={onReview}>
            <Brain className="size-3.5" /> Review
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil className="size-3.5" /> Edit
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onArchive}>
          {item.archived ? <RotateCcw className="size-3.5" /> : <Archive className="size-3.5" />}
          {item.archived ? 'Restore' : 'Archive'}
        </Button>
        {target ? (
          <Link
            className="inline-flex h-9 items-center gap-1.5 px-2 text-xs font-semibold text-primary hover:underline"
            to={target}
          >
            <Play className="size-3.5" /> Evidence
          </Link>
        ) : null}
      </div>
    </article>
  );
}

function ReviewCard({
  item,
  revealed,
  pending,
  routine,
  onReveal,
  onRate,
  onClose,
}: {
  item: StudyItem;
  revealed: boolean;
  pending: boolean;
  routine?: RoutinePlan | null;
  onReveal: () => void;
  onRate: (quality: number) => void;
  onClose: () => void;
}) {
  const target = evidenceTarget(item, routine);
  return (
    <Card className="featured-card border-primary/25">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <Badge tone="primary">Active recall</Badge>
            <CardTitle className="mt-3">{item.prompt}</CardTitle>
            {item.hint ? (
              <CardDescription className="mt-2">Hint: {item.hint}</CardDescription>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {revealed ? (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
            {item.answer}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {!revealed ? (
            <Button variant="outline" onClick={onReveal}>
              <Eye className="size-4" /> Reveal answer
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={() => onRate(1)}>
                Again
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => onRate(3)}>
                Hard
              </Button>
              <Button disabled={pending} onClick={() => onRate(5)}>
                <CheckCircle2 className="size-4" /> Remembered
              </Button>
            </>
          )}
          {target ? (
            <Link
              className="inline-flex h-10 items-center gap-2 px-3 text-sm font-semibold text-primary hover:underline"
              to={target}
            >
              <Play className="size-4" /> Replay evidence
            </Link>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function EditDialog({
  item,
  pending,
  error,
  onCancel,
  onSave,
}: {
  item: StudyItem;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSave: (values: { prompt: string; answer: string; hint?: string }) => void;
}) {
  const [prompt, setPrompt] = useState(item.prompt);
  const [answer, setAnswer] = useState(item.answer);
  const [hint, setHint] = useState(item.hint ?? '');
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-study-title"
        className="w-full max-w-2xl rounded-2xl border bg-card p-5 shadow-2xl"
      >
        <h2 id="edit-study-title" className="font-display text-lg font-semibold">
          Correct study material
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your version is retained when this item is reviewed.
        </p>
        <label className="mt-4 block text-sm font-medium">
          Prompt
          <textarea
            className="form-control mt-2 min-h-24"
            maxLength={4000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          Answer
          <textarea
            className="form-control mt-2 min-h-36"
            maxLength={12000}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          Hint
          <input
            className="form-control mt-2"
            value={hint}
            onChange={(event) => setHint(event.target.value)}
          />
        </label>
        {error ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            The correction could not be saved.
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={pending || !prompt.trim() || !answer.trim()}
            onClick={() => onSave({ prompt, answer, hint: hint.trim() || undefined })}
          >
            {pending ? 'Saving…' : 'Save correction'}
          </Button>
        </div>
      </section>
    </div>
  );
}

function evidenceTarget(item: StudyItem, routine?: RoutinePlan | null) {
  const block = routine?.days
    .flatMap((day) => day.items)
    .find((candidate) => candidate.media_id === item.media_id);
  const at = item.evidence[0]?.start_ms ?? item.chapter_start_ms;
  return block
    ? `/player/${encodeURIComponent(block.id)}${at == null ? '' : `?t=${at}`}`
    : undefined;
}

function kindLabel(kind: StudyItem['kind']) {
  return (
    {
      flashcard: 'Flashcard',
      multiple_choice: 'Multiple choice',
      short_answer: 'Short answer',
      explain_own_words: 'Explain it',
    } as const
  )[kind];
}
