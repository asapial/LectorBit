import type { ReactNode } from 'react';
import FolderPlus from 'lucide-react/dist/esm/icons/folder-plus';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { cn } from '../../lib/cn';

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card/50 px-6 py-12 text-center',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground"
      >
        <FolderPlus className="size-5" strokeWidth={1.75} />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorPanel({
  title = 'Something went wrong',
  error,
  onRetry,
}: {
  title?: string;
  error: unknown;
  onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
    >
      <div className="flex items-center gap-2 font-semibold">
        <TriangleAlert aria-hidden="true" className="size-4" />
        {title}
      </div>
      <div className="mt-1 pl-6 text-destructive/80">{message}</div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium hover:bg-destructive/10"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          Retry
        </button>
      ) : null}
    </div>
  );
}
