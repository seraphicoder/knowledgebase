import { createMessage, MODELS } from '../lib/ai.js';
import { withRetry, isRetryableHttpStatus } from '../lib/retry.js';
import { extractJson } from './relevance-scorer.js';

// AI-assisted merge: fold a new draft's knowledge into an existing KB article,
// keeping every unique fact, removing redundancy, preserving structure. Returns
// the proposed merged title + body — the caller routes it through human review
// before saving.

const SYSTEM = `You merge a new support Q&A into an existing knowledge base article.
Produce ONE article that:
- keeps every unique, useful fact from BOTH the existing article and the new information,
- does NOT restate or duplicate information already present,
- preserves the existing article's structure, headings, and tone,
- stays accurate — never invent details not present in either input.
Return ONLY valid JSON, no markdown fences: {"title": string, "body": string}  // body is markdown.`;

export interface MergeDraft {
  title: string | null;
  question: string | null;
  answer: string | null;
  caveats: string | null;
}

export async function mergeArticle(
  existing: { title: string; body: string },
  draft: MergeDraft,
): Promise<{ title: string; body: string }> {
  const user = [
    'EXISTING ARTICLE',
    `Title: ${existing.title}`,
    '',
    existing.body,
    '',
    '=== NEW INFORMATION TO MERGE IN ===',
    `Title: ${draft.title ?? ''}`,
    `Question: ${draft.question ?? ''}`,
    `Answer: ${draft.answer ?? ''}`,
    `Caveats: ${draft.caveats ?? ''}`,
  ].join('\n');

  const res = await withRetry(
    () =>
      createMessage(
        {
          model: MODELS.extraction,
          max_tokens: 4000,
          system: SYSTEM,
          messages: [{ role: 'user', content: user.slice(0, 30000) }],
        },
        'merge',
      ),
    {
      label: 'anthropic.merge',
      maxAttempts: 3,
      baseDelayMs: 1000,
      isRetryable: (err) => isRetryableHttpStatus((err as { status?: number })?.status),
    },
  );

  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  try {
    const p = JSON.parse(extractJson(text)) as { title?: unknown; body?: unknown };
    return {
      title: typeof p.title === 'string' && p.title ? p.title : existing.title,
      body: typeof p.body === 'string' && p.body ? p.body : existing.body,
    };
  } catch {
    throw new Error('Failed to parse merge result');
  }
}
