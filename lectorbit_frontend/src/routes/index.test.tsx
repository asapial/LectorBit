import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '.';

describe('route bootstrap', () => {
  it('shows a branded status while an initial lazy route remains unresolved', () => {
    const pendingRoutes: RouteObject[] = [
      {
        path: '/',
        element: <div>Loaded route</div>,
        hydrateFallbackElement: routes[0]?.hydrateFallbackElement,
        children: [
          {
            path: 'lazy',
            lazy: () => new Promise<never>(() => undefined),
          },
        ],
      },
    ];
    const router = createMemoryRouter(pendingRoutes, { initialEntries: ['/lazy'] });

    render(<RouterProvider router={router} />);

    expect(screen.getByLabelText('Opening LectorBit')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Opening your private study workspace…');
  });
});
