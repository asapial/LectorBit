import { Channel, invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const UpdateCheckSchema = z.object({
  status: z.enum(['disabled', 'current', 'available']),
  current_version: z.string().min(1),
  version: z.string().nullable(),
  notes: z.string().nullable(),
  published_at: z.string().nullable(),
  target: z.string().nullable(),
});

const UpdateProgressSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('downloading'),
    data: z.object({
      downloadedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().positive().nullable(),
    }),
  }),
  z.object({ event: z.literal('installing') }),
  z.object({ event: z.literal('relaunching') }),
]);

const UpdateErrorSchema = z.object({
  kind: z.enum([
    'not_configured',
    'invalid_request',
    'busy',
    'network',
    'verification',
    'install',
    'internal',
  ]),
  message: z.string().min(1),
});

export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

export function checkForUpdates(): Promise<UpdateCheck> {
  return Promise.resolve()
    .then(() => invoke<unknown>('plugin:lectorbit|updates_check'))
    .then(
      (value) => UpdateCheckSchema.parse(value),
      (error: unknown) => {
        throw normalizeUpdateError(error);
      },
    );
}

export async function installUpdate(
  version: string,
  onEvent: (event: UpdateProgress) => void,
): Promise<void> {
  const channel = new Channel<unknown>();
  channel.onmessage = (value) => {
    const parsed = UpdateProgressSchema.safeParse(value);
    if (parsed.success) onEvent(parsed.data);
  };
  return Promise.resolve()
    .then(() =>
      invoke<void>('plugin:lectorbit|updates_install', {
        args: { version },
        onEvent: channel,
      }),
    )
    .catch((error: unknown) => {
      throw normalizeUpdateError(error);
    });
}

export function normalizeUpdateError(error: unknown): Error {
  const parsed = UpdateErrorSchema.safeParse(error);
  if (parsed.success) return new Error(parsed.data.message);
  return new Error('The signed update service is unavailable.');
}
