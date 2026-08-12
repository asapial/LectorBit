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
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-card/55 px-5 py-12 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] sm:px-8 sm:py-16',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="grid size-12 place-items-center rounded-2xl border border-primary/10 bg-accent text-accent-foreground shadow-sm"
      >
        <FolderPlus className="size-5" strokeWidth={1.75} />
      </div>
      <h3 className="font-display text-lg font-semibold tracking-tight">{title}</h3>
      {description ? (
        <p className="max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
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
      className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
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
