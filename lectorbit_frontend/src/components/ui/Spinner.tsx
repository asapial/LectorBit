import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export function Spinner({
  className,
  label = 'Loading',
  ...rest
}: HTMLAttributes<HTMLDivElement> & { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('inline-flex items-center gap-2 text-sm text-muted-foreground', className)}
      {...rest}
    >
      <span className="relative inline-flex h-4 w-4">
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/40" />
        <span className="absolute inset-0.5 animate-pulse rounded-full bg-primary" />
      </span>
      <span>{label}</span>
    </div>
  );
}