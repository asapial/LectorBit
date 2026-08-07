# LectorBit

Local-first desktop study planner. Authoritative setup: `project-docs/TECHNOLOGY_BASELINE_2026-08.md`. Full tree: `project-docs/FOLDER_STRUCTURE.txt`.

## Layout

- `lectorbit_frontend/` — React 19.2 + Vite + TS 6 desktop UI.
- `lectorbit_backend/` — Tauri 2 (Rust) app shell + modular monolith crates.
- `project-docs/` — baseline, plan references, full tree.

## First-time dev setup

```bash
# 1. Rust
rustup toolchain install 1.97.1
rustup default 1.97.1

# 2. Tauri 2 CLI
cargo install tauri-cli --version "^2.11" --locked

# 3. Frontend deps
cd lectorbit_frontend
pnpm install

# 4. Backend (full workspace)
cd ../lectorbit_backend
cargo test --workspace
cargo tauri dev
```

## Audit-frozen stack (2026-08-08)

- Node 24 LTS, pnpm 11.x, Rust 1.97.1, Tauri 2.
- React 19.2.7, React Router 8.3.0, TanStack Query 5, TanStack Virtual 3.
- Zustand 5, Zod 4, react-hook-form 7, Tailwind v4.
- TS 6.0.3 (TS 7 deliberately deferred — see baseline).
- SQLx 0.9 + SQLite, whisper.cpp 1.9.2, mpv 0.41.0.

## First vertical slice

`app_get_version` IPC bridge: Rust command → `src/ipc/app.ts` → `/about` route → Vitest.
