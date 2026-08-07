# `src/test/` — test infrastructure

- `setup.ts` — Vitest setup (jest-dom matchers, fake-indexeddb if needed).
- `tauriMock.ts` — mock for `@tauri-apps/api/core` and `window.__TAURI__`.
- `renderWithProviders.tsx` — wraps `render()` with QueryClient + Router + (later) IPC stubs.

Tests for components live next to the component in `src/features/<x>/tests/`.
