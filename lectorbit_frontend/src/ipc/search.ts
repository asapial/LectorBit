import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const SearchHitSchema = z.object({
  media_id: z.string().min(1),
  display_name: z.string().min(1),
  plan_item_id: z.string().nullable(),
  source: z.enum(['media', 'transcript', 'annotation']),
  start_ms: z.number().int().nonnegative().nullable(),
  end_ms: z.number().int().nonnegative().nullable(),
  snippet: z.string(),
  score: z.number().int().min(0).max(100),
});

const SearchErrorSchema = z.object({
  kind: z.enum(['invalid_input', 'database', 'internal']),
  message: z.string(),
});

export type SearchHit = z.infer<typeof SearchHitSchema>;

export async function searchLibrary(text: string, limit = 30): Promise<SearchHit[]> {
  try {
    return z.array(SearchHitSchema).parse(
      await invoke<unknown>('plugin:lectorbit|search_query', {
        args: { text, limit },
      }),
    );
  } catch (error) {
    const parsed = SearchErrorSchema.safeParse(error);
    if (parsed.success) throw new Error(parsed.data.message, { cause: error });
    if (error instanceof z.ZodError) throw error;
    throw new Error('The local search index is unavailable.', { cause: error });
  }
}
