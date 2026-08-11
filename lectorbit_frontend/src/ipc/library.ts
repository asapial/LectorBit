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
  status: z.enum([
    'queued',
    'running',
    'paused',
    'retry_wait',
    'completed',
    'failed',
    'cancelled',
  ]),
  attempt: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const ScanEventSchema = z.discriminatedUnion('event', [
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

const LibraryErrorSchema = z.object({
  kind: z.enum([
    'empty_path',
    'not_a_directory',
    'not_found',
    'io',
    'database',
    'internal',
  ]),
  message: z.string(),
});

export type LibraryRoot = z.infer<typeof LibraryRootSchema>;
export type ScanJob = z.infer<typeof ScanJobSchema>;
export type ScanEvent = z.infer<typeof ScanEventSchema>;
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
  const raw = await invoke<unknown>('plugin:lectorbit|library_list_roots');
  return z.array(LibraryRootSchema).parse(raw);
}

export async function pickAndRegisterRoot(): Promise<LibraryRoot | null> {
  try {
    const raw = await invoke<unknown>(
      'plugin:lectorbit|library_pick_and_register_root',
    );
    return LibraryRootSchema.nullable().parse(raw);
  } catch (error) {
    throw wrapLibraryError(error);
  }
}

export async function revokeRoot(id: string): Promise<LibraryRoot> {
  try {
    const raw = await invoke<unknown>(
      'plugin:lectorbit|library_revoke_root',
      { args: { id } },
    );
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
    const raw = await invoke<unknown>(
      'plugin:lectorbit|library_enqueue_scan',
      { args: { root_id: rootId }, onEvent: channel },
    );
    return ScanJobSchema.parse(raw);
  } catch (error) {
    throw wrapLibraryError(error);
  }
}

export async function listScanJobs(rootId?: string): Promise<ScanJob[]> {
  try {
    const raw = await invoke<unknown>(
      'plugin:lectorbit|library_list_scan_jobs',
      { args: { root_id: rootId ?? null } },
    );
    return z.array(ScanJobSchema).parse(raw);
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
    return new LibraryRpcError('internal', error.message);
  }
  return new LibraryRpcError('internal', String(error));
}
