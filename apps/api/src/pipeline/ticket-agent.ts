import { getServiceClient } from '../lib/supabase.js';
import { getAnthropic, MODELS } from '../lib/ai.js';
import { withRetry, isRetryableHttpStatus } from '../lib/retry.js';
import { writeAudit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import { embedText, toVector } from './embedder.js';
import { extractJson } from './relevance-scorer.js';

// Incoming-ticket reply agent (Milestone 5, Layer 2). Retrieves the most relevant
// KB articles, similar past threads, and SME-verified pairs, then asks Sonnet to
// draft a reply grounded ONLY in that context. NEVER sends — produces a suggestion
// a human edits/copies. Stored in ticket_suggestions.

interface KbHit { id: string; title: string; body: string; similarity: number }
interface ThreadHit { id: string; subject: string | null; raw_content: string | null; similarity: number }
interface PairHit { id: string; question: string; answer: string; similarity: number }

export interface SuggestionResult {
  id: string;
  suggestedReply: string;
  confidence: number;
  retrievedArticleIds: string[];
  retrievedThreadIds: string[];
}

const SYSTEM = `You are a support agent drafting a reply to a customer ticket.
Use ONLY the provided knowledge base articles, similar past resolved threads, and verified answers as your source of truth. Prefer verified answers, then KB articles.
Write a professional, concise reply that resolves the ticket. If the provided context does not actually cover the question, say you don't have enough information to answer confidently and suggest escalating to a specialist — do NOT invent product specifics.
Return ONLY valid JSON, no markdown: {"reply": string, "confidence": number}  // confidence 0-100 that your reply is accurate and complete.`;

export async function generateSuggestion(
  orgId: string,
  input: { threadId?: string | null; content: string },
): Promise<SuggestionResult> {
  const content = (input.content ?? '').trim();
  if (!content) throw new Error('Ticket has no content to answer');
  const threadId = input.threadId ?? null;

  const db = getServiceClient();
  const vec = toVector(await embedText(content));

  // Parallel retrieval (exclude the ticket's own thread when it is one).
  const [kbRes, thRes, vpRes] = await Promise.all([
    db.rpc('match_kb_articles', { p_org_id: orgId, p_query_embedding: vec, p_match_count: 5 }),
    db.rpc('match_email_threads', { p_org_id: orgId, p_query_embedding: vec, p_match_count: 5, p_exclude: threadId }),
    db.rpc('match_verified_pairs', { p_org_id: orgId, p_query_embedding: vec, p_match_count: 3 }),
  ]);
  const articles = (kbRes.data ?? []) as KbHit[];
  const threads = (thRes.data ?? []) as ThreadHit[];
  const pairs = (vpRes.data ?? []) as PairHit[];

  const contextBlock = buildContext(articles, threads, pairs);
  const userMsg = `CUSTOMER TICKET:\n${content.slice(0, 8000)}\n\n=== CONTEXT ===\n${contextBlock || '(no relevant knowledge found)'}`;

  const res = await withRetry(
    () =>
      getAnthropic().messages.create({
        model: MODELS.extraction,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
      }),
    {
      label: 'anthropic.ticket-reply',
      maxAttempts: 3,
      baseDelayMs: 1000,
      isRetryable: (err) => isRetryableHttpStatus((err as { status?: number })?.status),
    },
  );

  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  const { reply, claudeConfidence } = parseReply(text);

  const similarities = [...articles, ...pairs].map((h) => h.similarity);
  const confidence = composeConfidence(claudeConfidence, similarities, pairs.length > 0);

  const retrievedArticleIds = articles.map((a) => a.id);
  const retrievedThreadIds = threads.map((t) => t.id);

  const { data: inserted, error } = await db
    .from('ticket_suggestions')
    .insert({
      org_id: orgId,
      source_thread_id: threadId,
      ticket_text: content,
      suggested_reply: reply,
      confidence_score: confidence,
      retrieved_article_ids: retrievedArticleIds,
      retrieved_thread_ids: retrievedThreadIds,
      status: 'pending_review',
    })
    .select('id')
    .single();
  if (error) throw new Error(`ticket suggestion insert failed: ${error.message}`);

  await writeAudit({
    orgId, userId: null, action: 'suggestion.created', resource: 'ticket_suggestions',
    resourceId: inserted.id as string, metadata: { threadId, confidence },
  });
  log.info('ticket suggestion created', { orgId, threadId, confidence });

  return { id: inserted.id as string, suggestedReply: reply, confidence, retrievedArticleIds, retrievedThreadIds };
}

function buildContext(articles: KbHit[], threads: ThreadHit[], pairs: PairHit[]): string {
  const parts: string[] = [];
  for (const p of pairs) {
    parts.push(`[VERIFIED ANSWER]\nQ: ${p.question}\nA: ${p.answer}`);
  }
  for (const a of articles) {
    parts.push(`[KB ARTICLE: ${a.title}]\n${a.body.slice(0, 1500)}`);
  }
  for (const t of threads) {
    parts.push(`[PAST THREAD: ${t.subject ?? '(no subject)'}]\n${(t.raw_content ?? '').slice(0, 1200)}`);
  }
  return parts.join('\n\n---\n\n');
}

function parseReply(text: string): { reply: string; claudeConfidence: number } {
  try {
    const parsed = JSON.parse(extractJson(text)) as { reply?: unknown; confidence?: unknown };
    const reply = typeof parsed.reply === 'string' ? parsed.reply : '';
    const conf = clamp(Number(parsed.confidence), 0, 100);
    if (reply) return { reply, claudeConfidence: Number.isNaN(conf) ? 0 : conf };
  } catch {
    // fall through
  }
  // Fallback: use the raw text as the reply with low confidence.
  return { reply: text.trim() || 'Unable to draft a reply.', claudeConfidence: 0 };
}

/**
 * Composite confidence (0-100): blends Claude's self-rating with how strong the
 * retrieved context was, nudges up when a verified pair backs it, and caps low
 * when the best match is weak (so "high confidence" requires real KB coverage).
 */
export function composeConfidence(claudeConfidence: number, similarities: number[], hasVerified: boolean): number {
  const best = similarities.length ? Math.max(...similarities) : 0;
  const avg = similarities.length ? similarities.reduce((a, b) => a + b, 0) / similarities.length : 0;
  let score = 0.6 * claudeConfidence + 0.4 * (avg * 100);
  if (hasVerified) score += 10;
  if (best < 0.6) score = Math.min(score, 40); // weak coverage -> can't be confident
  return Math.round(clamp(score, 0, 100));
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
