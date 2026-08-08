import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAppVersion } from '../../ipc/app';
import { PageHeader } from '../../components/layout/PageHeader';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { ErrorPanel } from '../../components/feedback/EmptyState';
import { Badge } from '../../components/ui/Badge';

export function AboutRoute() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['app', 'version'],
    queryFn: getAppVersion,
    retry: false,
  });

  return (
    <>
      <PageHeader
        eyebrow="About"
        title="LectorBit"
        description="An offline-first AI video study planner. Built on Tauri 2 + Rust + SQLite."
        actions={<Badge tone="primary">v{data?.version ?? '…'}</Badge>}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Build</CardTitle>
            <CardDescription>Renderer-reported backend identity.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Spinner label="Reading app identity…" />
            ) : error ? (
              <ErrorPanel
                title="IPC bridge unavailable"
                error={error}
                onRetry={() => void refetch()}
              />
            ) : (
              <dl className="grid grid-cols-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Version</dt>
                <dd className="col-span-2 font-mono">{data?.version}</dd>
                <dt className="text-muted-foreground">Build</dt>
                <dd className="col-span-2 font-mono">{data?.build}</dd>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What this app does</CardTitle>
            <CardDescription>The plan-owning core. AI only enriches.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="ml-5 list-disc space-y-1 text-sm text-muted-foreground">
              <li>Imports folders you authorize.</li>
              <li>Plans from your constraints — never LLM arithmetic.</li>
              <li>Tracks playback progress with durable checkpoints.</li>
              <li>Replans from real study actions, not intentions.</li>
            </ul>
            <div className="mt-4">
              <Link
                to="/diagnostics"
                className="text-sm font-medium text-primary hover:underline"
              >
                Open diagnostics panel →
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}