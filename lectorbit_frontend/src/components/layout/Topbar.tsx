import { useQuery } from '@tanstack/react-query';
import CircleHelp from 'lucide-react/dist/esm/icons/circle-help';
import Moon from 'lucide-react/dist/esm/icons/moon';
import Sun from 'lucide-react/dist/esm/icons/sun';
import { Link } from 'react-router';
import { useTheme } from '../../app/ThemeProvider';
import { getAppVersion } from '../../ipc/app';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

export function Topbar() {
  const { resolvedTheme, toggleTheme } = useTheme();
  const { data, isLoading, error } = useQuery({
    queryKey: ['app', 'version'],
    queryFn: getAppVersion,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <header className="flex h-(--topbar-height) shrink-0 items-center justify-between border-b border-border bg-background/90 px-5 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="truncate font-display text-sm font-semibold tracking-tight">
          LectorBit
        </h1>
        <Badge tone="primary" className="hidden sm:inline-flex">
          Local-first
        </Badge>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {isLoading ? (
          <span className="hidden sm:inline">Checking backend…</span>
        ) : error ? (
          <Badge tone="warning" title="Running in browser-only fallback">
            Browser fallback
          </Badge>
        ) : (
          <span className="hidden font-mono sm:inline">
            v{data?.version ?? '?'}
            {data?.build && data.build !== 'dev' ? ` · ${data.build}` : ''}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={`Use ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Use ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {resolvedTheme === 'dark' ? (
            <Sun aria-hidden="true" className="size-4" />
          ) : (
            <Moon aria-hidden="true" className="size-4" />
          )}
        </Button>
        <Link
          to="/about"
          aria-label="About LectorBit"
          className="grid size-9 place-items-center rounded-md text-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-accent-foreground"
        >
          <CircleHelp aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </header>
  );
}
