import { createMessage, MODELS } from '../lib/ai.js';
import { withRetry, isRetryableHttpStatus } from '../lib/retry.js';

// Haiku relevance gate. Decides whether a thread contains a question + an
// authoritative answer worth extracting. ~20x cheaper than Sonnet, so it runs
// first to keep the expensive extraction pass off low-signal threads.

export const RELEVANCE_THRESHOLD = 0.4;

export interface RelevanceResult {
  score: number; // 0.0–1.0
  skipReason: string | null;
}

const SYSTEM = `You score support conversation threads for knowledge-base value.
A thread may cover SEVERAL issues. Score HIGH if AT LEAST ONE issue has a clear problem AND an authoritative, reusable resolution — even if other parts of the thread are unresolved, chit-chat, or acknowledgements.
Score LOW only if NO issue in the thread has a reusable resolution (pure chit-chat/acknowledgements, or every issue is left unresolved).
Respond with ONLY valid JSON: {"score": <0.0-1.0 number>, "skip_reason": <string or null>}.
No markdown, no preamble.`;

export async function scoreRelevance(cleanedContent: string): Promise<RelevanceResult> {
  const res = await withRetry(
    () =>
      createMessage(
        {
          model: MODELS.relevance,
          max_tokens: 200,
          system: SYSTEM,
          messages: [{ role: 'user', content: cleanedContent.slice(0, 12000) }],
        },
        'relevance',
      ),
    {
      label: 'anthropic.relevance',
      maxAttempts: 3,
      baseDelayMs: 1000,
      isRetryable: (err) => isRetryableHttpStatus((err as { status?: number })?.status),
    },
  );

  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  try {
    const parsed = JSON.parse(extractJson(text)) as { score: number; skip_reason: string | null };
    const score = clamp01(Number(parsed.score));
    return {
      score,
      skipReason: score < RELEVANCE_THRESHOLD ? parsed.skip_reason ?? 'below_threshold' : null,
    };
  } catch {
    // Unparseable score => treat as low signal rather than passing through.
    return { score: 0, skipReason: 'relevance_parse_error' };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}
