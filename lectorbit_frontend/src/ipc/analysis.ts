import { Channel, invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const JobSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['model_download', 'transcribe']),
  status: z.enum(['queued', 'running', 'paused', 'retry_wait', 'completed', 'failed', 'cancelled']),
  attempt: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const ModelSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  version: z.string().min(1),
  provider: z.string().min(1),
  expected_size_bytes: z.number().int().positive(),
  architecture: z.string().min(1),
  analyzer_compatibility: z.string().min(1),
  license: z.string().min(1),
  state: z.enum(['available', 'downloading', 'ready', 'failed']),
  bytes_downloaded: z.number().int().nonnegative(),
  verified_at: z.string().nullable(),
  last_error: z.string().nullable(),
  supported_languages: z.array(z.enum(['en', 'bn'])).min(1),
});

const TranscriptionLanguageSchema = z.enum(['en', 'bn']);

const AnalysisCapabilitySchema = z.object({
  available: z.boolean(),
  engine: z.string().min(1),
  expected_version: z.string().min(1),
  unavailable_reason: z.string().nullable(),
  message: z.string().min(1),
  supported_languages: z.array(TranscriptionLanguageSchema),
});

const ProgressSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('queued'), data: z.object({ jobId: z.string() }) }),
  z.object({
    event: z.literal('downloading'),
    data: z.object({
      jobId: z.string(),
      downloadedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().positive(),
    }),
  }),
  z.object({ event: z.literal('extracting'), data: z.object({ jobId: z.string() }) }),
  z.object({ event: z.literal('transcribing'), data: z.object({ jobId: z.string() }) }),
  z.object({
    event: z.literal('indexing'),
    data: z.object({ jobId: z.string(), segments: z.number().int().nonnegative() }),
  }),
  z.object({ event: z.literal('completed'), data: z.object({ jobId: z.string() }) }),
  z.object({
    event: z.literal('failed'),
    data: z.object({ jobId: z.string(), message: z.string() }),
  }),
]);

const TranscriptStateSchema = z.object({
  media_id: z.string().min(1),
  status: z.enum(['not_started', 'queued', 'processing', 'attention', 'completed', 'failed']),
  segment_count: z.number().int().nonnegative(),
  language: z.string().min(1).nullable(),
  model_id: z.string().min(1).nullable(),
  updated_at: z.string().nullable(),
  job: JobSchema.nullable(),
});

const AnalysisErrorSchema = z.object({
  kind: z.enum([
    'invalid_input',
    'model_not_found',
    'model_not_ready',
    'language_not_supported',
    'transcription_busy',
    'media_unavailable',
    'sidecar_unavailable',
    'database',
    'internal',
  ]),
  message: z.string(),
});

export type AnalysisJob = z.infer<typeof JobSchema>;
export type LocalModel = z.infer<typeof ModelSchema>;
export type AnalysisProgress = z.infer<typeof ProgressSchema>;
export type TranscriptState = z.infer<typeof TranscriptStateSchema>;
export type TranscriptionLanguage = z.infer<typeof TranscriptionLanguageSchema>;
export type AnalysisCapability = z.infer<typeof AnalysisCapabilitySchema>;
export type AnalysisErrorKind = z.infer<typeof AnalysisErrorSchema>['kind'];

export class AnalysisRpcError extends Error {
  readonly kind: AnalysisErrorKind;

  constructor(kind: AnalysisErrorKind, message: string) {
    super(message);
    this.name = 'AnalysisRpcError';
    this.kind = kind;
  }
}

export async function getAnalysisCapability(): Promise<AnalysisCapability> {
  return AnalysisCapabilitySchema.parse(
    await invoke<unknown>('plugin:lectorbit|analysis_get_capability').catch(wrapAnalysisError),
  );
}

export async function listModels(): Promise<LocalModel[]> {
  return z.array(ModelSchema).parse(await invoke<unknown>('plugin:lectorbit|models_list'));
}

export async function installModel(
  modelId: string,
  onEvent: (event: AnalysisProgress) => void,
): Promise<AnalysisJob> {
  const channel = progressChannel(onEvent);
  return JobSchema.parse(
    await invoke<unknown>('plugin:lectorbit|models_install', {
      args: { model_id: modelId },
      onEvent: channel,
    }).catch(wrapAnalysisError),
  );
}

export async function removeModel(modelId: string): Promise<void> {
  await invoke('plugin:lectorbit|models_remove', {
    args: { model_id: modelId },
  }).catch(wrapAnalysisError);
}

export async function startTranscription(
  mediaId: string,
  modelId: string,
  language: TranscriptionLanguage,
  onEvent: (event: AnalysisProgress) => void,
): Promise<AnalysisJob> {
  const channel = progressChannel(onEvent);
  const selectedLanguage = TranscriptionLanguageSchema.parse(language);
  return JobSchema.parse(
    await invoke<unknown>('plugin:lectorbit|analysis_start_transcription', {
      args: { media_id: mediaId, model_id: modelId, language: selectedLanguage },
      onEvent: channel,
    }).catch(wrapAnalysisError),
  );
}

export async function getTranscriptState(mediaId: string): Promise<TranscriptState> {
  return TranscriptStateSchema.parse(
    await invoke<unknown>('plugin:lectorbit|analysis_get_transcript_state', {
      args: { media_id: mediaId },
    }).catch(wrapAnalysisError),
  );
}

export async function listAnalysisJobs(
  kind: 'model_download' | 'transcribe',
): Promise<AnalysisJob[]> {
  return z.array(JobSchema).parse(
    await invoke<unknown>('plugin:lectorbit|analysis_list_jobs', {
      args: { kind },
    }).catch(wrapAnalysisError),
  );
}

function progressChannel(onEvent: (event: AnalysisProgress) => void) {
  const channel = new Channel<unknown>();
  channel.onmessage = (value) => {
    const parsed = ProgressSchema.safeParse(value);
    if (parsed.success) onEvent(parsed.data);
  };
  return channel;
}

function wrapAnalysisError(error: unknown): never {
  const parsed = AnalysisErrorSchema.safeParse(error);
  if (parsed.success) throw new AnalysisRpcError(parsed.data.kind, parsed.data.message);
  throw new AnalysisRpcError('internal', 'The local analysis service is unavailable.');
}
