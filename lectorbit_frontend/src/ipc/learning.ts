import { Channel, invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const EvidenceSchema = z.object({
  segment_id: z.number().int().positive(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
});

const EvidencedTextSchema = z.object({
  text: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1),
});

const LectureUnderstandingSchema = z.object({
  artifact_id: z.string().min(1),
  media_id: z.string().min(1),
  transcript_id: z.string().min(1),
  summary: EvidencedTextSchema,
  learning_objectives: z.array(EvidencedTextSchema),
  chapters: z.array(
    z.object({
      title: z.string().min(1),
      summary: z.string().min(1),
      start_ms: z.number().int().nonnegative(),
      end_ms: z.number().int().positive(),
      evidence: z.array(EvidenceSchema).min(1),
    }),
  ),
  concepts: z.array(
    z.object({
      name: z.string().min(1),
      definition: z.string().min(1),
      evidence: z.array(EvidenceSchema).min(1),
    }),
  ),
  prerequisites: z.array(EvidencedTextSchema),
  key_examples: z.array(EvidencedTextSchema),
  difficulty: z.object({
    level: z.enum(['low', 'medium', 'high']),
    confidence: z.enum(['low', 'medium', 'high']),
    reason: z.string().min(1),
    evidence: z.array(EvidenceSchema).min(1),
  }),
  model: z.string().min(1),
  created_at: z.string().min(1),
});

const ExplanationNoteSchema = z.object({
  id: z.string().min(1),
  media_id: z.string().min(1),
  transcript_id: z.string().min(1).nullable(),
  at_ms: z.number().int().nonnegative(),
  title: z.string().min(1),
  body_markdown: z.string().min(1),
  evidence: z.array(EvidenceSchema),
  model: z.string().min(1),
  frame_grounded: z.boolean(),
  created_at: z.string().min(1),
});

const StudyItemSchema = z.object({
  id: z.string().min(1),
  media_id: z.string().min(1),
  chapter_start_ms: z.number().int().nonnegative().nullable(),
  kind: z.enum(['flashcard', 'multiple_choice', 'short_answer', 'explain_own_words']),
  prompt: z.string().min(1),
  answer: z.string().min(1),
  hint: z.string().min(1).nullable(),
  options: z.array(z.string().min(1)),
  evidence: z.array(EvidenceSchema).min(1),
  due_at: z.string().min(1),
  interval_days: z.number().int().nonnegative(),
  repetitions: z.number().int().nonnegative(),
  ease_milli: z.number().int().min(1300).max(3000),
  last_quality: z.number().int().min(0).max(5).nullable(),
});

const ReviewStateSchema = z.object({
  study_item_id: z.string().min(1),
  due_at: z.string().min(1),
  interval_days: z.number().int().nonnegative(),
  repetitions: z.number().int().nonnegative(),
  ease_milli: z.number().int().min(1300).max(3000),
  last_quality: z.number().int().min(0).max(5).nullable(),
  updated_at: z.string().min(1),
});

const CompanionAnswerSchema = z.object({
  action: z.enum([
    'explain_section',
    'summarize_five_minutes',
    'give_example',
    'quiz_chapter',
    'define_terms',
  ]),
  answer_markdown: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1),
  model: z.string().min(1),
});

const JobSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('lecture_understanding'),
  status: z.enum(['queued', 'running', 'paused', 'retry_wait', 'completed', 'failed', 'cancelled']),
  attempt: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const ProgressSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('queued'), data: z.object({ jobId: z.string().min(1) }) }),
  z.object({ event: z.literal('generating'), data: z.object({ jobId: z.string().min(1) }) }),
  z.object({ event: z.literal('validating'), data: z.object({ jobId: z.string().min(1) }) }),
  z.object({ event: z.literal('completed'), data: z.object({ jobId: z.string().min(1) }) }),
  z.object({
    event: z.literal('failed'),
    data: z.object({ jobId: z.string().min(1), message: z.string().min(1) }),
  }),
]);

const LearningErrorSchema = z.object({
  kind: z.enum([
    'invalid_input',
    'consent_required',
    'not_configured',
    'transcript_unavailable',
    'provider',
    'database',
    'internal',
  ]),
  message: z.string().min(1),
});

export type LearningEvidence = z.infer<typeof EvidenceSchema>;
export type LectureUnderstanding = z.infer<typeof LectureUnderstandingSchema>;
export type ExplanationNote = z.infer<typeof ExplanationNoteSchema>;
export type LearningProgress = z.infer<typeof ProgressSchema>;
export type StudyItem = z.infer<typeof StudyItemSchema>;
export type CompanionAction = z.infer<typeof CompanionAnswerSchema>['action'];
export type CompanionAnswer = z.infer<typeof CompanionAnswerSchema>;

export async function getLectureUnderstanding(
  mediaId: string,
): Promise<LectureUnderstanding | null> {
  return LectureUnderstandingSchema.nullable().parse(
    await invoke<unknown>('plugin:lectorbit|learning_get_lecture_understanding', {
      args: { media_id: mediaId },
    }).catch(wrapLearningError),
  );
}

export async function startLectureUnderstanding(
  mediaId: string,
  consent: boolean,
  onEvent: (event: LearningProgress) => void,
) {
  const channel = new Channel<unknown>();
  channel.onmessage = (value) => {
    const parsed = ProgressSchema.safeParse(value);
    if (parsed.success) onEvent(parsed.data);
  };
  return JobSchema.parse(
    await invoke<unknown>('plugin:lectorbit|learning_start_lecture_understanding', {
      args: { media_id: mediaId, consent },
      onEvent: channel,
    }).catch(wrapLearningError),
  );
}

export async function explainFrame(input: {
  mediaId: string;
  atMs: number;
  imageDataUrl?: string;
  consent: boolean;
}): Promise<ExplanationNote> {
  return ExplanationNoteSchema.parse(
    await invoke<unknown>('plugin:lectorbit|learning_explain_frame', {
      args: {
        media_id: input.mediaId,
        at_ms: input.atMs,
        image_data_url: input.imageDataUrl,
        consent: input.consent,
      },
    }).catch(wrapLearningError),
  );
}

export async function listExplanationNotes(mediaId: string): Promise<ExplanationNote[]> {
  return z.array(ExplanationNoteSchema).parse(
    await invoke<unknown>('plugin:lectorbit|learning_list_explanation_notes', {
      args: { media_id: mediaId },
    }).catch(wrapLearningError),
  );
}

export async function generateStudyMaterials(
  mediaId: string,
  consent: boolean,
): Promise<StudyItem[]> {
  return z.array(StudyItemSchema).parse(
    await invoke<unknown>('plugin:lectorbit|learning_generate_study_materials', {
      args: { media_id: mediaId, consent },
    }).catch(wrapLearningError),
  );
}

export async function listStudyMaterials(mediaId: string): Promise<StudyItem[]> {
  return z.array(StudyItemSchema).parse(
    await invoke<unknown>('plugin:lectorbit|learning_list_study_materials', {
      args: { media_id: mediaId },
    }).catch(wrapLearningError),
  );
}

export async function listDueReviews(
  dueBefore = new Date().toISOString(),
  limit = 50,
): Promise<StudyItem[]> {
  return z.array(StudyItemSchema).parse(
    await invoke<unknown>('plugin:lectorbit|learning_list_due_reviews', {
      args: { due_before: dueBefore, limit },
    }).catch(wrapLearningError),
  );
}

export async function recordReview(input: {
  studyItemId: string;
  quality: number;
  confidence: number;
  responseTimeMs: number;
  answerText?: string;
}) {
  return ReviewStateSchema.parse(
    await invoke<unknown>('plugin:lectorbit|learning_record_review', {
      args: {
        study_item_id: input.studyItemId,
        quality: input.quality,
        confidence: input.confidence,
        response_time_ms: input.responseTimeMs,
        answer_text: input.answerText,
      },
    }).catch(wrapLearningError),
  );
}

export async function askCompanion(input: {
  mediaId: string;
  atMs: number;
  action: CompanionAction;
  consent: boolean;
}): Promise<CompanionAnswer> {
  return CompanionAnswerSchema.parse(
    await invoke<unknown>('plugin:lectorbit|learning_companion', {
      args: {
        media_id: input.mediaId,
        at_ms: input.atMs,
        action: input.action,
        consent: input.consent,
      },
    }).catch(wrapLearningError),
  );
}

function wrapLearningError(error: unknown): never {
  const parsed = LearningErrorSchema.safeParse(error);
  if (parsed.success) throw new Error(parsed.data.message);
  throw new Error('The AI learning service is unavailable.');
}
