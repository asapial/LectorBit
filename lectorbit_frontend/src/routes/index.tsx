import type { RouteObject } from 'react-router';
import { AppLayout } from '../app/AppLayout';
import { HomeRoute } from './home/HomeRoute';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
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
