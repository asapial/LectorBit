import { useQuery } from '@tanstack/react-query';
import Activity from 'lucide-react/dist/esm/icons/activity';
import { Link } from 'react-router';
import { listAnalysisJobs } from '../../ipc/analysis';

const active = new Set(['queued', 'running', 'paused', 'retry_wait']);

export function JobIndicator() {
  const jobs = useQuery({
    queryKey: ['analysis', 'global-job-indicator'] as const,
    queryFn: async () => {
      const [models, transcripts] = await Promise.all([
        listAnalysisJobs('model_download'),
        listAnalysisJobs('transcribe'),
      ]);
      return [...models, ...transcripts];
    },
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((job) => active.has(job.status)) ? 1_500 : 15_000,
  });
  const activeCount = jobs.data?.filter((job) => active.has(job.status)).length ?? 0;
  const failedCount = jobs.data?.filter((job) => job.status === 'failed').length ?? 0;
  return (
    <Link
      to="/ai"
      aria-label={
        activeCount
          ? `${activeCount} AI jobs active`
          : failedCount
            ? `${failedCount} AI jobs need attention`
            : 'AI jobs'
      }
      title={
        activeCount
          ? `${activeCount} active`
          : failedCount
            ? `${failedCount} need attention`
            : 'AI jobs idle'
      }
      className="relative grid size-10 place-items-center rounded-xl text-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground sm:size-9"
    >
      <Activity
        className={
          activeCount ? 'size-4 animate-pulse motion-reduce:animate-none text-primary' : 'size-4'
        }
      />
      {activeCount || failedCount ? (
        <span
          className={
            activeCount
              ? 'absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground'
              : 'absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground'
          }
        >
          {activeCount || failedCount}
        </span>
      ) : null}
    </Link>
  );
}
