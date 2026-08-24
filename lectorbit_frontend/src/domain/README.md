# `src/domain/` — shared domain types

DTO-independent types, branded IDs (`RootId`, `MediaId`, `JobId`), error discriminants, units (`Minutes`, `Seconds`, `Bytes`).

- Plain TS types and Zod schemas.
- No imports from `src/ipc/`, `src/query/`, or `src/features/`.
- Importable from anywhere.
