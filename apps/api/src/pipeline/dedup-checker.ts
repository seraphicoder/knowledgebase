import { getServiceClient } from '../lib/supabase.js';

// Vector dedup gate. Before the Sonnet pass, compares a thread's embedding
// against existing extractions for the same org via pgvector cosine distance.
//   > 0.92 similarity  -> duplicate (skip)
//   0.85–0.92          -> potential_merge (proceed, but flag)
//   < 0.85             -> novel (proceed)
// Requires the match_extractions RPC (see migration 005).

export const DUPLICATE_THRESHOLD = 0.92;
export const MERGE_THRESHOLD = 0.85;

export type DedupVerdict = 'duplicate' | 'potential_merge' | 'novel';

export interface DedupResult {
  verdict: DedupVerdict;
  topSimilarity: number;
  similarExtractionIds: string[];
}

export async function checkDuplicate(orgId: string, embedding: number[]): Promise<DedupResult> {
  const { data, error } = await getServiceClient().rpc('match_extractions', {
    p_org_id: orgId,
    p_query_embedding: embedding as unknown as string,
    p_match_count: 5,
  });
  if (error) throw new Error(`dedup match query failed: ${error.message}`);

  const matches = (data ?? []) as { id: string; similarity: number }[];
  const top = matches[0];
  if (!top) return { verdict: 'novel', topSimilarity: 0, similarExtractionIds: [] };

  const ids = matches
    .filter((m) => m.similarity >= MERGE_THRESHOLD)
    .map((m) => m.id);

  if (top.similarity > DUPLICATE_THRESHOLD) {
    return { verdict: 'duplicate', topSimilarity: top.similarity, similarExtractionIds: ids };
  }
  if (top.similarity >= MERGE_THRESHOLD) {
    return { verdict: 'potential_merge', topSimilarity: top.similarity, similarExtractionIds: ids };
  }
  return { verdict: 'novel', topSimilarity: top.similarity, similarExtractionIds: [] };
}
