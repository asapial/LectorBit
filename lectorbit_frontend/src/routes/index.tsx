import type { RouteObject } from 'react-router';
import { AppLayout } from '../app/AppLayout';
import { BrandLogo } from '../components/brand/BrandLogo';
import { Spinner } from '../components/ui/Spinner';
import { HomeRoute } from './home/HomeRoute';

function InitialRouteFallback() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
      <section
        aria-label="Opening LectorBit"
        className="flex max-w-sm items-center gap-4 rounded-2xl border border-border/70 bg-card/90 p-5 shadow-xl shadow-black/5"
      >
        <BrandLogo className="size-14 shadow-lg" />
        <div className="space-y-1.5">
          <p className="font-display text-lg font-semibold tracking-tight">LectorBit</p>
          <Spinner label="Opening your private study workspace…" />
        </div>
      </section>
    </main>
  );
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    hydrateFallbackElement: <InitialRouteFallback />,
    children: [
      { index: true, element: <HomeRoute /> },
      {
        path: 'library',
        lazy: async () => ({
          Component: (await import('./library/LibraryRoute')).LibraryRoute,
        }),
      },
      {
        path: 'plan',
        lazy: async () => ({ Component: (await import('./plan/PlanRoute')).PlanRoute }),
      },
      {
        path: 'ai',
        lazy: async () => ({ Component: (await import('./ai/AiStudioRoute')).AiStudioRoute }),
      },
      {
        path: 'player/:itemId',
        lazy: async () => ({ Component: (await import('./player/PlayerRoute')).PlayerRoute }),
      },
      {
        path: 'search',
        lazy: async () => ({ Component: (await import('./search/SearchRoute')).SearchRoute }),
      },
      {
        path: 'settings',
        lazy: async () => ({
          Component: (await import('./settings/SettingsRoute')).SettingsRoute,
        }),
      },
      {
        path: 'diagnostics',
        lazy: async () => ({
          Component: (await import('./diagnostics/DiagnosticsRoute')).DiagnosticsRoute,
        }),
      },
      {
        path: 'about',
        lazy: async () => ({ Component: (await import('./about/AboutRoute')).AboutRoute }),
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('./NotFoundRoute')).NotFoundRoute }),
      },
    ],
  },
];
