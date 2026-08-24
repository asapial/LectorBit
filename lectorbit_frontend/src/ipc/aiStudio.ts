import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const ArtifactSchema = z.object({
  id: z.string().min(1),
  media_id: z.string().min(1),
  display_name: z.string().min(1),
  transcript_id: z.string().min(1).nullable(),
  kind: z.string().min(1),
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  created_at: z.string().min(1),
  superseded_at: z.string().min(1).nullable(),
  stale: z.boolean(),
});

const RequestEventSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  capability: z.string().min(1),
  prompt_id: z.string().min(1),
  prompt_version: z.string().min(1),
  requested_model: z.string().min(1),
  resolved_model: z.string().min(1).nullable(),
  request_bytes: z.number().int().nonnegative(),
  response_bytes: z.number().int().nonnegative().nullable(),
  duration_ms: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().nullable(),
  result: z.enum(['succeeded', 'failed']),
  error_kind: z.string().nullable(),
  consent_scope: z.string().min(1),
  created_at: z.string().min(1),
});

const AiStudioJobSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  status: z.enum(['queued', 'running', 'paused', 'retry_wait', 'completed', 'failed', 'cancelled']),
  attempt: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type AiArtifactSummary = z.infer<typeof ArtifactSchema>;
export type AiRequestEvent = z.infer<typeof RequestEventSchema>;
export type AiStudioJob = z.infer<typeof AiStudioJobSchema>;

export async function listAiArtifacts(includeSuperseded = false, limit = 100) {
  return z.array(ArtifactSchema).parse(
    await invoke<unknown>('plugin:lectorbit|ai_studio_list_artifacts', {
      args: { include_superseded: includeSuperseded, limit },
    }),
  );
}

export async function listAiRequestActivity(limit = 100) {
  return z.array(RequestEventSchema).parse(
    await invoke<unknown>('plugin:lectorbit|ai_studio_list_request_activity', {
      args: { limit },
    }),
  );
}

export async function listAiStudioJobs(limit = 100) {
  return z
    .array(AiStudioJobSchema)
    .parse(await invoke<unknown>('plugin:lectorbit|ai_studio_list_jobs', { args: { limit } }));
}

export async function cancelAiStudioJob(jobId: string) {
  return AiStudioJobSchema.parse(
    await invoke<unknown>('plugin:lectorbit|ai_studio_cancel_job', {
      args: { job_id: jobId },
    }),
  );
}

export async function retryAiStudioJob(jobId: string) {
  return AiStudioJobSchema.parse(
    await invoke<unknown>('plugin:lectorbit|ai_studio_retry_job', {
      args: { job_id: jobId },
    }),
  );
}
