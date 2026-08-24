import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CalendarClock from 'lucide-react/dist/esm/icons/calendar-clock';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle';
import Search from 'lucide-react/dist/esm/icons/search';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import Brain from 'lucide-react/dist/esm/icons/brain';
import History from 'lucide-react/dist/esm/icons/history';
import { Link, useSearchParams } from 'react-router';
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
  getCloudPlanningStatus,
  listPlanHistory,
  listPlanningCandidates,
  parsePlanIntent,
  previewPlan,
  suggestPlanWithAi,
  type AiPlanSuggestion,
  type AlternativePatch,
  type PlanAlternative,
  type PlanPreview,
  type PlanRequest,
  type PlannerCandidate,
  type PlanningConstraints,
  type PlanningSelection,
  type PlanVersionSummary,
} from '../../ipc/planner';
import { cn } from '../../lib/cn';
import { listDueReviews } from '../../ipc/learning';

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

const CANDIDATE_PAGE_SIZE = 24;
const AI_CANDIDATE_LIMIT = 200;

export function PlanRoute() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const moduleFilter = searchParams.get('module')?.trim() || undefined;
  const dueReviewsQuery = useQuery({
    queryKey: ['learning', 'due-reviews', 'plan-builder'] as const,
    queryFn: () => listDueReviews(new Date().toISOString(), 500),
    retry: false,
  });
  const planHistoryQuery = useQuery({
    queryKey: ['planner', 'history'] as const,
    queryFn: () => listPlanHistory(8),
    retry: false,
  });
  const [constraints, setConstraints] = useState(defaultConstraints);
  const [selections, setSelections] = useState<Record<string, PlanningSelection>>({});
  const [title, setTitle] = useState('My study plan');
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewedRequest, setPreviewedRequest] = useState<PlanRequest | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const [aiConsent, setAiConsent] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<AiPlanSuggestion | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [planIntentText, setPlanIntentText] = useState('');
  const [planIntentMessage, setPlanIntentMessage] = useState<string | null>(null);
  const [candidatePage, setCandidatePage] = useState(0);
  const [candidateFilter, setCandidateFilter] = useState('');
  const [aiExpanded, setAiExpanded] = useState(false);
  const [moduleSelectionInitialized, setModuleSelectionInitialized] = useState(false);

  const candidatesQuery = useInfiniteQuery({
    queryKey: ['planner', 'candidates', moduleFilter ?? 'all'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listPlanningCandidates({
        ...(moduleFilter ? { moduleId: moduleFilter } : {}),
        cursor: pageParam,
        limit: CANDIDATE_PAGE_SIZE,
      }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const candidates = useMemo(
    () => candidatesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [candidatesQuery.data],
  );
  const candidatePages = candidatesQuery.data?.pages ?? [];
  const currentCandidates = candidatePages[candidatePage]?.items ?? [];
  useEffect(() => {
    if (candidatePages.length > 0 && candidatePage >= candidatePages.length) {
      setCandidatePage(candidatePages.length - 1);
    }
  }, [candidatePage, candidatePages.length]);
  useEffect(() => {
    setCandidatePage(0);
    setSelections({});
    setModuleSelectionInitialized(false);
    setAiSuggestion(null);
    setPreview(null);
    setPreviewedRequest(null);
    setCommitMessage(null);
    setFormError(null);
    setTitle('My study plan');
    setAiConsent(false);
    setAiError(null);
    setPlanIntentText('');
    setPlanIntentMessage(null);
    setCandidateFilter('');
  }, [moduleFilter]);
  const loadingCompleteModule = Boolean(
    moduleFilter &&
    candidatesQuery.hasNextPage &&
    !candidatesQuery.isFetchNextPageError &&
    candidates.length <= AI_CANDIDATE_LIMIT,
  );
  useEffect(() => {
    if (!loadingCompleteModule || candidatesQuery.isFetchingNextPage) return;
    void candidatesQuery.fetchNextPage();
  }, [candidatesQuery.fetchNextPage, candidatesQuery.isFetchingNextPage, loadingCompleteModule]);
  useEffect(() => {
    if (
      !moduleFilter ||
      moduleSelectionInitialized ||
      candidatesQuery.isLoading ||
      candidatesQuery.isFetchingNextPage ||
      loadingCompleteModule
    ) {
      return;
    }
    if (candidates.some((candidate) => candidate.module_id !== moduleFilter)) {
      setFormError(
        'The selected folder returned media from another module. Refresh the Library and try again.',
      );
      setModuleSelectionInitialized(true);
      return;
    }
    setSelections(
      Object.fromEntries(
        candidates.map((candidate) => [candidate.media_id, defaultSelection(candidate.media_id)]),
      ),
    );
    setModuleSelectionInitialized(true);
  }, [
    candidates,
    candidatesQuery.isFetchingNextPage,
    candidatesQuery.isLoading,
    loadingCompleteModule,
    moduleFilter,
    moduleSelectionInitialized,
  ]);
  const cloudPlanningQuery = useQuery({
    queryKey: ['cloud-planning', 'status'],
    queryFn: getCloudPlanningStatus,
  });
  useEffect(() => {
    if (cloudPlanningQuery.data?.configured) setAiExpanded(true);
  }, [cloudPlanningQuery.data?.configured]);

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
      void queryClient.invalidateQueries({ queryKey: ['planner', 'history'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });
  const aiSuggestionMutation = useMutation({
    mutationFn: () => {
      const selected = candidates.filter((candidate) => selections[candidate.media_id]);
      const source = selected.length > 0 ? selected : moduleFilter ? [] : currentCandidates;
      return suggestPlanWithAi(
        source.map((candidate) => candidate.media_id),
        constraints,
        aiConsent,
      );
    },
    onMutate: () => {
      setAiError(null);
      setFormError(null);
    },
    onSuccess: (suggestion) => {
      setAiSuggestion(suggestion);
      setTitle(suggestion.title);
      setSelections(
        Object.fromEntries(
          suggestion.items.map((item) => [
            item.media_id,
            {
              media_id: item.media_id,
              priority: item.priority,
              deadline: selections[item.media_id]?.deadline ?? null,
              dependencies: item.dependencies,
            },
          ]),
        ),
      );
      setPreview(null);
      setPreviewedRequest(null);
      setCommitMessage(null);
      setFormError(null);
      setAiConsent(false);
      setAiError(null);
    },
    onError: (error: Error) => setAiError(error.message),
  });
  const planIntentMutation = useMutation({
    mutationFn: () => parsePlanIntent(planIntentText, localIsoDate(), aiConsent),
    onMutate: () => {
      setAiError(null);
      setPlanIntentMessage(null);
    },
    onSuccess: (intent) => {
      const next = {
        ...constraints,
        ...(intent.daily_budget_minutes === null
          ? {}
          : { daily_budget_minutes: intent.daily_budget_minutes }),
        ...(intent.allowed_weekdays === null ? {} : { allowed_weekdays: intent.allowed_weekdays }),
        ...(intent.preferred_session_minutes === null
          ? {}
          : { preferred_session_minutes: intent.preferred_session_minutes }),
        ...(intent.max_continuous_minutes === null
          ? {}
          : { max_continuous_minutes: intent.max_continuous_minutes }),
        ...(intent.minimum_break_minutes === null
          ? {}
          : { minimum_break_minutes: intent.minimum_break_minutes }),
        ...(intent.playback_speed_milli === null
          ? {}
          : { playback_speed_milli: intent.playback_speed_milli }),
        ...(intent.horizon_days === null ? {} : { horizon_days: intent.horizon_days }),
      };
      next.max_continuous_minutes = Math.min(
        next.max_continuous_minutes,
        next.daily_budget_minutes,
      );
      updateConstraints(next);
      if (intent.title) setTitle(intent.title);
      if (intent.deadline) {
        setSelections((current) =>
          Object.fromEntries(
            Object.entries(current).map(([id, selection]) => [
              id,
              { ...selection, deadline: intent.deadline },
            ]),
          ),
        );
      }
      setPlanIntentMessage(`${intent.explanation} Checked locally before preview.`);
      setPreview(null);
      setPreviewedRequest(null);
    },
    onError: (error: Error) => setAiError(error.message),
  });

  const selectedCandidateCount = candidates.reduce(
    (count, candidate) => count + (selections[candidate.media_id] ? 1 : 0),
    0,
  );
  const aiSourceCount = selectedCandidateCount || (moduleFilter ? 0 : currentCandidates.length);
  const moduleExceedsAiLimit = Boolean(
    moduleFilter && (candidates.length > AI_CANDIDATE_LIMIT || candidatesQuery.hasNextPage),
  );
  const visibleCandidates = useMemo(() => {
    const query = candidateFilter.trim().toLocaleLowerCase();
    if (!query) return currentCandidates;
    return currentCandidates.filter((candidate) =>
      `${candidate.display_name} ${candidate.module_name}`.toLocaleLowerCase().includes(query),
    );
  }, [candidateFilter, currentCandidates]);

  const currentRequest = useMemo<PlanRequest>(() => {
    const preferredOrder =
      aiSuggestion?.items.map((item) => item.media_id) ??
      candidates.map((candidate) => candidate.media_id);
    const ordered = preferredOrder
      .filter((mediaId) => selections[mediaId])
      .map((mediaId) => selections[mediaId]);
    const included = new Set(ordered.map((selection) => selection.media_id));
    ordered.push(
      ...Object.values(selections).filter((selection) => !included.has(selection.media_id)),
    );
    return {
      horizon_start: localIsoDate(),
      constraints,
      selections: ordered,
    };
  }, [aiSuggestion, candidates, constraints, selections]);

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
        for (const mediaId of Object.keys(next)) {
          next[mediaId] = {
            ...next[mediaId],
            dependencies: next[mediaId].dependencies.filter(
              (dependency) => dependency !== candidate.media_id,
            ),
          };
        }
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
    setAiSuggestion(null);
    markEdited();
  }

  function updateSelection(mediaId: string, patch: Partial<PlanningSelection>) {
    setSelections((current) => ({
      ...current,
      [mediaId]: { ...current[mediaId], ...patch },
    }));
    markEdited();
  }

  function selectCurrentPage() {
    setSelections((current) => ({
      ...current,
      ...Object.fromEntries(
        visibleCandidates
          .filter((candidate) => !current[candidate.media_id])
          .map((candidate) => [candidate.media_id, defaultSelection(candidate.media_id)]),
      ),
    }));
    setAiSuggestion(null);
    markEdited();
  }

  function clearSelections() {
    setSelections({});
    setAiSuggestion(null);
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

  async function showNextCandidatePage() {
    const nextPage = candidatePage + 1;
    if (nextPage < candidatePages.length) {
      setCandidatePage(nextPage);
      return;
    }
    if (!candidatesQuery.hasNextPage || candidatesQuery.isFetchingNextPage) return;
    const result = await candidatesQuery.fetchNextPage();
    if (result.data?.pages[nextPage]) setCandidatePage(nextPage);
  }

  return (
    <>
      <PageHeader
        eyebrow="Plan Builder"
        title="Design a study week you can keep"
        description="Pick what matters, define your real availability, then preview a routine that fits before anything is committed."
      />

      <BuilderProgress
        selectedCount={Object.keys(selections).length}
        dailyMinutes={constraints.daily_budget_minutes}
        studyDayCount={constraints.allowed_weekdays.length}
        preview={preview}
      />

      <PlanHistoryPanel
        versions={planHistoryQuery.data ?? []}
        pending={planHistoryQuery.isPending}
      />

      {!dueReviewsQuery.isPending && (dueReviewsQuery.data?.length ?? 0) > 0 ? (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-warning/25 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Brain className="mt-0.5 size-5 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-semibold">
                Reserve time for {dueReviewsQuery.data!.length} due reviews
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Review work is not silently converted into video time. Keep a small buffer inside
                the daily budget.
              </p>
            </div>
          </div>
          <Link to="/study" className="shrink-0 text-sm font-semibold text-primary hover:underline">
            Open Study Hub
          </Link>
        </div>
      ) : null}

      <div className="mt-6 grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-border/70 bg-muted/15 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <StepNumber value="1" />
                <div>
                  <CardTitle>Choose what to study</CardTitle>
                  <CardDescription className="mt-1">
                    Build a focused queue from metadata-ready lessons. You can tune priority and
                    deadlines after selecting.
                  </CardDescription>
                </div>
              </div>
              <Badge tone={Object.keys(selections).length > 0 ? 'success' : 'neutral'}>
                {Object.keys(selections).length} selected
              </Badge>
            </CardHeader>
            <CardContent className="pt-5">
              {candidatesQuery.isError ? (
                <InlineError message="Ready media could not be loaded." />
              ) : candidatesQuery.isLoading || (moduleFilter && !moduleSelectionInitialized) ? (
                <LoadingLine
                  label={
                    moduleFilter ? 'Loading the complete folder module' : 'Loading ready media'
                  }
                />
              ) : currentCandidates.length === 0 && candidatePage === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center">
                  <p className="text-sm font-medium">No schedulable media yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {moduleFilter
                      ? 'This folder has no metadata-ready videos yet.'
                      : 'Add a folder and let metadata inspection finish first.'}
                  </p>
                  <Link
                    to="/library"
                    className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
                  >
                    Open Library
                  </Link>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <label className="relative min-w-0 flex-1" htmlFor="candidate-filter">
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      />
                      <input
                        id="candidate-filter"
                        value={candidateFilter}
                        onChange={(event) => setCandidateFilter(event.target.value)}
                        placeholder="Filter this page"
                        className={cn(inputClass, 'mt-0 pl-9')}
                      />
                      <span className="sr-only">Filter ready media on this page</span>
                    </label>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={visibleCandidates.length === 0}
                        onClick={selectCurrentPage}
                      >
                        Select page
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={Object.keys(selections).length === 0}
                        onClick={clearSelections}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                  {visibleCandidates.length > 0 ? (
                    <CandidateList
                      candidates={visibleCandidates}
                      selections={selections}
                      onToggle={toggleCandidate}
                      onUpdate={updateSelection}
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                      No lessons on this page match “{candidateFilter}”.
                    </div>
                  )}
                </>
              )}
              {currentCandidates.length > 0 && (!moduleFilter || moduleSelectionInitialized) ? (
                <CandidatePagination
                  page={candidatePage}
                  itemCount={currentCandidates.length}
                  pageSize={CANDIDATE_PAGE_SIZE}
                  hasPrevious={candidatePage > 0}
                  hasNext={
                    candidatePage + 1 < candidatePages.length ||
                    Boolean(candidatesQuery.hasNextPage)
                  }
                  loadingNext={candidatesQuery.isFetchingNextPage}
                  onPrevious={() => setCandidatePage((page) => Math.max(0, page - 1))}
                  onNext={() => void showNextCandidatePage()}
                />
              ) : null}
              {moduleFilter && moduleSelectionInitialized ? (
                <p className="mt-3 text-xs text-muted-foreground" role="status">
                  {candidatesQuery.hasNextPage
                    ? `Loaded the first ${candidates.length.toLocaleString()} ready videos; this folder contains more.`
                    : `Folder module loaded: ${candidates.length.toLocaleString()} ready video${candidates.length === 1 ? '' : 's'} across ${candidatePages.length} page${candidatePages.length === 1 ? '' : 's'}.`}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden border-primary/15 bg-primary/[0.025]">
            <div className="pointer-events-none absolute -right-16 -top-20 size-48 rounded-full bg-primary/8 blur-3xl" />
            <CardHeader className={cn(aiExpanded && 'border-b border-primary/10')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/15 bg-primary/10 text-primary">
                    <Sparkles className="size-4" />
                  </span>
                  <div>
                    <CardTitle>AI assist</CardTitle>
                    <CardDescription className="mt-1 max-w-2xl">
                      Optional help for interpreting constraints and ordering prerequisites.
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={cloudPlanningQuery.data?.configured ? 'success' : 'neutral'}>
                    {cloudPlanningQuery.data?.configured ? 'Connected' : 'Optional'}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={aiExpanded}
                    onClick={() => setAiExpanded((expanded) => !expanded)}
                  >
                    {aiExpanded ? 'Hide' : 'Open'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            {aiExpanded ? (
              <CardContent className="space-y-4 pt-5">
                <div className="grid gap-2 sm:grid-cols-3" aria-label="AI planning boundaries">
                  <AiFact value="Grounded summaries" label="No media or raw transcripts" />
                  <AiFact value="You approve" label="Consent every request" />
                  <AiFact value="Locally checked" label="Feasibility stays on-device" />
                </div>

                {cloudPlanningQuery.isPending ? (
                  <LoadingLine label="Checking AI planning availability" />
                ) : cloudPlanningQuery.isError ? (
                  <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-medium">AI service status is unavailable</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          The desktop bridge did not respond. Your local plan builder still works.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void cloudPlanningQuery.refetch()}
                      >
                        Check again
                      </Button>
                    </div>
                  </div>
                ) : cloudPlanningQuery.data?.configured ? (
                  <>
                    <div className="rounded-xl border border-primary/15 bg-background/65 p-4 text-sm text-muted-foreground shadow-sm backdrop-blur">
                      <p className="leading-6">
                        LectorBit will send{' '}
                        {Object.keys(selections).length > 0
                          ? 'the selected'
                          : 'the current page of'}{' '}
                        module names, video names, durations, the limits below, and generated
                        transcript-grounded summaries when available to OpenRouter. It will not send
                        media, raw transcripts, viewing history, or absolute paths.
                      </p>
                      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 bg-card/75 p-3 text-foreground transition-colors hover:border-primary/25">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 shrink-0 accent-primary"
                          checked={aiConsent}
                          onChange={(event) => setAiConsent(event.target.checked)}
                        />
                        <span>
                          I understand this request uses my OpenRouter account and free model
                          providers may retain or use the metadata under their policies.
                        </span>
                      </label>
                    </div>
                    <div className="rounded-xl border bg-background/65 p-4">
                      <label htmlFor="natural-plan-request" className="text-sm font-semibold">
                        Describe your routine in plain language
                      </label>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        AI only converts your words into typed fields. Rust still validates and
                        schedules everything.
                      </p>
                      <textarea
                        id="natural-plan-request"
                        value={planIntentText}
                        onChange={(event) => setPlanIntentText(event.target.value)}
                        rows={3}
                        maxLength={1000}
                        placeholder="Study 45 minutes on weekdays and finish this module before September 30."
                        className="mt-3 w-full rounded-lg border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <Button
                          variant="outline"
                          disabled={
                            !aiConsent || !planIntentText.trim() || planIntentMutation.isPending
                          }
                          onClick={() => planIntentMutation.mutate()}
                        >
                          {planIntentMutation.isPending ? (
                            <LoaderCircle className="size-4 animate-spin" />
                          ) : (
                            <Sparkles className="size-4" />
                          )}
                          Apply interpreted constraints
                        </Button>
                        {planIntentMessage ? (
                          <p className="text-xs text-success" role="status">
                            {planIntentMessage}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {aiError ? <InlineError message={aiError} /> : null}
                    {moduleExceedsAiLimit ? (
                      <div
                        className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm"
                        role="alert"
                      >
                        This module has more than {AI_CANDIDATE_LIMIT} ready videos, so one AI
                        request cannot cover the whole folder. AI can sequence a selected subset of
                        at most {AI_CANDIDATE_LIMIT}
                        {selectedCandidateCount > AI_CANDIDATE_LIMIT
                          ? `; deselect at least ${(selectedCandidateCount - AI_CANDIDATE_LIMIT).toLocaleString()} to continue`
                          : ''}
                        . Local deterministic planning still supports the selected media.
                      </div>
                    ) : null}
                    <Button
                      className="w-full sm:w-auto"
                      disabled={
                        !aiConsent ||
                        aiSourceCount === 0 ||
                        aiSourceCount > AI_CANDIDATE_LIMIT ||
                        (Boolean(moduleFilter) && !moduleSelectionInitialized) ||
                        aiSuggestionMutation.isPending
                      }
                      onClick={() => aiSuggestionMutation.mutate()}
                      leftIcon={
                        aiSuggestionMutation.isPending ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Sparkles className="size-4" />
                        )
                      }
                    >
                      {aiSuggestionMutation.isPending
                        ? 'Checking prerequisites…'
                        : 'Suggest grounded prerequisites'}
                    </Button>
                    {aiSuggestionMutation.isPending ? (
                      <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
                        A compatible free model is being selected. Free providers can take a few
                        minutes during busy periods.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-primary/25 bg-background/45 p-4 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">Connect your private AI key</p>
                    <p className="mt-1 leading-6">
                      Add your OpenRouter key securely in{' '}
                      <Link to="/settings" className="font-semibold text-primary hover:underline">
                        Settings
                      </Link>{' '}
                      to enable AI suggestions.
                    </p>
                  </div>
                )}
                {aiSuggestion ? (
                  <div className="rounded-xl border border-success/25 bg-success/10 p-4 shadow-[0_12px_32px_rgba(26,156,107,0.08)]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="flex items-center gap-2 font-display font-semibold">
                        <CheckCircle2 className="size-4 text-success" /> {aiSuggestion.title}
                      </p>
                      <Badge tone="success">Prerequisites applied</Badge>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {aiSuggestion.description}
                    </p>
                    <ol className="mt-3 space-y-2">
                      {aiSuggestion.items.slice(0, 6).map((item, index) => (
                        <li
                          key={item.media_id}
                          className="flex gap-3 rounded-lg bg-background/55 p-2.5 text-xs text-muted-foreground"
                        >
                          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-success/15 font-mono text-[10px] font-semibold text-success">
                            {index + 1}
                          </span>
                          <span>
                            <strong className="font-medium text-foreground">
                              {candidateName(candidates, item.media_id)}
                            </strong>{' '}
                            — {item.reason}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {aiSuggestion.items.length > 6 ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        + {aiSuggestion.items.length - 6} more ordered videos
                      </p>
                    ) : null}
                    <p className="mt-3 font-mono text-[10px] text-muted-foreground">
                      Suggested by {aiSuggestion.model}; order and feasibility remain local
                    </p>
                  </div>
                ) : null}
              </CardContent>
            ) : null}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader className="border-b border-border/70 bg-muted/15">
              <div className="flex items-start gap-3">
                <StepNumber value="2" />
                <div>
                  <CardTitle>Shape your study week</CardTitle>
                  <CardDescription className="mt-1">
                    Set honest availability. These limits are hard caps, so the preview stays
                    realistic.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6 pt-5">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <fieldset>
                  <legend className="mb-2 text-sm font-semibold">Days you can study</legend>
                  <div className="grid grid-cols-7 gap-1.5 sm:max-w-md">
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
                            'grid h-10 min-w-0 place-items-center rounded-lg border text-sm font-semibold transition-[background-color,border-color,color,transform] active:scale-95',
                            active
                              ? 'border-primary/35 bg-primary text-primary-foreground shadow-sm'
                              : 'bg-background text-muted-foreground hover:border-primary/25 hover:bg-secondary',
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
                <div>
                  <p className="mb-2 text-sm font-semibold">Quick daily budget</p>
                  <div className="flex flex-wrap gap-2" aria-label="Daily budget presets">
                    {[30, 45, 60, 90].map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        aria-pressed={constraints.daily_budget_minutes === minutes}
                        onClick={() =>
                          updateConstraints({ ...constraints, daily_budget_minutes: minutes })
                        }
                        className={cn(
                          'rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
                          constraints.daily_budget_minutes === minutes
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'bg-background text-muted-foreground hover:border-primary/25 hover:text-foreground',
                        )}
                      >
                        {minutes} min
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 rounded-xl border border-border/70 bg-background/55 p-4 sm:grid-cols-2 lg:grid-cols-3">
                <NumberField
                  id="daily-budget"
                  label="Daily budget"
                  suffix="min"
                  value={constraints.daily_budget_minutes}
                  min={1}
                  max={1440}
                  onChange={(value) =>
                    updateConstraints({ ...constraints, daily_budget_minutes: value })
                  }
                />
                <NumberField
                  id="preferred-session"
                  label="Preferred session"
                  suffix="min"
                  value={constraints.preferred_session_minutes}
                  min={1}
                  max={480}
                  onChange={(value) =>
                    updateConstraints({ ...constraints, preferred_session_minutes: value })
                  }
                />
                <NumberField
                  id="max-continuous"
                  label="Max continuous"
                  suffix="min"
                  value={constraints.max_continuous_minutes}
                  min={1}
                  max={480}
                  onChange={(value) =>
                    updateConstraints({ ...constraints, max_continuous_minutes: value })
                  }
                />
                <NumberField
                  id="break-minutes"
                  label="Break between blocks"
                  suffix="min"
                  value={constraints.minimum_break_minutes}
                  min={0}
                  max={120}
                  onChange={(value) =>
                    updateConstraints({ ...constraints, minimum_break_minutes: value })
                  }
                />
                <label className="space-y-1.5 text-sm font-medium" htmlFor="playback-speed">
                  Playback speed
                  <select
                    id="playback-speed"
                    value={constraints.playback_speed_milli}
                    onChange={(event) =>
                      updateConstraints({
                        ...constraints,
                        playback_speed_milli: Number(event.target.value),
                      })
                    }
                    className={inputClass}
                  >
                    {[500, 750, 1000, 1250, 1500, 1750, 2000].map((speed) => (
                      <option key={speed} value={speed}>
                        {(speed / 1000).toFixed(2)}x
                      </option>
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
            </CardContent>
          </Card>
        </div>

        <PreviewPanel
          preview={preview}
          isPending={previewMutation.isPending}
          alternativesDisabled={previewMutation.isPending}
          onApplyAlternative={applyAlternative}
          onCommit={() => {
            if (previewedRequest)
              commitMutation.mutate({ request: previewedRequest, planTitle: title });
          }}
          commitPending={commitMutation.isPending}
          commitMessage={commitMessage}
          selectionCount={Object.keys(selections).length}
          constraints={constraints}
          formError={formError}
          onPreview={() => requestPreview()}
        />
      </div>
    </>
  );
}

function PlanHistoryPanel({
  versions,
  pending,
}: {
  versions: PlanVersionSummary[];
  pending: boolean;
}) {
  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-primary" /> Plan history
        </CardTitle>
        <CardDescription>
          Immutable versions make every commit and automatic replan auditable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {pending ? (
          <div className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Your first committed plan will create the initial version.
          </p>
        ) : (
          <ol className="grid gap-2 lg:grid-cols-2">
            {versions.slice(0, 4).map((version) => {
              const changes = version.added_count + version.removed_count + version.moved_count;
              return (
                <li key={version.id} className="rounded-xl border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">
                        {version.is_active
                          ? 'Current plan'
                          : formatPlanVersionTime(version.created_at)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDay(version.horizon_start)}–{formatDay(version.horizon_end)} ·{' '}
                        {version.item_count} blocks · {formatDuration(version.effective_content_ms)}
                      </p>
                    </div>
                    <Badge tone={version.is_active ? 'primary' : 'neutral'}>
                      {version.is_active ? 'Active' : `${version.day_count} days`}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {changes === 0
                      ? 'Initial version'
                      : `+${version.added_count} added · −${version.removed_count} removed · ${version.moved_count} moved`}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function BuilderProgress({
  selectedCount,
  dailyMinutes,
  studyDayCount,
  preview,
}: {
  selectedCount: number;
  dailyMinutes: number;
  studyDayCount: number;
  preview: PlanPreview | null;
}) {
  const steps = [
    {
      number: '1',
      label: 'Lessons',
      value: selectedCount > 0 ? `${selectedCount} lessons queued` : 'Choose your queue',
      complete: selectedCount > 0,
    },
    {
      number: '2',
      label: 'Availability',
      value: `${dailyMinutes} min · ${studyDayCount} days/week`,
      complete: studyDayCount > 0,
    },
    {
      number: '3',
      label: 'Preview',
      value: preview ? (preview.feasible ? 'Ready to commit' : 'Adjust capacity') : 'Check the fit',
      complete: Boolean(preview?.feasible),
    },
  ];
  return (
    <ol className="grid gap-2 sm:grid-cols-3" aria-label="Plan builder progress">
      {steps.map((step) => (
        <li
          key={step.number}
          className={cn(
            'flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors',
            step.complete ? 'border-success/25 bg-success/[0.06]' : 'border-border/75 bg-card/70',
          )}
        >
          <span
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold',
              step.complete ? 'bg-success text-white' : 'bg-muted text-muted-foreground',
            )}
          >
            {step.complete ? <CheckCircle2 aria-hidden="true" className="size-4" /> : step.number}
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {step.label}
            </span>
            <span className="mt-0.5 block truncate text-sm font-medium">{step.value}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepNumber({ value }: { value: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground shadow-sm">
      {value}
    </span>
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
  const modules = groupCandidatesByModule(candidates);
  return (
    <div className="space-y-4">
      {modules.map((module) => (
        <section
          key={module.id}
          className="overflow-hidden rounded-xl border border-border/80 bg-background/45"
          aria-label={`${module.name} module`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-muted/30 px-4 py-3">
            <div>
              <p className="text-sm font-semibold">{module.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {module.items.length} lessons on this page
              </p>
            </div>
            <div className="flex gap-2">
              <Badge tone="neutral">{formatDuration(module.durationMs)}</Badge>
            </div>
          </div>
          <div className="divide-y">
            {module.items.map((candidate) => (
              <CandidateRow
                key={candidate.media_id}
                candidate={candidate}
                selection={selections[candidate.media_id]}
                onToggle={() => onToggle(candidate)}
                onUpdate={(patch) => onUpdate(candidate.media_id, patch)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CandidatePagination({
  page,
  itemCount,
  pageSize,
  hasPrevious,
  hasNext,
  loadingNext,
  onPrevious,
  onNext,
}: {
  page: number;
  itemCount: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
  loadingNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const firstItem = page * pageSize + 1;
  const lastItem = firstItem + itemCount - 1;
  return (
    <nav
      className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"
      aria-label="Study media pages"
    >
      <p className="text-xs text-muted-foreground">
        Page {page + 1} · media {firstItem.toLocaleString()}–{lastItem.toLocaleString()}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasPrevious || loadingNext}
          onClick={onPrevious}
        >
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!hasNext || loadingNext} onClick={onNext}>
          {loadingNext ? 'Loading…' : 'Next'}
        </Button>
      </div>
    </nav>
  );
}

function groupCandidatesByModule(candidates: PlannerCandidate[]) {
  const modules = new Map<
    string,
    { id: string; name: string; durationMs: number; items: PlannerCandidate[] }
  >();
  for (const candidate of candidates) {
    const module = modules.get(candidate.module_id) ?? {
      id: candidate.module_id,
      name: candidate.module_name,
      durationMs: 0,
      items: [],
    };
    module.items.push(candidate);
    module.durationMs += candidate.duration_ms;
    modules.set(candidate.module_id, module);
  }
  return [...modules.values()];
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
    <div
      className={cn(
        'border-l-2 border-l-transparent px-4 py-3.5 transition-colors',
        checked ? 'border-l-primary bg-primary/[0.055]' : 'hover:bg-muted/25',
      )}
    >
      <label className="flex cursor-pointer items-start gap-3.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{candidate.display_name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{formatDuration(candidate.duration_ms)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {candidate.chunk_count} {candidate.chunk_count === 1 ? 'study block' : 'study blocks'}
            </span>
            <span className="hidden truncate font-mono sm:inline" title={candidate.path_redacted}>
              · {candidate.path_redacted}
            </span>
          </span>
        </span>
        {checked ? <Badge tone="primary">Included</Badge> : null}
      </label>
      {selection ? (
        <div className="ml-8 mt-3 grid gap-3 rounded-lg border border-primary/10 bg-background/65 p-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            Priority
            <select
              value={selection.priority}
              onChange={(event) => onUpdate({ priority: Number(event.target.value) })}
              className={inputClass}
            >
              <option value={1}>Low</option>
              <option value={2}>Below normal</option>
              <option value={3}>Normal</option>
              <option value={4}>High</option>
              <option value={5}>Critical</option>
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
  selectionCount,
  constraints,
  formError,
  onPreview,
}: {
  preview: PlanPreview | null;
  isPending: boolean;
  alternativesDisabled: boolean;
  onApplyAlternative: (alternative: PlanAlternative) => void;
  onCommit: () => void;
  commitPending: boolean;
  commitMessage: string | null;
  selectionCount: number;
  constraints: PlanningConstraints;
  formError: string | null;
  onPreview: () => void;
}) {
  return (
    <Card className="min-w-0 overflow-hidden xl:sticky xl:top-6">
      <CardHeader className="border-b border-border/70 bg-muted/15">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <StepNumber value="3" />
            <div>
              <CardTitle>Preview the fit</CardTitle>
              <CardDescription className="mt-1">Nothing is saved until you commit.</CardDescription>
            </div>
          </div>
          {preview ? (
            <Badge tone={preview.feasible ? 'success' : 'warning'}>
              {preview.feasible ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <TriangleAlert className="size-3.5" />
              )}
              {preview.feasible ? 'Feasible' : 'Needs changes'}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        {isPending ? <LoadingLine label="Checking every hard constraint" /> : null}
        {!preview && !isPending ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border/75 bg-background/55 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <ListChecks className="size-4 text-primary" /> Plan snapshot
              </div>
              <dl className="space-y-2.5 text-sm">
                <SummaryRow label="Lessons" value={`${selectionCount} in queue`} />
                <SummaryRow
                  label="Weekly rhythm"
                  value={`${constraints.daily_budget_minutes} min · ${constraints.allowed_weekdays.length} days`}
                />
                <SummaryRow label="Planning window" value={`${constraints.horizon_days} days`} />
                <SummaryRow
                  label="Playback"
                  value={`${(constraints.playback_speed_milli / 1000).toFixed(2)}x`}
                />
              </dl>
            </div>
            <div className="rounded-lg border border-dashed border-primary/20 bg-primary/[0.035] p-4 text-sm leading-6 text-muted-foreground">
              Preview checks every lesson, break, deadline, and daily cap before you can commit.
            </div>
            {formError ? <InlineError message={formError} /> : null}
            <Button
              className="w-full"
              onClick={onPreview}
              leftIcon={<Sparkles className="size-4" />}
            >
              Preview plan
            </Button>
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
                        <span className="text-xs text-muted-foreground">
                          {formatDuration(day.effective_content_ms)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {day.item_count} blocks · {formatDuration(day.break_ms)} breaks
                      </p>
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
        {preview && formError ? <InlineError message={formError} /> : null}
        {commitMessage ? (
          <div
            className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
            role="status"
          >
            <CheckCircle2 className="mr-2 inline size-4" />
            {commitMessage}{' '}
            <Link to="/" className="font-medium underline">
              Open Routine
            </Link>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function SceneStrip({ preview }: { preview: PlanPreview }) {
  const shown = preview.days.slice(0, 12);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
        <CalendarClock className="size-3.5" /> Routine strip
      </div>
      <div
        className="flex min-h-24 items-end gap-2 overflow-hidden rounded-lg bg-secondary p-3"
        aria-label={`${preview.days.length} scheduled days`}
      >
        {shown.map((day, index) => (
          <div
            key={day.date}
            className="relative aspect-[9/16] min-w-8 flex-1 overflow-hidden rounded-md border border-vermillion-200 bg-card shadow-sm dark:border-vermillion-900"
            title={`${formatDay(day.date)} · ${formatDuration(day.effective_content_ms)}`}
          >
            <div
              className="absolute inset-x-0 bottom-0 bg-primary/85"
              style={{ height: `${Math.max(18, Math.min(100, day.item_count * 22))}%` }}
            />
            <span className="absolute left-1.5 top-1 text-[9px] font-semibold text-muted-foreground">
              {index + 1}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NumberField({
  id,
  label,
  suffix,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
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
          onChange={(event) =>
            onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))
          }
          className={cn(inputClass, 'pr-12')}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-normal text-muted-foreground">
          {suffix}
        </span>
      </span>
    </label>
  );
}

function AiFact({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-primary/10 bg-background/50 px-3 py-2.5 backdrop-blur">
      <p className="text-xs font-semibold text-foreground">{value}</p>
      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{label}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="font-mono text-lg font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function LoadingLine({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md bg-secondary p-3 text-sm text-muted-foreground"
      role="status"
    >
      <LoaderCircle className="size-4 animate-spin text-primary" />
      {label}
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      role="alert"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      {message}
    </div>
  );
}

function patchRequest(request: PlanRequest, patch: AlternativePatch): PlanRequest {
  const constraints = { ...request.constraints };
  const selections = request.selections.map((selection) => ({ ...selection }));
  switch (patch.kind) {
    case 'allow_weekdays':
      constraints.allowed_weekdays = patch.weekdays;
      break;
    case 'increase_daily_budget':
      constraints.daily_budget_minutes = patch.minutes;
      break;
    case 'extend_horizon':
      constraints.horizon_days = patch.days;
      break;
    case 'increase_playback_speed':
      constraints.playback_speed_milli = patch.speed_milli;
      break;
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

function candidateName(candidates: PlannerCandidate[], mediaId: string): string {
  return candidates.find((candidate) => candidate.media_id === mediaId)?.display_name ?? 'Video';
}

function defaultSelection(mediaId: string): PlanningSelection {
  return {
    media_id: mediaId,
    priority: 3,
    deadline: null,
    dependencies: [],
  };
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDay(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatPlanVersionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Previous plan';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

const inputClass = 'form-control mt-1 h-10 font-normal text-foreground';
