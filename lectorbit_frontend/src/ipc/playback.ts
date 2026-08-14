import { Channel, invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const PlaybackCapabilitySchema = z.object({
  available: z.boolean(),
  backend: z.string().min(1),
  expected_version: z.string().min(1),
  detected_version: z.string().min(1).nullable(),
});

const CaptionTrackSchema = z.object({
  label: z.string().min(1),
  language: z.string().min(1),
  url: z.string().url(),
});

const PlaybackViewSchema = z.object({
  plan_item_id: z.string().min(1),
  media_id: z.string().min(1),
  display_name: z.string().min(1),
  raw_start_ms: z.number().int().nonnegative(),
  raw_end_ms: z.number().int().positive(),
  position_ms: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  paused: z.boolean(),
  speed: z.number().min(0.5).max(2),
  progress_version: z.number().int().nonnegative(),
  item_covered_ms: z.number().int().nonnegative(),
  item_duration_ms: z.number().int().positive(),
  completed: z.boolean(),
  stream_url: z.string().url(),
  caption_tracks: z.array(CaptionTrackSchema).default([]),
});

const PlaybackEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('state'), data: PlaybackViewSchema }),
  z.object({
    event: z.literal('closed'),
    data: z.object({ plan_item_id: z.string().min(1) }),
  }),
  z.object({
    event: z.literal('failed'),
    data: z.object({ message: z.string().min(1) }),
  }),
]);

const PlaybackErrorSchema = z.object({
  kind: z.enum([
    'invalid_input',
    'item_unavailable',
    'not_open',
    'playback_unavailable',
    'database',
    'internal',
  ]),
  message: z.string(),
});

const StudyActionSchema = z.enum(['complete', 'skip', 'postpone', 'split', 'repeat', 'must_watch']);

export type PlaybackCapability = z.infer<typeof PlaybackCapabilitySchema>;
export type PlaybackView = z.infer<typeof PlaybackViewSchema>;
export type PlaybackEvent = z.infer<typeof PlaybackEventSchema>;
export type StudyAction = z.infer<typeof StudyActionSchema>;
export type PlaybackErrorKind = z.infer<typeof PlaybackErrorSchema>['kind'];

export class PlaybackRpcError extends Error {
  readonly kind: PlaybackErrorKind;

  constructor(kind: PlaybackErrorKind, message: string) {
    super(message);
    this.name = 'PlaybackRpcError';
    this.kind = kind;
  }
}

export async function getPlaybackCapability(): Promise<PlaybackCapability> {
  return call('playback_get_capability', undefined, PlaybackCapabilitySchema);
}

export async function openPlayback(
  planItemId: string,
  onEvent: (event: PlaybackEvent) => void,
): Promise<PlaybackView> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const parsed = PlaybackEventSchema.safeParse(raw);
    if (parsed.success) onEvent(parsed.data);
  };
  return call(
    'playback_open',
    { args: { plan_item_id: nonemptyId(planItemId) }, onEvent: channel },
    PlaybackViewSchema,
  );
}

export async function playPlayback(): Promise<PlaybackView> {
  return call('playback_play', undefined, PlaybackViewSchema);
}

export async function pausePlayback(): Promise<PlaybackView> {
  return call('playback_pause', undefined, PlaybackViewSchema);
}

export async function seekPlayback(positionMs: number): Promise<PlaybackView> {
  const position = z.number().int().nonnegative().parse(positionMs);
  return call('playback_seek', { args: { position_ms: position } }, PlaybackViewSchema);
}

export async function setPlaybackSpeed(speed: number): Promise<PlaybackView> {
  const validated = z.number().min(0.5).max(2).parse(speed);
  return call('playback_set_speed', { args: { speed: validated } }, PlaybackViewSchema);
}

export async function getPlaybackState(): Promise<PlaybackView> {
  return call('playback_get_state', undefined, PlaybackViewSchema);
}

export async function syncPlayback(
  positionMs: number,
  paused: boolean,
  speed: number,
): Promise<PlaybackView> {
  return call(
    'playback_sync',
    {
      args: {
        position_ms: z.number().int().nonnegative().parse(positionMs),
        paused,
        speed: z.number().min(0.5).max(2).parse(speed),
      },
    },
    PlaybackViewSchema,
  );
}

export async function closePlayback(): Promise<void> {
  return call(
    'playback_close',
    undefined,
    z.null().transform(() => undefined),
  );
}

export async function recordStudyAction(
  planItemId: string,
  kind: StudyAction,
  atMs?: number,
): Promise<void> {
  const action = StudyActionSchema.parse(kind);
  const position = atMs === undefined ? null : z.number().int().nonnegative().parse(atMs);
  return call(
    'study_record_action',
    {
      args: {
        plan_item_id: nonemptyId(planItemId),
        kind: action,
        at_ms: position,
      },
    },
    z.null().transform(() => undefined),
  );
}

function nonemptyId(value: string): string {
  return z.string().min(1).parse(value);
}

async function call<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await invoke<unknown>(`plugin:lectorbit|${command}`, args).then(
    (value) => value,
    (error: unknown) => {
      throw wrapPlaybackError(error);
    },
  );
  return schema.parse(raw);
}

function wrapPlaybackError(error: unknown): PlaybackRpcError {
  if (!(error instanceof Error)) {
    const parsed = PlaybackErrorSchema.safeParse(error);
    if (parsed.success) {
      return new PlaybackRpcError(parsed.data.kind, parsed.data.message);
    }
  }
  return new PlaybackRpcError('internal', 'The playback service is unavailable.');
}
