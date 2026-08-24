# `src/ipc/` — Tauri IPC boundary

**Rule:** This is the **only** folder allowed to call raw Tauri `invoke` / `Channel` APIs.

Everything else in the app imports typed wrappers from here. Components, hooks, query keys, and Zustand stores must never import from `@tauri-apps/api` directly.

Conventions:

- One file per domain area (e.g. `app.ts`, `library.ts`, `scan.ts`, `planner.ts`).
- Each command is a small typed function that takes a DTO and returns a typed result.
- Errors come back as `Result<T, LectorError>` where `LectorError` is the canonical discriminant from Rust (see `domain/errors.ts`).
- Long-running streaming uses a Tauri `Channel<TProgress>`, not events.
- All cross-boundary DTOs are validated with Zod at this layer, not in components.
