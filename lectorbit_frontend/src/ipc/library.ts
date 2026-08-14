import { Channel, invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const LibraryRootSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  path_redacted: z.string().min(1),
  registered_at: z.string().min(1),
  revoked_at: z.string().nullable(),
  is_active: z.boolean(),
});

const ScanJobSchema = z.object({
  id: z.string().min(1),
  root_id: z.string().min(1),
  status: z.enum(['queued', 'running', 'paused', 'retry_wait', 'completed', 'failed', 'cancelled']),
  attempt: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const ScanEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('metadata'),
    data: z.object({
      jobId: z.string(),
      completed: z.number().nonnegative(),
      total: z.number().nonnegative(),
      failed: z.number().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('started'),
    data: z.object({ jobId: z.string(), rootId: z.string() }),
  }),
  z.object({
    event: z.literal('discovering'),
    data: z.object({
      jobId: z.string(),
      visitedEntries: z.number().nonnegative(),
      mediaCandidates: z.number().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('indexing'),
    data: z.object({
      jobId: z.string(),
      current: z.number().nonnegative(),
      total: z.number().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('completed'),
    data: z.object({
      jobId: z.string(),
      indexed: z.number().nonnegative(),
      issues: z.number().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('failed'),
    data: z.object({ jobId: z.string(), message: z.string() }),
  }),
]);

const MediaListItemSchema = z.object({
  id: z.string().min(1),
  root_id: z.string().min(1),
  display_name: z.string().min(1),
  path_redacted: z.string().min(1),
  media_kind: z.enum(['video', 'audio']),
  size_bytes: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative().nullable(),
  container: z.string().nullable(),
  video_codec: z.string().nullable(),
  audio_codec: z.string().nullable(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  audio_streams: z.number().int().nonnegative(),
  subtitle_streams: z.number().int().nonnegative(),
  probe_status: z.enum(['queued', 'probing', 'ready', 'failed', 'unavailable', 'missing']),
  probe_error: z.string().nullable(),
  discovered_at: z.string().min(1),
});

const MediaSummarySchema = z.object({
  total_items: z.number().int().nonnegative(),
  ready_items: z.number().int().nonnegative(),
  attention_items: z.number().int().nonnegative(),
  known_duration_ms: z.number().int().nonnegative(),
  duration_known_items: z.number().int().nonnegative(),
});

const MediaPageSchema = z.object({
  items: z.array(MediaListItemSchema),
  next_cursor: z.string().nullable(),
  // Optional while upgrading from pre-summary desktop bridges. Current
  // backends always provide exact, root-scoped totals.
  summary: MediaSummarySchema.optional(),
});

const LibraryErrorSchema = z.object({
  kind: z.enum(['empty_path', 'not_a_directory', 'not_found', 'io', 'database', 'internal']),
  message: z.string(),
});

export type LibraryRoot = z.infer<typeof LibraryRootSchema>;
export type ScanJob = z.infer<typeof ScanJobSchema>;
export type ScanEvent = z.infer<typeof ScanEventSchema>;
export type MediaListItem = z.infer<typeof MediaListItemSchema>;
export type MediaSummary = z.infer<typeof MediaSummarySchema>;
export type MediaPage = z.infer<typeof MediaPageSchema>;
export type LibraryErrorKind = z.infer<typeof LibraryErrorSchema>['kind'];

export class LibraryRpcError extends Error {
  readonly kind: LibraryErrorKind;

  constructor(kind: LibraryErrorKind, message: string) {
    super(message);
    this.name = 'LibraryRpcError';
    this.kind = kind;
  }
}

export async function listRoots(): Promise<LibraryRoot[]> {
  try {
    const raw = await invoke<unknown>('plugin:lectorbit|library_list_roots');
    return z.array(LibraryRootSchema).parse(raw);
  } catch (error) {
    throw wrapLibraryError(error);
  }
}

export async function pickAndRegisterRoot(): Promise<LibraryRoot | null> {
  try {
    const raw = await invoke<unknown>('plugin:lectorbit|library_pick_and_register_root');
    return LibraryRootSchema.nullable().parse(raw);
  } catch (error) {
    throw wrapLibraryError(error);
  }
}

export async function revokeRoot(id: string): Promise<LibraryRoot> {
  try {
    const raw = await invoke<unknown>('plugin:lectorbit|library_revoke_root', { args: { id } });
    return LibraryRootSchema.parse(raw);
  } catch (error) {
    throw wrapLibraryError(error);
  }
}

export async function startScan(
  rootId: string,
  onEvent: (event: ScanEvent) => void,
): Promise<ScanJob> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const parsed = ScanEventSchema.safeParse(raw);
    if (parsed.success) onEvent(parsed.data);
  };
  try {
    const raw = await invoke<unknown>('plugin:lectorbit|library_enqueue_scan', {
      args: { root_id: rootId },
      onEvent: channel,
    });
    return ScanJobSchema.parse(raw);
  } catch (error) {
    throw wrapLibraryError(error);
  }
}

export async function listScanJobs(rootId?: string): Promise<ScanJob[]> {
  try {
    const raw = await invoke<unknown>('plugin:lectorbit|library_list_scan_jobs', {
      args: { root_id: rootId ?? null },
    });
    return z.array(ScanJobSchema).parse(raw);
  } catch (error) {
    throw wrapLibraryError(error);
  }
}

export async function listMedia(options?: {
  rootId?: string;
  cursor?: string;
  limit?: number;
}): Promise<MediaPage> {
  try {
    const raw = await invoke<unknown>('plugin:lectorbit|library_list_media', {
      args: {
        root_id: options?.rootId ?? null,
        cursor: options?.cursor ?? null,
        limit: options?.limit ?? 50,
      },
    });
    return MediaPageSchema.parse(raw);
  } catch (error) {
    throw wrapLibraryError(error);
  }
}

function wrapLibraryError(error: unknown): LibraryRpcError {
  const parsed = LibraryErrorSchema.safeParse(error);
  if (parsed.success) {
    return new LibraryRpcError(parsed.data.kind, parsed.data.message);
  }
  if (error instanceof Error) {
    return new LibraryRpcError('internal', 'The library service is unavailable.');
  }
  return new LibraryRpcError('internal', 'The library service is unavailable.');
}
