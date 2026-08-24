# `src/routes/` — top-level route components

Thin route shells that compose features:

```
routes/
  home/HomeRoute.tsx
  library/LibraryRoute.tsx
  planner/PlannerRoute.tsx
  playback/PlaybackRoute.tsx
  about/AboutRoute.tsx
```

A route file does data loading + layout; the actual UI lives in `src/features/<area>/`.
