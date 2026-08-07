# `src/features/` — vertical slices

Each folder is a self-contained feature:

```
features/
  library/        # pick root, list media, filters
    components/
    hooks/
    tests/
    index.ts      # public surface
  planner/
  playback/
  ...
```

A feature owns its UI, hooks, and tests. Cross-feature imports go through `features/<x>/index.ts`, never straight into a sibling's internals.
