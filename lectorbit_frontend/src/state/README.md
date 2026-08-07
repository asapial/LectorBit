# `src/state/` — Zustand stores

**Rule:** Stores hold UI / workflow state only. They must **never** copy database truth.

Bad: mirroring `media_files` rows in a Zustand store.
Good: holding `selectedRootId`, `filterPanelOpen`, `wizardStep`, `activePlanDraftId`.

For DB-shaped state, use TanStack Query (`src/query/`).
