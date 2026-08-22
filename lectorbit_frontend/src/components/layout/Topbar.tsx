import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import CircleHelp from 'lucide-react/dist/esm/icons/circle-help';
import Moon from 'lucide-react/dist/esm/icons/moon';
import Sun from 'lucide-react/dist/esm/icons/sun';
import Search from 'lucide-react/dist/esm/icons/search';
import { Link, useLocation } from 'react-router';
import { useTheme } from '../../app/ThemeProvider';
import { getAppVersion } from '../../ipc/app';
import { BrandLogo } from '../brand/BrandLogo';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

export function Topbar() {
  const location = useLocation();
  const currentPage = pageLabel(location.pathname);
  const { resolvedTheme, toggleTheme } = useTheme();
  const { data, isLoading, error } = useQuery({
    queryKey: ['app', 'version'],
    queryFn: getAppVersion,
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    document.title = `${currentPage} — LectorBit`;
  }, [currentPage]);

  return (
    <header className="flex h-(--topbar-height) shrink-0 items-center justify-between border-b border-border/80 bg-background/80 px-4 backdrop-blur-xl sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <BrandLogo className="size-8 drop-shadow-sm min-[1180px]:hidden" />
        <div className="min-w-0">
          <p className="hidden text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground sm:block min-[1180px]:hidden">
            LectorBit
          </p>
          <p className="truncate font-display text-sm font-semibold tracking-tight">
            {currentPage}
          </p>
        </div>
        <span className="hidden xl:inline">
          <Badge tone="primary">Local-first</Badge>
        </span>
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
        <Link
          to="/search"
          aria-label="Search your library"
          title="Search your library"
          className="grid size-10 place-items-center rounded-xl text-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground sm:size-9"
        >
          <Search aria-hidden="true" className="size-4" />
        </Link>
        <Button
          variant="ghost"
          size="icon"
          className="size-10 rounded-xl sm:size-9"
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
          className="grid size-10 place-items-center rounded-xl text-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-accent-foreground sm:size-9"
        >
          <CircleHelp aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </header>
  );
}

function pageLabel(pathname: string) {
  if (pathname === '/') return 'Today';
  if (pathname.startsWith('/player/')) return 'Focused study';
  const labels: Record<string, string> = {
    '/library': 'Library',
    '/plan': 'Plan builder',
    '/ai': 'AI Studio',
    '/search': 'Search',
    '/settings': 'Settings',
    '/diagnostics': 'Diagnostics',
    '/about': 'About',
  };
  return labels[pathname] ?? 'LectorBit';
}
