# `src/app/` — app shell

- `App.tsx` — root providers (QueryClient, Router, ErrorBoundary, theme).
- `routes.tsx` — route table consumed by `react-router/dom`'s `RouterProvider`.
- `bootstrap.tsx` — startup wiring: lazy-load first IPC ping, hydration, etc.
- Global error boundaries and the always-mounted shell live here.
