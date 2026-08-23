import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ArrowRight from 'lucide-react/dist/esm/icons/arrow-right';
import BookOpen from 'lucide-react/dist/esm/icons/book-open';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import Download from 'lucide-react/dist/esm/icons/download';
import HardDrive from 'lucide-react/dist/esm/icons/hard-drive';
import LibraryBig from 'lucide-react/dist/esm/icons/library-big';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import Search from 'lucide-react/dist/esm/icons/search';
import Settings2 from 'lucide-react/dist/esm/icons/settings-2';
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { useRef, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
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
  getAnalysisCapability,
  installModel,
  listAnalysisJobs,
  listModels,
  type AnalysisJob,
  type AnalysisProgress,
  type LocalModel,
} from '../../ipc/analysis';
import { listDueReviews } from '../../ipc/learning';
import { getCloudPlanningStatus } from '../../ipc/planner';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
const activeStatuses = new Set(['queued', 'running', 'paused', 'retry_wait']);

export function AiStudioRoute() {
  const queryClient = useQueryClient();
  const [installProgress, setInstallProgress] = useState<AnalysisProgress>();
  const installProgressRef = useRef<AnalysisProgress | undefined>(undefined);
  const [notice, setNotice] = useState<string>();
  const models = useQuery({
    queryKey: ['analysis', 'models'] as const,
    queryFn: listModels,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((model) => model.state === 'downloading') ? 1_500 : false,
  });
  const analysisCapability = useQuery({
    queryKey: ['analysis', 'capability'] as const,
    queryFn: getAnalysisCapability,
    retry: false,
  });
  const cloud = useQuery({
    queryKey: ['cloud-planning', 'status'] as const,
    queryFn: getCloudPlanningStatus,
    retry: false,
  });
  const transcriptionJobs = useQuery({
    queryKey: ['analysis', 'jobs', 'transcribe'] as const,
    queryFn: () => listAnalysisJobs('transcribe'),
    retry: false,
    refetchInterval: activeJobInterval,
  });
  const modelJobs = useQuery({
    queryKey: ['analysis', 'jobs', 'model_download'] as const,
    queryFn: () => listAnalysisJobs('model_download'),
    retry: false,
    refetchInterval: activeJobInterval,
  });
  const dueReviews = useQuery({
    queryKey: ['learning', 'due-reviews', 'ai-studio'] as const,
    queryFn: () => listDueReviews(new Date().toISOString(), 6),
    retry: false,
  });
  const install = useMutation({
    mutationFn: (model: LocalModel) =>
      installModel(model.id, (event) => {
        installProgressRef.current = event;
        setInstallProgress(event);
        if (event.event === 'completed') {
          setNotice(`${model.display_name} is verified and ready for English and Bangla.`);
          void queryClient.invalidateQueries({ queryKey: ['analysis'] });
        }
        if (event.event === 'failed') {
          setNotice(event.data.message);
          void queryClient.invalidateQueries({ queryKey: ['analysis'] });
        }
      }),
    onMutate: (model) => {
      setNotice(`Preparing the verified ${model.display_name} download…`);
      installProgressRef.current = undefined;
      setInstallProgress(undefined);
    },
    onSuccess: (_job, model) => {
      const latest = installProgressRef.current;
      if (latest?.event === 'completed') {
        setNotice(`${model.display_name} is verified and ready for English and Bangla.`);
      } else if (latest?.event === 'failed') {
        setNotice(latest.data.message);
      } else {
        setNotice('Model installation queued. The verified download can resume after a restart.');
      }
      void queryClient.invalidateQueries({ queryKey: ['analysis'] });
    },
    onError: (error) => setNotice(messageFrom(error)),
  });

  const engineReady = analysisCapability.data?.available === true;
  const englishReady = languageReady(models.data, analysisCapability.data, 'en');
  const banglaReady = languageReady(models.data, analysisCapability.data, 'bn');
  const whisperReady = englishReady && banglaReady;
  const multilingualModel = models.data?.find(
    (model) => model.supported_languages.includes('en') && model.supported_languages.includes('bn'),
  );
  const recentJobs = [...(transcriptionJobs.data ?? []), ...(modelJobs.data ?? [])]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, 5);
  const activeJobs = recentJobs.filter((job) => activeStatuses.has(job.status)).length;
  const failedJobs = recentJobs.filter((job) => job.status === 'failed').length;
  const statusUnavailable =
    models.isError ||
    analysisCapability.isError ||
    cloud.isError ||
    transcriptionJobs.isError ||
    modelJobs.isError ||
    dueReviews.isError;
  const transcriptionPending = models.isPending || analysisCapability.isPending;
  const isRefreshing =
    models.isFetching ||
    analysisCapability.isFetching ||
    cloud.isFetching ||
    transcriptionJobs.isFetching ||
    modelJobs.isFetching ||
    dueReviews.isFetching;
  const installedModels = models.data?.filter((model) => model.state === 'ready') ?? [];
  const dueCount = dueReviews.data?.length ?? 0;

  const refresh = () => {
    setNotice('Refreshing the local and cloud capability snapshot…');
    void Promise.all([
      models.refetch(),
      analysisCapability.refetch(),
      cloud.refetch(),
      transcriptionJobs.refetch(),
      modelJobs.refetch(),
      dueReviews.refetch(),
    ]).then(() => setNotice('AI Studio status is up to date.'));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Evidence intelligence"
        title="AI Studio"
        description="Operate LectorBit's local transcription, consent-scoped reasoning, and review system from one evidence-first command center."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={refresh} disabled={isRefreshing}>
              <RefreshCw
                aria-hidden="true"
                className={
                  isRefreshing ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4'
                }
              />
              {isRefreshing ? 'Checking…' : 'Check status'}
            </Button>
            <Link to="/settings" className={secondaryLinkClass}>
              <Settings2 className="size-4" /> Configure AI
            </Link>
          </div>
        }
      />

      {notice ? (
        <p
          className="rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-sm"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      <EvidencePipeline
        engineReady={engineReady}
        transcriptReady={englishReady || banglaReady}
        cloudReady={cloud.data?.configured === true}
        reviewReady={dueReviews.data !== undefined}
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="AI readiness">
        <ReadinessCard
          label="Local transcription"
          value={transcriptionPending ? 'Checking…' : whisperReady ? 'Ready' : 'Setup needed'}
          detail={
            whisperReady
              ? 'English and Bangla models are verified locally'
              : transcriptionReadinessDetail(analysisCapability.data, englishReady, banglaReady)
          }
          ready={whisperReady}
          pending={transcriptionPending}
        />
        <ReadinessCard
          label="Cloud intelligence"
          value={cloud.isPending ? 'Checking…' : cloud.data?.configured ? 'Connected' : 'Optional'}
          detail={
            cloud.data?.configured
              ? `${cloud.data.provider} · ${cloud.data.model}`
              : 'Connect OpenRouter for cited explanations and study-set generation'
          }
          ready={Boolean(cloud.data?.configured)}
          pending={cloud.isPending}
        />
        <ReadinessCard
          label="Review queue"
          value={dueReviews.isPending ? 'Checking…' : dueCount ? `${dueCount} due` : 'Clear'}
          detail={
            dueCount
              ? 'Grounded questions are ready for active recall'
              : 'Generated cards appear here when their local due date arrives'
          }
          ready={!dueCount && !dueReviews.isPending}
          pending={dueReviews.isPending}
        />
        <ReadinessCard
          label="Background work"
          value={
            transcriptionJobs.isPending || modelJobs.isPending
              ? 'Checking…'
              : activeJobs
                ? `${activeJobs} active`
                : failedJobs
                  ? `${failedJobs} need help`
                  : 'Idle'
          }
          detail="Downloads and transcripts are durable across restarts"
          ready={!activeJobs && !failedJobs && !transcriptionJobs.isPending && !modelJobs.isPending}
          pending={transcriptionJobs.isPending || modelJobs.isPending}
        />
      </section>

      {statusUnavailable ? (
        <p
          className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm text-muted-foreground"
          role="status"
        >
          Live AI status is unavailable in this preview. No settings were changed; check again when
          the desktop backend is connected.
        </p>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
        <NextActionCard
          pending={transcriptionPending || cloud.isPending || dueReviews.isPending}
          engineReady={engineReady}
          bilingualReady={whisperReady}
          cloudReady={cloud.data?.configured === true}
          dueCount={dueCount}
          model={multilingualModel}
          installProgress={installProgress}
          installPending={install.isPending}
          onInstall={(model) => install.mutate(model)}
        />
        <ActivityCard
          jobs={recentJobs}
          pending={transcriptionJobs.isPending || modelJobs.isPending}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <Card className="ai-studio-card overflow-hidden border-primary/20">
          <div className="h-1 bg-gradient-to-r from-primary via-vermillion-400 to-amber-300" />
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Sparkles className="size-5 text-primary" /> Launch a grounded workflow
                </CardTitle>
                <CardDescription className="mt-1 max-w-2xl leading-6">
                  Every cloud answer starts from timestamp evidence. Playback history, schedules,
                  progress, and review dates remain local and deterministic.
                </CardDescription>
              </div>
              <Badge tone="success">
                <ShieldCheck className="size-3.5" /> Evidence first
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <WorkflowCard
              icon={LibraryBig}
              title="Index a lecture"
              description="Import a video and create a bilingual, timestamped transcript entirely on this device."
              to="/library"
              action="Open Library"
            />
            <WorkflowCard
              icon={BookOpen}
              title="Study the current moment"
              description="Resume a scheduled block, ask cited questions, explain a frame, or build detailed review material."
              to="/"
              action="Choose a study block"
            />
            <WorkflowCard
              icon={ListChecks}
              title="Review what is fading"
              description="Use the local due queue to recall difficult ideas before the evidence slips away."
              to="/"
              action={dueCount ? `Review ${dueCount} due` : 'Open Today'}
            />
            <WorkflowCard
              icon={Search}
              title="Find an exact moment"
              description="Search transcript speech, media names, and annotations, then jump back to the source timestamp."
              to="/search"
              action="Search evidence"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>Local model shelf</CardTitle>
                <CardDescription className="mt-1">
                  Verified engines available to your private library.
                </CardDescription>
              </div>
              <Badge tone={installedModels.length ? 'success' : 'neutral'}>
                {installedModels.length} installed
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {models.isPending ? (
              <div className="h-24 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
            ) : installedModels.length ? (
              installedModels.map((model) => <ModelFact key={model.id} model={model} />)
            ) : (
              <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                No verified transcription model is installed yet.
              </div>
            )}
            <Link
              to="/settings"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              Manage local models <ArrowRight className="size-3.5" />
            </Link>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Designed trust boundary</CardTitle>
          <CardDescription>
            LectorBit separates private source material from explicitly approved reasoning.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-3">
          <BoundaryFact icon={HardDrive} title="Private source layer">
            Media, paths, full transcripts, playback history, plans, and review scheduling stay on
            this device.
          </BoundaryFact>
          <BoundaryFact icon={ShieldCheck} title="Minimum evidence envelope">
            Only the transcript window needed for an action—and an optional reduced frame—is sent
            after consent.
          </BoundaryFact>
          <BoundaryFact icon={CheckCircle2} title="Verifiable learning output">
            Explanations, chapters, notes, and questions retain timestamps back to the lecture.
          </BoundaryFact>
        </CardContent>
      </Card>
    </div>
  );
}

function EvidencePipeline({
  engineReady,
  transcriptReady,
  cloudReady,
  reviewReady,
}: {
  engineReady: boolean;
  transcriptReady: boolean;
  cloudReady: boolean;
  reviewReady: boolean;
}) {
  const stages = [
    { label: 'Private media', detail: 'Never uploaded', ready: true },
    { label: 'Timestamp evidence', detail: 'Local Whisper', ready: engineReady && transcriptReady },
    { label: 'Grounded reasoning', detail: 'Consent scoped', ready: cloudReady },
    { label: 'Durable recall', detail: 'Local review dates', ready: reviewReady },
  ];
  return (
    <Card className="overflow-hidden border-primary/20 bg-card/80" aria-label="Evidence pipeline">
      <CardContent className="p-3 sm:p-4">
        <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {stages.map((stage, index) => (
            <li
              key={stage.label}
              className="relative flex items-center gap-3 rounded-xl bg-secondary/55 p-3"
            >
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-lg text-xs font-bold ${stage.ready ? 'bg-success/12 text-success' : 'bg-muted text-muted-foreground'}`}
              >
                {stage.ready ? <CheckCircle2 className="size-4" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{stage.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{stage.detail}</span>
              </span>
              {index < stages.length - 1 ? (
                <ArrowRight className="absolute -right-3 z-10 hidden size-4 rounded-full bg-card text-muted-foreground xl:block" />
              ) : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function NextActionCard({
  pending,
  engineReady,
  bilingualReady,
  cloudReady,
  dueCount,
  model,
  installProgress,
  installPending,
  onInstall,
}: {
  pending: boolean;
  engineReady: boolean;
  bilingualReady: boolean;
  cloudReady: boolean;
  dueCount: number;
  model?: LocalModel;
  installProgress?: AnalysisProgress;
  installPending: boolean;
  onInstall: (model: LocalModel) => void;
}) {
  if (pending) {
    return (
      <Card className="featured-card">
        <CardContent className="p-5 sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">
            Next best action
          </p>
          <div className="mt-4 h-24 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        </CardContent>
      </Card>
    );
  }
  if (!engineReady) {
    return (
      <ActionCard
        icon={TriangleAlert}
        eyebrow="Local engine needs attention"
        title="Repair transcription before generating evidence"
        detail="AI answers need timestamped source material. Check the packaged Whisper and FFmpeg runtime first."
      >
        <Link to="/settings" className={primaryLinkClass}>
          Open engine diagnostics
        </Link>
      </ActionCard>
    );
  }
  if (!bilingualReady) {
    const progress = model ? modelProgress(model, installProgress) : undefined;
    return (
      <ActionCard
        icon={Download}
        eyebrow="Complete bilingual setup"
        title="Add one verified model for English and Bangla"
        detail="The multilingual Whisper model runs locally, preserves timestamps, and unlocks both language choices without uploading lecture audio."
      >
        {model ? (
          <div className="space-y-3">
            {progress !== undefined ? (
              <div className="space-y-1.5" role="status">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Verified model download</span>
                  <span>{progress}%</span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="Bilingual model download"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            ) : null}
            <Button
              onClick={() => onInstall(model)}
              disabled={installPending || model.state === 'downloading'}
            >
              <Download className="size-4" />
              {model.state === 'downloading' || installPending
                ? 'Installing bilingual model…'
                : `Install ${formatBytes(model.expected_size_bytes)} model`}
            </Button>
          </div>
        ) : (
          <Link to="/settings" className={primaryLinkClass}>
            Open model catalog
          </Link>
        )}
      </ActionCard>
    );
  }
  if (!cloudReady) {
    return (
      <ActionCard
        icon={ShieldCheck}
        eyebrow="Local evidence is ready"
        title="Connect optional reasoning when you want it"
        detail="Transcription and search already work offline. Add OpenRouter only for cited explanations, chapter analysis, frame notes, and study-set generation."
      >
        <Link to="/settings" className={primaryLinkClass}>
          Configure OpenRouter
        </Link>
        <Link to="/library" className={secondaryLinkClass}>
          Keep working locally
        </Link>
      </ActionCard>
    );
  }
  if (dueCount) {
    return (
      <ActionCard
        icon={Clock3}
        eyebrow="Memory signal"
        title={`${dueCount} grounded ${dueCount === 1 ? 'question is' : 'questions are'} ready`}
        detail="Reviewing due material now is more valuable than generating more notes. Each answer stays linked to lecture evidence."
      >
        <Link to="/" className={primaryLinkClass}>
          Start due review
        </Link>
      </ActionCard>
    );
  }
  return (
    <ActionCard
      icon={Sparkles}
      eyebrow="Stack ready"
      title="Turn the next lecture into evidence you can recall"
      detail="Index a lecture, study one scheduled block, and generate only the explanations or questions that resolve a real learning need."
    >
      <Link to="/library" className={primaryLinkClass}>
        Choose a lecture
      </Link>
      <Link to="/" className={secondaryLinkClass}>
        Resume routine
      </Link>
    </ActionCard>
  );
}

function ActionCard({
  icon: Icon,
  eyebrow,
  title,
  detail,
  children,
}: {
  icon: Icon;
  eyebrow: string;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <Card className="featured-card overflow-hidden border-primary/20">
      <div className="h-1 bg-gradient-to-r from-primary via-vermillion-400 to-amber-300" />
      <CardContent className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent text-accent-foreground shadow-sm">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">
              {eyebrow}
            </p>
            <h2 className="mt-1 font-display text-xl font-semibold tracking-tight">{title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{detail}</p>
            <div className="mt-4 flex flex-wrap gap-2">{children}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityCard({ jobs, pending }: { jobs: AnalysisJob[]; pending: boolean }) {
  const activeCount = jobs.filter((job) => activeStatuses.has(job.status)).length;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Recent local work</CardTitle>
            <CardDescription className="mt-1">
              Transcripts and verified model downloads.
            </CardDescription>
          </div>
          <Badge tone={activeCount ? 'primary' : 'neutral'}>{activeCount} active</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {pending ? (
          <div className="h-32 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        ) : jobs.length ? (
          <ul className="divide-y divide-border/70">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {job.kind === 'transcribe' ? 'Lecture transcription' : 'Model verification'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatTimestamp(job.updated_at)} · attempt {job.attempt + 1}
                  </p>
                  {job.last_error ? (
                    <p
                      className="mt-1 line-clamp-1 text-xs text-destructive"
                      title={job.last_error}
                    >
                      {job.last_error}
                    </p>
                  ) : null}
                </div>
                <Badge tone={jobTone(job.status)}>{jobLabel(job.status)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-5 text-center">
            <CheckCircle2 className="mx-auto size-5 text-success" />
            <p className="mt-2 text-sm font-medium">No background work yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              New model and transcript jobs will appear here.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReadinessCard({
  label,
  value,
  detail,
  ready,
  pending,
}: {
  label: string;
  value: string;
  detail: string;
  ready: boolean;
  pending: boolean;
}) {
  return (
    <Card className="bg-card/80">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </p>
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${pending ? 'animate-pulse bg-warning' : ready ? 'bg-success' : 'bg-queued'}`}
          />
        </div>
        <p className="mt-3 font-display text-xl font-semibold tracking-tight">{value}</p>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function WorkflowCard({
  icon: Icon,
  title,
  description,
  to,
  action,
}: {
  icon: Icon;
  title: string;
  description: string;
  to: string;
  action: string;
}) {
  return (
    <article className="flex min-h-48 flex-col rounded-xl border border-border/75 bg-background/70 p-4 shadow-sm">
      <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
        <Icon className="size-4" />
      </span>
      <h3 className="mt-4 font-display font-semibold">{title}</h3>
      <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">{description}</p>
      <Link
        to={to}
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
      >
        {action} <ArrowRight className="size-3.5" />
      </Link>
    </article>
  );
}

function ModelFact({ model }: { model: LocalModel }) {
  return (
    <div className="rounded-xl bg-secondary/55 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{model.display_name}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatBytes(model.expected_size_bytes)} · {model.architecture}
          </p>
        </div>
        <Badge tone="success">Verified</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {model.supported_languages.map((language) => (
          <Badge key={language}>{language === 'bn' ? 'বাংলা' : 'English'}</Badge>
        ))}
      </div>
    </div>
  );
}

function BoundaryFact({
  icon: Icon,
  title,
  children,
}: {
  icon: Icon;
  title: string;
  children: string;
}) {
  return (
    <div className="flex gap-3 rounded-xl bg-secondary/55 p-4">
      <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function languageReady(
  models: LocalModel[] | undefined,
  capability: Awaited<ReturnType<typeof getAnalysisCapability>> | undefined,
  language: 'en' | 'bn',
) {
  return Boolean(
    capability?.available &&
    capability.supported_languages.includes(language) &&
    models?.some(
      (model) => model.state === 'ready' && model.supported_languages.includes(language),
    ),
  );
}

function transcriptionReadinessDetail(
  capability: Awaited<ReturnType<typeof getAnalysisCapability>> | undefined,
  englishReady: boolean,
  banglaReady: boolean,
) {
  if (!capability) return 'Install the local engine and a verified model in Settings';
  if (!capability.available) return capability.message;
  if (englishReady && !banglaReady)
    return 'English is ready. Add the multilingual model for Bangla.';
  if (!englishReady && banglaReady) return 'Bangla is ready. Add an English-compatible model.';
  return 'The local engine is ready. Install a verified transcription model.';
}

function activeJobInterval(query: { state: { data?: AnalysisJob[] } }) {
  return query.state.data?.some((job) => activeStatuses.has(job.status)) ? 1_500 : false;
}

function modelProgress(model: LocalModel, event?: AnalysisProgress) {
  if (event?.event === 'downloading') {
    return Math.min(100, Math.round((event.data.downloadedBytes / event.data.totalBytes) * 100));
  }
  if (model.state === 'downloading' && model.expected_size_bytes > 0) {
    return Math.min(100, Math.round((model.bytes_downloaded / model.expected_size_bytes) * 100));
  }
  return undefined;
}

function jobLabel(status: AnalysisJob['status']) {
  const labels: Record<AnalysisJob['status'], string> = {
    queued: 'Queued',
    running: 'Running',
    paused: 'Paused',
    retry_wait: 'Retrying',
    completed: 'Complete',
    failed: 'Needs help',
    cancelled: 'Cancelled',
  };
  return labels[status];
}

function jobTone(
  status: AnalysisJob['status'],
): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (activeStatuses.has(status)) return status === 'retry_wait' ? 'warning' : 'primary';
  return 'neutral';
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function messageFrom(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'The requested AI operation could not be started.';
}

const primaryLinkClass =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-primary/10 bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90';
const secondaryLinkClass =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-semibold shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground';
