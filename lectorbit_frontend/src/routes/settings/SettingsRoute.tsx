import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Cpu from 'lucide-react/dist/esm/icons/cpu';
import Download from 'lucide-react/dist/esm/icons/download';
import HardDrive from 'lucide-react/dist/esm/icons/hard-drive';
import Eye from 'lucide-react/dist/esm/icons/eye';
import EyeOff from 'lucide-react/dist/esm/icons/eye-off';
import KeyRound from 'lucide-react/dist/esm/icons/key-round';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
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
import { StatusBadge, type StatusKind } from '../../components/ui/StatusBadge';
import {
  installModel,
  listAnalysisJobs,
  listModels,
  removeModel,
  type AnalysisProgress,
  type LocalModel,
} from '../../ipc/analysis';
import { getCloudPlanningStatus, removeOpenRouterKey, saveOpenRouterKey } from '../../ipc/planner';
import {
  checkForUpdates,
  installUpdate,
  type UpdateCheck,
  type UpdateProgress,
} from '../../ipc/updates';

export function SettingsRoute() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string>();
  const [progress, setProgress] = useState<Record<string, AnalysisProgress>>({});
  const [removeTarget, setRemoveTarget] = useState<LocalModel>();
  const [update, setUpdate] = useState<UpdateCheck>();
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>();
  const [openRouterKey, setOpenRouterKey] = useState('');
  const [showOpenRouterKey, setShowOpenRouterKey] = useState(false);
  const models = useQuery({
    queryKey: ['analysis', 'models'] as const,
    queryFn: listModels,
    refetchInterval: (query) =>
      query.state.data?.some((model) => model.state === 'downloading') ? 1_500 : false,
  });
  const jobs = useQuery({
    queryKey: ['analysis', 'model-jobs'] as const,
    queryFn: () => listAnalysisJobs('model_download'),
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === 'queued' || job.status === 'running')
        ? 1_500
        : false,
  });
  const cloudPlanning = useQuery({
    queryKey: ['cloud-planning', 'status'] as const,
    queryFn: getCloudPlanningStatus,
  });
  const saveCloudKey = useMutation({
    mutationFn: saveOpenRouterKey,
    onSuccess: () => {
      setNotice('OpenRouter key saved in your operating system credential vault.');
      void queryClient.invalidateQueries({ queryKey: ['cloud-planning'] });
    },
    onError: (error) => setNotice(messageFrom(error)),
    onSettled: () => setOpenRouterKey(''),
  });
  const removeCloudKey = useMutation({
    mutationFn: removeOpenRouterKey,
    onSuccess: () => {
      setNotice('OpenRouter key removed from the credential vault.');
      void queryClient.invalidateQueries({ queryKey: ['cloud-planning'] });
    },
    onError: (error) => setNotice(messageFrom(error)),
  });

  const install = useMutation({
    mutationFn: (modelId: string) =>
      installModel(modelId, (event) => {
        setProgress((current) => ({ ...current, [modelId]: event }));
        if (event.event === 'completed' || event.event === 'failed') {
          void queryClient.invalidateQueries({ queryKey: ['analysis'] });
        }
      }),
    onSuccess: () => {
      setNotice('Model download queued. It will resume automatically after a restart.');
      void queryClient.invalidateQueries({ queryKey: ['analysis'] });
    },
    onError: (error) => setNotice(messageFrom(error)),
  });

  const remove = useMutation({
    mutationFn: removeModel,
    onSuccess: () => {
      setNotice('Model removed. Existing transcripts remain searchable.');
      setRemoveTarget(undefined);
      void queryClient.invalidateQueries({ queryKey: ['analysis'] });
    },
    onError: (error) => setNotice(messageFrom(error)),
  });

  const activeJobs = useMemo(
    () =>
      jobs.data?.filter((job) => job.status === 'queued' || job.status === 'running').length ?? 0,
    [jobs.data],
  );
  const updateCheck = useMutation({
    mutationFn: checkForUpdates,
    onSuccess: (result) => {
      setUpdate(result);
      setNotice(
        result.status === 'available'
          ? `LectorBit ${result.version} is available.`
          : result.status === 'current'
            ? 'LectorBit is up to date.'
            : 'Signed updates are disabled in this development build.',
      );
    },
    onError: (error) => setNotice(messageFrom(error)),
  });
  const updateInstall = useMutation({
    mutationFn: (version: string) => installUpdate(version, (event) => setUpdateProgress(event)),
    onError: (error) => setNotice(messageFrom(error)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="AI and app services"
        description="Manage verified local models and optional, explicitly authorized cloud planning."
      />

      {notice ? (
        <div
          className="rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-sm"
          role="status"
        >
          {notice}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Transcription models</CardTitle>
              <CardDescription className="mt-1">
                Downloads are resumable, size-checked, and SHA-256 verified before use.
              </CardDescription>
            </div>
            <span className="rounded-md bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
              {activeJobs} active
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {models.isPending ? (
            <div className="h-36 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          ) : null}
          {models.isError ? (
            <div
              className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4"
              role="alert"
            >
              <TriangleAlert className="mt-0.5 size-5 text-destructive" />
              <div>
                <p className="text-sm font-medium">Models could not be loaded</p>
                <Button
                  className="mt-3"
                  variant="outline"
                  size="sm"
                  onClick={() => void models.refetch()}
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : null}
          <div className="divide-y divide-border">
            {models.data?.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                event={progress[model.id]}
                pendingInstall={install.isPending && install.variables === model.id}
                pendingRemove={remove.isPending && remove.variables === model.id}
                onInstall={() => install.mutate(model.id)}
                onRemove={() => setRemoveTarget(model)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="ai-studio-card overflow-hidden border-primary/20">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>OpenRouter planning suggestions</CardTitle>
              <CardDescription className="mt-1">
                Optional AI can propose a course order and explain why. Rust still validates every
                hard scheduling constraint before a plan can be committed.
              </CardDescription>
            </div>
            <Badge tone={cloudPlanning.data?.configured ? 'success' : 'neutral'}>
              <KeyRound className="size-3.5" />
              {cloudPlanning.data?.configured ? 'Key protected' : 'Not configured'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-primary/20 bg-accent/35 p-4 text-sm">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="font-medium">Protected by your operating system</p>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  The key is sent once through the private Tauri bridge and stored in Credential
                  Manager, Keychain, or Secret Service. It is never written to SQLite, logs, browser
                  storage, or returned to this screen.
                </p>
              </div>
            </div>
          </div>
          <form
            className="flex flex-col gap-3 md:flex-row md:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              saveCloudKey.mutate(openRouterKey);
            }}
          >
            <label
              className="min-w-0 flex-1 space-y-1.5 text-sm font-medium"
              htmlFor="openrouter-key"
            >
              {cloudPlanning.data?.configured ? 'Replace API key' : 'OpenRouter API key'}
              <span className="relative block">
                <input
                  id="openrouter-key"
                  type={showOpenRouterKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  spellCheck={false}
                  value={openRouterKey}
                  onChange={(event) => setOpenRouterKey(event.target.value)}
                  placeholder="sk-or-v1-…"
                  className="form-control pr-11 font-mono"
                />
                <button
                  type="button"
                  className="absolute right-1 top-1 grid size-8 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={showOpenRouterKey ? 'Hide API key' : 'Show API key'}
                  onClick={() => setShowOpenRouterKey((current) => !current)}
                >
                  {showOpenRouterKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </span>
            </label>
            <Button
              type="submit"
              disabled={saveCloudKey.isPending || openRouterKey.trim().length < 20}
            >
              {saveCloudKey.isPending ? 'Securing…' : 'Save securely'}
            </Button>
            {cloudPlanning.data?.configured ? (
              <Button
                type="button"
                variant="outline"
                disabled={removeCloudKey.isPending}
                onClick={() => removeCloudKey.mutate()}
              >
                {removeCloudKey.isPending ? 'Removing…' : 'Remove key'}
              </Button>
            ) : null}
          </form>
          <p className="text-xs leading-relaxed text-muted-foreground">
            AI requests contain selected video names, durations, and planning limits only. Media,
            transcripts, absolute paths, and viewing history are excluded. Every request requires
            fresh confirmation in Plan Builder. Free model providers may retain or use request
            metadata under their own policies, so avoid sensitive information in video names.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>App updates</CardTitle>
              <CardDescription className="mt-1">
                Checks happen only when you ask. Every public update must pass signature
                verification before installation.
              </CardDescription>
            </div>
            <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <UpdateSummary update={update} progress={updateProgress} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={updateCheck.isPending || updateInstall.isPending}
              onClick={() => updateCheck.mutate()}
              leftIcon={
                <RefreshCw
                  className={
                    updateCheck.isPending
                      ? 'size-4 animate-spin motion-reduce:animate-none'
                      : 'size-4'
                  }
                />
              }
            >
              {updateCheck.isPending ? 'Checking…' : 'Check for updates'}
            </Button>
            {update?.status === 'available' && update.version ? (
              <Button
                disabled={updateInstall.isPending}
                onClick={() => updateInstall.mutate(update.version!)}
              >
                {updateInstall.isPending ? 'Installing…' : `Install ${update.version}`}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Privacy boundary</CardTitle>
          <CardDescription>
            Local analysis is optional enrichment, never a planning dependency.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
          <PrivacyFact icon={<Cpu className="size-4" />} label="Runs through local whisper.cpp" />
          <PrivacyFact
            icon={<HardDrive className="size-4" />}
            label="Stores timestamp text in SQLite"
          />
          <PrivacyFact
            icon={<CheckCircle2 className="size-4" />}
            label="Media bytes never leave this device"
          />
        </CardContent>
      </Card>

      {removeTarget ? (
        <div
          className="fixed inset-0 z-50 grid place-items-end bg-stone-950/60 p-3 backdrop-blur-[2px] sm:place-items-center sm:px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-model-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-2xl sm:p-6">
            <h2 id="remove-model-title" className="font-display text-lg font-semibold">
              Remove local model?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This removes {removeTarget.id} from disk. Existing transcript text remains searchable.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => setRemoveTarget(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(removeTarget.id)}
              >
                {remove.isPending ? 'Removing…' : 'Remove model'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UpdateSummary({ update, progress }: { update?: UpdateCheck; progress?: UpdateProgress }) {
  if (progress?.event === 'downloading') {
    const percentage = progress.data.totalBytes
      ? Math.min(100, Math.round((progress.data.downloadedBytes / progress.data.totalBytes) * 100))
      : undefined;
    return (
      <div className="space-y-2" role="status">
        <StatusBadge status="processing" />
        <p className="text-sm text-muted-foreground">
          Downloading verified update{percentage === undefined ? '…' : ` — ${percentage}%`}
        </p>
        {percentage !== undefined ? (
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Update download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${percentage}%` }}
            />
          </div>
        ) : null}
      </div>
    );
  }
  if (progress?.event === 'installing' || progress?.event === 'relaunching') {
    return (
      <div className="flex items-center gap-3" role="status">
        <StatusBadge status="processing" />
        <p className="text-sm text-muted-foreground">
          {progress.event === 'installing'
            ? 'Installing verified update…'
            : 'Relaunching LectorBit…'}
        </p>
      </div>
    );
  }
  if (!update)
    return (
      <p className="text-sm text-muted-foreground">Current version status has not been checked.</p>
    );
  if (update.status === 'disabled')
    return (
      <div className="flex items-center gap-3">
        <StatusBadge status="attention" />
        <p className="text-sm text-muted-foreground">
          Development build — no release endpoint or public key is embedded.
        </p>
      </div>
    );
  if (update.status === 'current')
    return (
      <div className="flex items-center gap-3">
        <StatusBadge status="completed" />
        <p className="text-sm text-muted-foreground">
          Version {update.current_version} is current.
        </p>
      </div>
    );
  return (
    <div className="rounded-lg border border-primary/25 bg-accent/45 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status="attention" />
        <p className="font-medium">Version {update.version} is ready</p>
      </div>
      {update.notes ? (
        <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{update.notes}</p>
      ) : null}
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        Signed for {update.target ?? 'this platform'}
      </p>
    </div>
  );
}

function ModelRow({
  model,
  event,
  pendingInstall,
  pendingRemove,
  onInstall,
  onRemove,
}: {
  model: LocalModel;
  event?: AnalysisProgress;
  pendingInstall: boolean;
  pendingRemove: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const state = modelState(model, event);
  const percentage =
    event?.event === 'downloading'
      ? Math.min(100, Math.round((event.data.downloadedBytes / event.data.totalBytes) * 100))
      : model.state === 'downloading' && model.expected_size_bytes > 0
        ? Math.min(100, Math.round((model.bytes_downloaded / model.expected_size_bytes) * 100))
        : undefined;
  return (
    <div className="grid gap-4 py-5 first:pt-1 last:pb-1 md:grid-cols-[minmax(0,1fr)_14rem_auto] md:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">Whisper base English</p>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {model.analyzer_compatibility}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatBytes(model.expected_size_bytes)} · {model.provider} · {model.architecture}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{model.license}</p>
      </div>
      <div className="space-y-2">
        <StatusBadge status={state.kind} />
        <p className="text-xs text-muted-foreground">{state.label}</p>
        {percentage !== undefined ? (
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Model download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${percentage}%` }}
            />
          </div>
        ) : null}
      </div>
      {model.state === 'ready' ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pendingRemove}
          onClick={onRemove}
          leftIcon={<Trash2 className="size-4" />}
        >
          Remove
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={pendingInstall || model.state === 'downloading'}
          onClick={onInstall}
          leftIcon={<Download className="size-4" />}
        >
          {model.state === 'failed'
            ? 'Try again'
            : model.state === 'downloading'
              ? 'Downloading…'
              : 'Install'}
        </Button>
      )}
    </div>
  );
}

function modelState(
  model: LocalModel,
  event?: AnalysisProgress,
): { kind: StatusKind; label: string } {
  if (event?.event === 'completed') return { kind: 'completed', label: 'Verified and ready' };
  if (event?.event === 'failed') return { kind: 'failed', label: event.data.message };
  if (event && ['queued', 'downloading'].includes(event.event))
    return {
      kind: event.event === 'queued' ? 'queued' : 'processing',
      label: event.event === 'queued' ? 'Waiting for download worker' : 'Downloading and verifying',
    };
  switch (model.state) {
    case 'ready':
      return {
        kind: 'completed',
        label: model.verified_at
          ? `Verified ${formatDate(model.verified_at)}`
          : 'Verified and ready',
      };
    case 'downloading':
      return { kind: 'processing', label: 'Download will resume if interrupted' };
    case 'failed':
      return { kind: 'failed', label: model.last_error ?? 'Verification did not complete' };
    default:
      return { kind: 'queued', label: 'Not installed' };
  }
}

function PrivacyFact({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'locally' : date.toLocaleDateString();
}
function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : 'The operation could not continue.';
}
