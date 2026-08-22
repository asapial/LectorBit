import type { ReactNode } from 'react';
import { MobileNavigation, Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="app-canvas flex h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main
          id="main-content"
          tabIndex={-1}
          className="scrollbar-thin relative flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_35%_0%,color-mix(in_srgb,var(--primary)_8%,transparent),transparent_68%)]" />
          <div className="relative mx-auto w-full max-w-[90rem] px-4 pb-28 pt-6 sm:px-6 sm:pt-8 lg:px-8 xl:px-10 min-[1180px]:pb-10">
            {children}
          </div>
        </main>
      </div>
      <MobileNavigation />
    </div>
  );
}
