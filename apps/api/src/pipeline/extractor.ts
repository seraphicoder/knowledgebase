import { getAnthropic, MODELS } from '../lib/ai.js';
import { withRetry, isRetryableHttpStatus } from '../lib/retry.js';
import { extractJson } from './relevance-scorer.js';

// Sonnet extraction pass. A single support thread often covers MULTIPLE distinct
// issues, so this returns an ARRAY of Q&A entries — one per distinct issue that
// has a documented, reusable resolution (possibly empty). The system prompt
// forces JSON-only output; parsing is defensive (try/catch + fallback).

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
A single thread often covers MULTIPLE distinct issues. Identify EACH distinct problem that has a documented, authoritative resolution, and produce one entry per resolved issue.
Rules:
- Produce an entry ONLY for issues that have a clear, reusable answer/resolution.
- Skip unresolved issues, clarifying-question-only exchanges, and one-off miscommunications.
- If the thread contains no reusable resolved knowledge, return an empty array.
Return ONLY valid JSON, no markdown, no preamble, in EXACTLY this shape:
{
  "extractions": [
    {
      "question": string,
      "answer": string,
      "title": string,
      "category": string,
      "tags": string[],
      "confidence": number,    // 0.0-1.0, your confidence this is accurate, reusable knowledge
      "caveats": string | null // version-specific notes, exceptions, or null
    }
  ]
}`;

export class ExtractionParseError extends Error {
  constructor(readonly raw: string) {
    super('Failed to parse extraction JSON');
    this.name = 'ExtractionParseError';
  }
}

export async function extractKnowledge(cleanedContent: string): Promise<ExtractionResult[]> {
  const res = await withRetry(
    () =>
      getAnthropic().messages.create({
        model: MODELS.extraction,
        max_tokens: 4000, // room for several entries from a multi-issue thread
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
  return parseExtractions(text);
}

// Exported for unit testing against mocked model output. Accepts the wrapper
// object `{ "extractions": [...] }`, a bare array, or a single object (back-compat).
// An empty array is valid (no reusable knowledge) — not a parse error.
export function parseExtractions(text: string): ExtractionResult[] {
  const parsed = tryParseJson(text);
  if (parsed === undefined) throw new ExtractionParseError(text);

  let list: unknown[];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { extractions?: unknown }).extractions)) {
    list = (parsed as { extractions: unknown[] }).extractions;
  } else if (parsed && typeof parsed === 'object' && ('question' in parsed || 'answer' in parsed)) {
    list = [parsed]; // single object, back-compat
  } else {
    throw new ExtractionParseError(text);
  }

  return list
    .map(parseOne)
    // Drop entries with no usable content (e.g. model emitted a placeholder).
    .filter((e) => e.question.length > 0 || e.answer.length > 0);
}

function tryParseJson(text: string): unknown | undefined {
  // Prefer the fenced/braced slice; fall back to raw (handles bare arrays, which
  // extractJson's brace-trimming would otherwise mangle).
  for (const candidate of [extractJson(text), text.trim()]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  return undefined;
}

function parseOne(raw: unknown): ExtractionResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    question: str(o.question),
    answer: str(o.answer),
    title: str(o.title),
    category: str(o.category),
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    confidence: clamp01(Number(o.confidence)),
    caveats: typeof o.caveats === 'string' && o.caveats.length > 0 ? o.caveats : null,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
