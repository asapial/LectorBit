import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const AnnotationKindSchema = z.enum(['question', 'takeaway']);
const AnnotationSchema = z.object({
  id: z.string().min(1).max(128),
  media_id: z.string().min(1).max(128),
  at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: AnnotationKindSchema,
  text: z.string().trim().min(1).max(240),
  reviewed: z.boolean(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const AnnotationErrorSchema = z.object({
  kind: z.enum([
    'invalid_input',
    'media_unavailable',
    'not_found',
    'limit_reached',
    'database',
    'internal',
  ]),
  message: z.string().min(1),
});

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('/') && !value.includes('\\'));

export type AnnotationKind = z.infer<typeof AnnotationKindSchema>;
export type LearningAnnotation = z.infer<typeof AnnotationSchema>;
export type AnnotationErrorKind = z.infer<typeof AnnotationErrorSchema>['kind'];

export class AnnotationRpcError extends Error {
  readonly kind: AnnotationErrorKind;

  constructor(kind: AnnotationErrorKind, message: string) {
    super(message);
    this.name = 'AnnotationRpcError';
    this.kind = kind;
  }
}

export async function listLearningAnnotations(mediaId: string): Promise<LearningAnnotation[]> {
  const media_id = IdentifierSchema.parse(mediaId);
  return z.array(AnnotationSchema).parse(
    await invoke<unknown>('plugin:lectorbit|annotations_list', {
      args: { media_id },
    }).catch(wrapAnnotationError),
  );
}

export async function createLearningAnnotation(input: {
  mediaId: string;
  atMs: number;
  kind: AnnotationKind;
  text: string;
}): Promise<LearningAnnotation> {
  const media_id = IdentifierSchema.parse(input.mediaId);
  const at_ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.atMs);
  const kind = AnnotationKindSchema.parse(input.kind);
  const text = z.string().trim().min(1).max(240).parse(input.text);
  return AnnotationSchema.parse(
    await invoke<unknown>('plugin:lectorbit|annotations_create', {
      args: { media_id, at_ms, kind, text },
    }).catch(wrapAnnotationError),
  );
}

export async function setLearningAnnotationReviewed(input: {
  mediaId: string;
  annotationId: string;
  reviewed: boolean;
}): Promise<LearningAnnotation> {
  const media_id = IdentifierSchema.parse(input.mediaId);
  const annotation_id = IdentifierSchema.parse(input.annotationId);
  return AnnotationSchema.parse(
    await invoke<unknown>('plugin:lectorbit|annotations_set_reviewed', {
      args: { media_id, annotation_id, reviewed: input.reviewed },
    }).catch(wrapAnnotationError),
  );
}

export async function removeLearningAnnotation(input: {
  mediaId: string;
  annotationId: string;
}): Promise<void> {
  const media_id = IdentifierSchema.parse(input.mediaId);
  const annotation_id = IdentifierSchema.parse(input.annotationId);
  await invoke('plugin:lectorbit|annotations_remove', {
    args: { media_id, annotation_id },
  }).catch(wrapAnnotationError);
}

function wrapAnnotationError(error: unknown): never {
  const parsed = AnnotationErrorSchema.safeParse(error);
  if (parsed.success) {
    throw new AnnotationRpcError(parsed.data.kind, parsed.data.message);
  }
  throw new AnnotationRpcError('internal', 'The local learning trail is unavailable.');
}
