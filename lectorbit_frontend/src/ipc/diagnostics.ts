// Typed wrapper for the LectorBit internal Tauri plugin's diagnostics command.
// Only file in the project allowed to import from `@tauri-apps/api/core` for
// this command — keep that import inside this module.

import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const AppInfoSchema = z.object({
  version: z.string(),
  build: z.string(),
  target_triple: z.string(),
  // `chrono::Duration` serializes to `{ secs, nanos }`. The UI doesn't need
  // sub-second accuracy; we keep the raw shape here so the renderer can
  // choose how to format it.
  elapsed_since_launch: z
    .object({
      secs: z.number().int(),
      nanos: z.number().int().nonnegative(),
    })
    .nullable(),
});

const DatabaseInfoSchema = z.object({
  schema_version: z.number().int().nonnegative(),
  migrations_applied: z.number().int().nonnegative(),
  sqlite_version: z.string(),
  journal_mode: z.string(),
  foreign_keys: z.boolean(),
  size_bytes: z.number().nullable(),
  path_redacted: z.string().nullable(),
});

const LibrarySummarySchema = z.object({
  root_count: z.number().int().nonnegative(),
  active_root_count: z.number().int().nonnegative(),
  media_count: z.number().int().nonnegative(),
});

const AiSummarySchema = z.object({
  whisper_model_present: z.boolean(),
  ocr_model_present: z.boolean(),
  embeddings_model_present: z.boolean(),
  last_consent: z.string().nullable(),
});

const DiagnosticsReportSchema = z.object({
  generated_at: z.string(),
  app: AppInfoSchema,
  database: DatabaseInfoSchema,
  library: LibrarySummarySchema,
  ai: AiSummarySchema,
  recent_errors: z.array(z.string()),
});

export type AppInfo = z.infer<typeof AppInfoSchema>;
export type DatabaseInfo = z.infer<typeof DatabaseInfoSchema>;
export type LibrarySummary = z.infer<typeof LibrarySummarySchema>;
export type AiSummary = z.infer<typeof AiSummarySchema>;
export type DiagnosticsReport = z.infer<typeof DiagnosticsReportSchema>;

export async function getDiagnostics(): Promise<DiagnosticsReport> {
  // The schema is declared `chrono::DateTime<Utc>` in Rust, which serializes
  // to RFC3339 strings. We don't validate every field's exact shape — we only
  // ensure the structure is what the UI expects, then surface the rest.
  const raw = await invoke<DiagnosticsReport>('plugin:lectorbit|app_get_diagnostics');
  return DiagnosticsReportSchema.parse(raw);
}
