import { useQuery } from '@tanstack/react-query';
import ArrowRight from 'lucide-react/dist/esm/icons/arrow-right';
import BookOpen from 'lucide-react/dist/esm/icons/book-open';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import LibraryBig from 'lucide-react/dist/esm/icons/library-big';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import Search from 'lucide-react/dist/esm/icons/search';
import Settings2 from 'lucide-react/dist/esm/icons/settings-2';
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import type { ComponentType, SVGProps } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../../components/layout/PageHeader';
import { Badge } from '../../components/ui/Badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/Card';
import { getAnalysisCapability, listAnalysisJobs, listModels } from '../../ipc/analysis';
import { getCloudPlanningStatus } from '../../ipc/planner';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export function AiStudioRoute() {
  const models = useQuery({
    queryKey: ['analysis', 'models'],
    queryFn: listModels,
    retry: false,
  });
  const analysisCapability = useQuery({
    queryKey: ['analysis', 'capability'],
    queryFn: getAnalysisCapability,
    retry: false,
  });
  const cloud = useQuery({
    queryKey: ['cloud-planning', 'status'],
    queryFn: getCloudPlanningStatus,
    retry: false,
  });
  const transcriptionJobs = useQuery({
    queryKey: ['analysis', 'jobs', 'transcribe'],
    queryFn: () => listAnalysisJobs('transcribe'),
    retry: false,
  });

  const engineReady = analysisCapability.data?.available === true;
  const englishReady =
    engineReady &&
    analysisCapability.data?.supported_languages.includes('en') === true &&
    (models.data?.some(
      (model) => model.state === 'ready' && model.supported_languages.includes('en'),
    ) ??
      false);
  const banglaReady =
    engineReady &&
    analysisCapability.data?.supported_languages.includes('bn') === true &&
    (models.data?.some(
      (model) => model.state === 'ready' && model.supported_languages.includes('bn'),
    ) ??
      false);
  const whisperReady = englishReady && banglaReady;
  const activeJobs =
    transcriptionJobs.data?.filter((job) =>
      ['queued', 'running', 'paused', 'retry_wait'].includes(job.status),
    ).length ?? 0;
  const statusUnavailable =
    models.isError || analysisCapability.isError || cloud.isError || transcriptionJobs.isError;
  const transcriptionPending = models.isPending || analysisCapability.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Intelligence layer"
        title="AI Studio"
        description="One place to understand readiness, launch the right workflow, and see which capabilities are available now versus still on the roadmap."
        actions={
          <Link to="/settings" className={secondaryLinkClass}>
            <Settings2 className="size-4" /> Configure AI
          </Link>
        }
      />

      <section className="grid gap-3 md:grid-cols-3" aria-label="AI readiness">
        <ReadinessCard
          label="Local transcription"
          value={transcriptionPending ? 'Checking…' : whisperReady ? 'Ready' : 'Setup needed'}
          detail={
            whisperReady
              ? 'English and Bangla transcription engine ready'
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
              : 'Add an OpenRouter key only if you want cloud features'
          }
          ready={Boolean(cloud.data?.configured)}
          pending={cloud.isPending}
        />
        <ReadinessCard
          label="Background work"
          value={
            transcriptionJobs.isPending ? 'Checking…' : activeJobs ? `${activeJobs} active` : 'Idle'
          }
          detail="Transcription jobs recover after an app restart"
          ready={!activeJobs && !transcriptionJobs.isPending}
          pending={transcriptionJobs.isPending}
        />
      </section>

      {statusUnavailable ? (
        <p
          className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm text-muted-foreground"
          role="status"
        >
          Live AI status is unavailable in this preview. The workflows below remain accurate, and no
          settings were changed.
        </p>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <Card className="ai-studio-card overflow-hidden border-primary/20">
          <div className="h-1 bg-gradient-to-r from-primary via-vermillion-400 to-amber-300" />
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Sparkles className="size-5 text-primary" /> Available now
                </CardTitle>
                <CardDescription className="mt-1 max-w-2xl leading-6">
                  AI enriches evidence and suggestions. Rust remains the authority for schedules,
                  progress, validation, and review dates.
                </CardDescription>
              </div>
              <Badge tone="success">
                <ShieldCheck className="size-3.5" /> Grounded by design
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <WorkflowCard
              icon={LibraryBig}
              title="Transcribe locally"
              description="Import lectures, create timestamped transcripts with Whisper, and make every spoken phrase searchable."
              to="/library"
              action="Open Library"
            />
            <WorkflowCard
              icon={BookOpen}
              title="Learn with evidence"
              description="Inside the Player, build cited chapters, explain a frame, ask the companion, and generate review material."
              to="/"
              action="Choose a study block"
            />
            <WorkflowCard
              icon={ListChecks}
              title="Plan with guardrails"
              description="Translate a natural-language routine or suggest prerequisite order without giving AI control of feasibility."
              to="/plan"
              action="Open Plan Builder"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Trust boundary</CardTitle>
            <CardDescription>What stays local and what requires a clear decision.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <BoundaryFact icon={CheckCircle2} title="Always local">
              Media files, paths, playback history, plan math, progress, and review scheduling.
            </BoundaryFact>
            <BoundaryFact icon={ShieldCheck} title="Per-request consent">
              Planning metadata, transcript evidence, or a reduced current frame sent to your
              configured provider.
            </BoundaryFact>
            <BoundaryFact icon={Clock3} title="Durable results">
              Transcripts, grounded artifacts, study items, and review state are versioned in
              SQLite.
            </BoundaryFact>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="roadmap-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="roadmap-heading" className="font-display text-lg font-semibold">
              Next intelligence layers
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These are intentionally labelled as roadmap until their models, evaluation sets, and
              privacy paths are complete.
            </p>
          </div>
          <Badge tone="neutral">Planned</Badge>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <RoadmapCard
            icon={BookOpen}
            title="Slide and formula OCR"
            description="Scene-selected frames merged with transcript timestamps—not a wasteful full-video scan."
          />
          <RoadmapCard
            icon={Search}
            title="Hybrid semantic search"
            description="Local embeddings plus FTS, filters, and timestamp evidence across the entire library."
          />
          <RoadmapCard
            icon={Sparkles}
            title="Adaptive mastery coach"
            description="Targeted practice from review history while deterministic rules continue to own due dates."
          />
        </div>
      </section>
    </div>
  );
}

function transcriptionReadinessDetail(
  capability: Awaited<ReturnType<typeof getAnalysisCapability>> | undefined,
  englishReady: boolean,
  banglaReady: boolean,
) {
  if (!capability) return 'Install the local engine and a model in Settings';
  if (!capability.available) return capability.message;
  if (englishReady && !banglaReady) {
    return 'English is ready. Install the multilingual Whisper model for Bangla.';
  }
  if (!englishReady && banglaReady) {
    return 'Bangla is ready. Install an English-compatible Whisper model for English.';
  }
  return 'The local engine is ready. Install a verified transcription model in Settings.';
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
    <article className="flex min-h-56 flex-col rounded-xl border border-border/75 bg-background/70 p-4 shadow-sm">
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
    <div className="flex gap-3 rounded-xl bg-secondary/55 p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function RoadmapCard({
  icon: Icon,
  title,
  description,
}: {
  icon: Icon;
  title: string;
  description: string;
}) {
  return (
    <Card className="border-dashed bg-card/65">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <div>
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const secondaryLinkClass =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-semibold shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground';
