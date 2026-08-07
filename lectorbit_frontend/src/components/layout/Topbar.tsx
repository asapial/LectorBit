import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { getAppVersion } from '../../ipc/app';
import { Badge } from '../ui/Badge';

export function Topbar() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['app', 'version'],
    queryFn: getAppVersion,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <header className="flex h-(--topbar-height) shrink-0 items-center justify-between border-b border-border bg-background/70 px-5 backdrop-blur">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold tracking-tight">LectorBit</h1>
        <Badge tone="primary" className="hidden sm:inline-flex">
          Local-first
        </Badge>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {isLoading ? (
          <span>Checking backend…</span>
        ) : error ? (
          <Badge tone="warning" title="Running in browser-only fallback">
            Browser fallback
          </Badge>
        ) : (
          <span>
            v{data?.version ?? '?'}
            {data?.build && data.build !== 'dev' ? ` · ${data.build}` : ''}
          </span>
        )}
        <Link
          to="/about"
          className="rounded-md px-2 py-1 text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          About
        </Link>
      </div>
    </header>
  );
}