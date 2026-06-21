import { createEmbedding, MODELS } from '../lib/ai.js';
import { withRetry, isRetryableHttpStatus } from '../lib/retry.js';

// Generates embeddings via OpenAI text-embedding-3-small (1536 dims).
// First AI-adjacent call in the pipeline — only ever invoked by the pipeline
// runner on already-approved threads. OpenAI accepts up to 2048 inputs/request.

const MAX_BATCH = 2048;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await withRetry(
      () => createEmbedding({ model: MODELS.embedding, input: batch }, 'embedding'),
      {
        label: 'openai.embeddings',
        maxAttempts: 3,
        baseDelayMs: 1000,
        isRetryable: (err) => isRetryableHttpStatus((err as { status?: number })?.status),
      },
    );
    // Preserve input order.
    for (const item of res.data.sort((a, b) => a.index - b.index)) out.push(item.embedding);
  }
  return out;
}

export async function embedText(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  if (!vec) throw new Error('Embedding returned no vector');
  return vec;
}

/**
 * pgvector's canonical text input is `[1,2,3]`. Passing a raw JS array to a
 * vector column/param via PostgREST is ambiguous, so always serialize through
 * this for inserts and RPC args.
 */
export function toVector(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
