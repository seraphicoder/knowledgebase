import { getAnthropic, MODELS } from '../lib/ai.js';
import { withRetry, isRetryableHttpStatus } from '../lib/retry.js';
import { extractJson } from './relevance-scorer.js';

// Sonnet extraction pass. Returns a strictly-typed Q&A extraction. The system
// prompt forces JSON-only output; parsing is defensive (try/catch + fallback).

export interface ExtractionResult {
  question: string;
  answer: string;
  title: string;
  category: string;
  tags: string[];
  confidence: number; // 0.0–1.0
  caveats: string | null;
}

const SYSTEM = `You extract reusable knowledge-base entries from support conversation threads.
Read the thread and identify the core question and the authoritative answer.
Return ONLY a valid JSON object with EXACTLY these keys, no markdown, no preamble:
{
  "question": string,
  "answer": string,
  "title": string,
  "category": string,
  "tags": string[],
  "confidence": number,   // 0.0-1.0, your confidence this is accurate, reusable knowledge
  "caveats": string | null // version-specific notes, exceptions, or null
}`;

export class ExtractionParseError extends Error {
  constructor(readonly raw: string) {
    super('Failed to parse extraction JSON');
    this.name = 'ExtractionParseError';
  }
}

export async function extractKnowledge(cleanedContent: string): Promise<ExtractionResult> {
  const res = await withRetry(
    () =>
      getAnthropic().messages.create({
        model: MODELS.extraction,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: 'user', content: cleanedContent.slice(0, 30000) }],
      }),
    {
      label: 'anthropic.extraction',
      maxAttempts: 3,
      baseDelayMs: 1000,
      isRetryable: (err) => isRetryableHttpStatus((err as { status?: number })?.status),
    },
  );

  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  return parseExtraction(text);
}

// Exported for unit testing against mocked model output.
export function parseExtraction(text: string): ExtractionResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJson(text)) as Record<string, unknown>;
  } catch {
    throw new ExtractionParseError(text);
  }
  return {
    question: str(parsed.question),
    answer: str(parsed.answer),
    title: str(parsed.title),
    category: str(parsed.category),
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
    confidence: clamp01(Number(parsed.confidence)),
    caveats: typeof parsed.caveats === 'string' && parsed.caveats.length > 0 ? parsed.caveats : null,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
