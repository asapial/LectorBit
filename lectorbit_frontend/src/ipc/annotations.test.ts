import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  createLearningAnnotation,
  listLearningAnnotations,
  removeLearningAnnotation,
  setLearningAnnotationReviewed,
} from './annotations';

const annotation = {
  id: 'annotation-1',
  media_id: 'media-1',
  at_ms: 245_000,
  kind: 'question',
  text: 'Why is this the shortest path?',
  reviewed: false,
  created_at: '2026-08-23T00:00:00Z',
  updated_at: '2026-08-23T00:00:00Z',
};

describe('annotation IPC', () => {
  beforeEach(() => invoke.mockReset());

  it('lists, creates, reviews, and removes canonical annotations', async () => {
    invoke
      .mockResolvedValueOnce([annotation])
      .mockResolvedValueOnce(annotation)
      .mockResolvedValueOnce({ ...annotation, reviewed: true })
      .mockResolvedValueOnce(undefined);

    await expect(listLearningAnnotations('media-1')).resolves.toEqual([annotation]);
    await expect(
      createLearningAnnotation({
        mediaId: 'media-1',
        atMs: 245_000,
        kind: 'question',
        text: '  Why is this the shortest path?  ',
      }),
    ).resolves.toEqual(annotation);
    await expect(
      setLearningAnnotationReviewed({
        mediaId: 'media-1',
        annotationId: 'annotation-1',
        reviewed: true,
      }),
    ).resolves.toEqual({ ...annotation, reviewed: true });
    await removeLearningAnnotation({ mediaId: 'media-1', annotationId: 'annotation-1' });

    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin:lectorbit|annotations_list', {
      args: { media_id: 'media-1' },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin:lectorbit|annotations_create', {
      args: {
        media_id: 'media-1',
        at_ms: 245_000,
        kind: 'question',
        text: 'Why is this the shortest path?',
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'plugin:lectorbit|annotations_set_reviewed', {
      args: { media_id: 'media-1', annotation_id: 'annotation-1', reviewed: true },
    });
    expect(invoke).toHaveBeenNthCalledWith(4, 'plugin:lectorbit|annotations_remove', {
      args: { media_id: 'media-1', annotation_id: 'annotation-1' },
    });
  });

  it('rejects invalid text before crossing the native boundary', async () => {
    await expect(
      createLearningAnnotation({
        mediaId: 'media-1',
        atMs: 0,
        kind: 'takeaway',
        text: ' ',
      }),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
