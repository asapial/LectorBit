# `src/query/` — TanStack Query keys + invalidation

**Rule:** All query keys, cache lifetimes, and invalidation rules live here.

- One file per domain (`libraryKeys.ts`, `plannerKeys.ts`, …).
- `queryKeys.<area>.<detail>(...)` builders only — components never assemble keys by hand.
- `invalidate<Area>(client, ...)` helpers co-located with the keys.
- Mutations call into `src/ipc/` and then trigger the matching `invalidate<Area>` helper.
