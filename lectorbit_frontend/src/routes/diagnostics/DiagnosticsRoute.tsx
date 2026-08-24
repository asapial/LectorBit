import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Copy from 'lucide-react/dist/esm/icons/copy';
import { getDiagnostics, type DiagnosticsReport } from '../../ipc/diagnostics';
import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState } from '../../components/feedback/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

export function DiagnosticsRoute() {
  const [copyStatus, setCopyStatus] = useState<string>();
  const query = useQuery({
    queryKey: ['diagnostics'],
    queryFn: getDiagnostics,
    // Diagnostics are cheap; refetch on focus so the page feels alive.
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Diagnostics"
        description="A redacted snapshot of the running app. Safe to share when filing a bug."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void query.refetch()}>
              Refresh
            </Button>
            <Button
              variant="outline"
              disabled={!query.data}
              onClick={() => {
                if (!query.data) return;
                void navigator.clipboard.writeText(JSON.stringify(query.data, null, 2)).then(
                  () => setCopyStatus('Redacted diagnostics copied.'),
                  () => setCopyStatus('Clipboard access was denied.'),
                );
              }}
            >
              <Copy className="size-4" /> Copy snapshot
            </Button>
          </div>
        }
      />

      {copyStatus ? (
        <p className="rounded-lg border bg-card px-4 py-3 text-sm" role="status">
          {copyStatus}
        </p>
      ) : null}

      {query.isPending && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> Collecting diagnostics…
        </div>
      )}

      {query.isError && (
        <EmptyState title="Diagnostics unavailable" description={String(query.error)} />
      )}

      {query.data && <DiagnosticsPanel report={query.data} />}
    </div>
  );
}

function DiagnosticsPanel({ report }: { report: DiagnosticsReport }) {
  const healthIssues = [
    !report.database.foreign_keys ? 'Database foreign keys are disabled' : null,
    !report.ai.whisper_model_present ? 'No verified Whisper model is installed' : null,
    report.recent_errors.length ? `${report.recent_errors.length} recent errors need review` : null,
  ].filter(Boolean);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="md:col-span-2">
        <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-display text-lg font-semibold">System health</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {healthIssues.length
                ? healthIssues.join(' · ')
                : 'Core local services report a healthy snapshot.'}
            </p>
          </div>
          <Badge tone={healthIssues.length ? 'warning' : 'success'}>
            {healthIssues.length ? `${healthIssues.length} need attention` : 'Healthy'}
          </Badge>
        </CardContent>
      </Card>
      <KpiCard
        title="App"
        rows={[
          { label: 'Version', value: report.app.version },
          { label: 'Build', value: report.app.build },
          { label: 'Target', value: report.app.target_triple },
          {
            label: 'Running for',
            value: formatDuration(report.app.elapsed_since_launch),
          },
        ]}
      />

      <KpiCard
        title="Database"
        rows={[
          { label: 'Schema version', value: String(report.database.schema_version) },
          {
            label: 'Migrations applied',
            value: String(report.database.migrations_applied),
          },
          { label: 'SQLite', value: report.database.sqlite_version },
          { label: 'Journal mode', value: report.database.journal_mode.toUpperCase() },
          {
            label: 'Foreign keys',
            value: report.database.foreign_keys ? 'ON' : 'OFF',
            tone: report.database.foreign_keys ? 'success' : 'danger',
          },
          {
            label: 'Size',
            value:
              report.database.size_bytes != null ? formatBytes(report.database.size_bytes) : '—',
          },
          {
            label: 'Path',
            value: report.database.path_redacted ?? '—',
            mono: true,
          },
        ]}
      />

      <KpiCard
        title="Library"
        rows={[
          {
            label: 'Registered roots',
            value: String(report.library.root_count),
          },
          {
            label: 'Active roots',
            value: String(report.library.active_root_count),
          },
          {
            label: 'Media files',
            value: String(report.library.media_count),
          },
        ]}
      />

      <KpiCard
        title="AI models"
        rows={[
          {
            label: 'Whisper',
            value: report.ai.whisper_model_present ? 'present' : 'missing',
            tone: report.ai.whisper_model_present ? 'success' : 'neutral',
          },
          {
            label: 'OCR',
            value: report.ai.ocr_model_present ? 'present' : 'missing',
            tone: report.ai.ocr_model_present ? 'success' : 'neutral',
          },
          {
            label: 'Embeddings',
            value: report.ai.embeddings_model_present ? 'present' : 'missing',
            tone: report.ai.embeddings_model_present ? 'success' : 'neutral',
          },
          {
            label: 'Last consent',
            value: report.ai.last_consent ?? '—',
          },
        ]}
      />

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Recent errors</CardTitle>
          <CardDescription>
            Last five error rows from the audit log. Already redacted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {report.recent_errors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No errors recorded.</p>
          ) : (
            <ul className="space-y-2 font-mono text-xs">
              {report.recent_errors.map((entry, i) => (
                <li key={i} className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  {entry}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    label: string;
    value: string;
    tone?: 'success' | 'danger' | 'neutral';
    mono?: boolean;
  }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-0.5 text-sm">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex flex-col gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-muted/45 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
            >
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="flex min-w-0 items-center gap-2 sm:justify-end sm:text-right">
                {row.tone && (
                  <Badge tone={row.tone} className="text-[10px]">
                    {row.tone === 'success' ? 'ok' : row.tone === 'danger' ? 'fail' : '—'}
                  </Badge>
                )}
                <span className={row.mono ? 'break-all font-mono text-xs' : undefined}>
                  {row.value}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function formatDuration(d: { secs: number; nanos: number } | null): string {
  if (!d) return '—';
  const total = d.secs;
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
