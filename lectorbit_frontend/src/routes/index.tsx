import type { RouteObject } from 'react-router';
import { AppLayout } from '../app/AppLayout';
import { HomeRoute } from './home/HomeRoute';
import { AboutRoute } from './about/AboutRoute';
import { LibraryRoute } from './library/LibraryRoute';
import { PlanRoute } from './plan/PlanRoute';
import { SearchRoute } from './search/SearchRoute';
import { SettingsRoute } from './settings/SettingsRoute';
import { NotFoundRoute } from './NotFoundRoute';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: 'library', element: <LibraryRoute /> },
      { path: 'plan', element: <PlanRoute /> },
      { path: 'search', element: <SearchRoute /> },
      { path: 'settings', element: <SettingsRoute /> },
      { path: 'about', element: <AboutRoute /> },
      { path: '*', element: <NotFoundRoute /> },
    ],
  },
];