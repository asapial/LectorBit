# LectorBit Technology Baseline — 2026-08-08

> Audit date: 2026-08-08. Read this before installing anything.
> This is the **production-compatible** baseline. Newer versions may be
> available but the dependency tree below is the one known to compile,
> lint, and bundle together cleanly.

## 1. Host toolchain

| Tool | Pinned version | Notes |
| --- | --- | --- |
| Git | latest stable | already installed on this machine |
| Node.js | **24 LTS** | dev/build only; not shipped at runtime |
| pnpm | **11.x** | workspace + lockfile |
| Rust | **1.97.1** | installed via rustup |
| Cargo | bundled with rustup | |
| Tauri CLI | **2.11.x** | `cargo install tauri-cli --version "^2.11" --locked` |
| Visual Studio Build Tools | latest | Windows: C++ workload + Windows SDK |
| WebView2 Runtime | latest evergreen | Windows prerequisite |
| Xcode CLT | latest | macOS prerequisite |
| WebKitGTK + build deps | distro packages | Linux prerequisite |
| FFmpeg / ffprobe | latest stable | dev only; release binaries come from vetted manifests |

### Runtime engines (bundled later)

| Engine | Version | Strategy |
| --- | --- | --- |
| mpv | **0.41.0** | target; `PlaybackEngine` is the abstraction |
| whisper.cpp | **1.9.2** | sidecar, model manager downloads on demand |
| FFmpeg / ffprobe | release manifest | platform/arch + SHA-256 + license check |

## 2. Frontend dependencies

```text
react                ^19.2.7
react-dom            ^19.2.7
react-router         ^8.3.0          # v8 dropped react-router-dom
@tanstack/react-query ^5
@tanstack/react-virtual    latest 5
zustand                   latest 5
zod                       latest 4
react-hook-form           latest 7
@hookform/resolvers       latest 5
```

```text
# dev
typescript          6.0.3            # TS7 stable but typescript-eslint warns unsupported
vite                ^8.1.0
vitest              ^4.1.0
@testing-library/react       latest
@testing-library/jest-dom    latest
eslint                    latest 9
prettier                  latest 3
@types/node                latest
tailwindcss                ^4.3
@tailwindcss/vite          ^4.3
```

> TypeScript 7 is **not** the production baseline yet. Track it on a
> compatibility branch; promote when `typescript-eslint` ships support.

> React Router v8 imports `RouterProvider` from `react-router/dom`;
> everything else comes from `react-router`.

## 3. shadcn/ui

```bash
pnpm dlx shadcn@latest init
```

Add components per screen; do not commit a `components/ui` bulk dump.

## 4. Tauri 2 build hooks (object form)

```json
{
  "build": {
    "beforeDevCommand": {
      "cwd": "../../lectorbit_frontend",
      "script": "pnpm dev --host 127.0.0.1 --port 1420",
      "wait": false
    },
    "beforeBuildCommand": {
      "cwd": "../../lectorbit_frontend",
      "script": "pnpm build",
      "wait": true
    },
    "devUrl": "http://127.0.0.1:1420",
    "frontendDist": "../../lectorbit_frontend/dist"
  }
}
```

## 5. Rust workspace layout

```text
crates/
├── lectorbit_core      # IDs, entities, errors, config, traits
├── lectorbit_services  # use-cases, orchestration
├── lectorbit_db        # SQLx + migrations + FTS
├── lectorbit_media     # crawl, ffprobe, fingerprinting
├── lectorbit_ai        # whisper/OCR/embedding adapters
└── lectorbit_playback  # PlaybackEngine + mpv adapter
```

Initial `lectorbit_services` modules: `library`, `jobs`, `planner`,
`search`, `settings`, `models`, `progress`, `diagnostics`. Split a
module into its own crate only when it outgrows the monolith.

## 6. Database

- SQLx **0.9** with SQLite (bundled, `bundled` feature).
- Renderer **never** queries SQLite directly.
- Startup: `dirs -> open DB -> foreign_keys/WAL/busy_timeout -> migrations
  -> privacy config -> recover stale jobs -> verify sidecars -> start
  workers -> show UI`.

## 7. IPC privilege model

- Frontend calls only `tauri-plugin-lectorbit` commands.
- Plugin commands are explicit allow/deny in capabilities.
- The main window gets only the LectorBit permissions it needs.
- Generic `fs:*`, `sql:*`, `shell:*`, `network:*`, `updater` keys are
  **not** granted to the default capability.

## 8. Channels vs events

- **Channels** for ordered, high-throughput streams: scan progress,
  transcription progress, model download, sidecar stdout.
- **Events** for small multi-consumer broadcasts: `library-root-unavailable`,
  `active-plan-changed`.
- Throttle UI progress; don't repaint React per decoded frame/token.

## 9. Testing stack

- Rust: `cargo test`, golden/property tests for planner invariants.
- Frontend: Vitest 4.1 + React Testing Library.
- Desktop E2E: WebdriverIO + `@wdio/tauri-service` (after first vertical
  slice).
- Security tests: path traversal, symlink, revoked root, malformed DTO,
  permission deny, sidecar arg injection, secret redaction, updater
  signature failure.

## 10. Not building first

Billing, cloud login, OCR, embeddings, local LLM, vector DB, OR-Tools,
sync, telemetry dashboards, plugin marketplace, fancy analytics.

First prove: **import → index → plan → play → progress → replan**.
