import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { writeAudit } from '../lib/audit.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';
import { generateSuggestion } from '../pipeline/ticket-agent.js';
import { embedText, toVector } from '../pipeline/embedder.js';

// Reply agent API. Generate a grounded suggested reply for a ticket (thread),
// review/accept/edit/discard it, and score it — SME scores feed verified_pairs,
// which become priority retrieval context for future suggestions. NEVER sends.

export const tickets = new Hono<{ Variables: AuthVars }>();
tickets.use('*', requireAuth);

const AGENT_ROLES = new Set(['admin', 'reviewer', 'sme', 'member']);
const canAct = (role: string): boolean => AGENT_ROLES.has(role);

// ─── POST /api/tickets/:threadId/suggest ────────────────────
tickets.post('/tickets/:threadId/suggest', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, role } = c.get('auth');
  if (!canAct(role)) return c.json({ error: 'Not permitted' }, 403);
  const threadId = c.req.param('threadId');
  if (!threadId) return c.json({ error: 'Missing thread id' }, 400);
  const db = getServiceClient();

  const { data: thread, error } = await db
    .from('email_threads')
    .select('id, raw_content')
    .eq('org_id', orgId)
    .eq('id', threadId)
    .single();
  if (error || !thread) return c.json({ error: 'Thread not found' }, 404);

  try {
    const s = await generateSuggestion(orgId, {
      threadId: thread.id as string,
      content: (thread.raw_content as string | null) ?? '',
    });
    return c.json({ suggestion: s });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Suggestion failed' }, 500);
  }
});

// ─── POST /api/suggestions/draft — ad-hoc pasted ticket ─────
const draftSchema = z.object({ text: z.string().trim().min(1) });

tickets.post('/suggestions/draft', async (c) => {
  const { orgId, role } = c.get('auth');
  if (!canAct(role)) return c.json({ error: 'Not permitted' }, 403);
  const parsed = draftSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Paste some ticket text' }, 400);
  try {
    const s = await generateSuggestion(orgId, { content: parsed.data.text });
    return c.json({ suggestion: s });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Suggestion failed' }, 500);
  }
});

// ─── GET /api/suggestions?status= ───────────────────────────
tickets.get('/suggestions', async (c) => {
  const { orgId } = c.get('auth');
  const status = c.req.query('status');
  let q = getServiceClient()
    .from('ticket_suggestions')
    .select('id, source_thread_id, suggested_reply, confidence_score, status, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ suggestions: data ?? [] });
});

// ─── GET /api/suggestions/:id — detail + resolved sources ───
tickets.get('/suggestions/:id', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId } = c.get('auth');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing id' }, 400);
  const db = getServiceClient();

  const { data: s, error } = await db
    .from('ticket_suggestions')
    .select('id, source_thread_id, ticket_text, suggested_reply, confidence_score, retrieved_article_ids, retrieved_thread_ids, status, final_reply, created_at')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (error || !s) return c.json({ error: 'Suggestion not found' }, 404);

  const threadId = s.source_thread_id as string | null;
  const [ticket, articles, sources] = await Promise.all([
    threadId
      ? db.from('email_threads').select('id, subject').eq('org_id', orgId).eq('id', threadId).single()
      : Promise.resolve({ data: null }),
    db.from('kb_articles').select('id, title').eq('org_id', orgId).in('id', (s.retrieved_article_ids as string[]) ?? []),
    db.from('email_threads').select('id, subject').eq('org_id', orgId).in('id', (s.retrieved_thread_ids as string[]) ?? []),
  ]);
  const review = await db
    .from('sme_reviews')
    .select('verdict, accuracy_score, completeness_score, corrected_answer, notes, reviewed_at')
    .eq('org_id', orgId)
    .eq('suggestion_id', id)
    .order('reviewed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return c.json({
    suggestion: s,
    ticketText: (s.ticket_text as string | null) ?? null,
    ticket: ticket.data ?? null, // source thread (id, subject) if it came from one
    citedArticles: articles.data ?? [],
    citedThreads: sources.data ?? [],
    review: review.data ?? null,
  });
});

// ─── POST /api/suggestions/:id/decision — accept/edit/discard ──
const decisionSchema = z.object({
  status: z.enum(['accepted', 'edited', 'discarded']),
  finalReply: z.string().optional(),
});

tickets.post('/suggestions/:id/decision', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canAct(role)) return c.json({ error: 'Not permitted' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing id' }, 400);
  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);

  const { data, error } = await getServiceClient()
    .from('ticket_suggestions')
    .update({ status: parsed.data.status, final_reply: parsed.data.finalReply ?? null })
    .eq('org_id', orgId)
    .eq('id', id)
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'Suggestion not found' }, 404);

  await writeAudit({ orgId, userId, action: `suggestion.${parsed.data.status}`, resource: 'ticket_suggestions', resourceId: id });
  return c.json({ ok: true });
});

// ─── POST /api/suggestions/:id/review — SME score -> verified pair ──
const reviewSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'wrong']),
  accuracyScore: z.number().int().min(0).max(100).optional(),
  completenessScore: z.number().int().min(0).max(100).optional(),
  correctedAnswer: z.string().optional(),
  notes: z.string().optional(),
});

tickets.post('/suggestions/:id/review', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canAct(role)) return c.json({ error: 'Only reviewers/SMEs can score suggestions' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing id' }, 400);
  const parsed = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
  const db = getServiceClient();

  const { data: s, error } = await db
    .from('ticket_suggestions')
    .select('id, source_thread_id, ticket_text, suggested_reply, final_reply')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (error || !s) return c.json({ error: 'Suggestion not found' }, 404);

  const { data: review, error: revErr } = await db
    .from('sme_reviews')
    .insert({
      org_id: orgId,
      suggestion_id: id,
      reviewer_id: userId,
      accuracy_score: parsed.data.accuracyScore ?? null,
      completeness_score: parsed.data.completenessScore ?? null,
      verdict: parsed.data.verdict,
      corrected_answer: parsed.data.correctedAnswer ?? null,
      notes: parsed.data.notes ?? null,
    })
    .select('id')
    .single();
  if (revErr) return c.json({ error: revErr.message }, 500);

  // Correct/partial reviews become verified Q&A pairs — ground truth that gets
  // priority retrieval on future tickets.
  let verifiedPairId: string | null = null;
  if (parsed.data.verdict !== 'wrong') {
    const answer = parsed.data.correctedAnswer?.trim() || (s.final_reply as string) || (s.suggested_reply as string) || '';
    // Question for the verified pair: source thread subject if any, else the
    // pasted ticket text.
    let question = ((s.ticket_text as string | null) ?? '').slice(0, 300);
    if (s.source_thread_id) {
      const { data: th } = await db
        .from('email_threads')
        .select('subject')
        .eq('org_id', orgId)
        .eq('id', s.source_thread_id as string)
        .single();
      if (th?.subject) question = th.subject as string;
    }
    if (answer && question) {
      try {
        const emb = toVector(await embedText(question));
        const { data: vp } = await db
          .from('verified_pairs')
          .insert({
            org_id: orgId,
            question,
            answer,
            source_review_id: review.id as string,
            embedding: emb,
            accuracy_score: parsed.data.accuracyScore ?? null,
          })
          .select('id')
          .single();
        verifiedPairId = (vp?.id as string) ?? null;
      } catch {
        // Embedding/insert failure shouldn't fail the review.
      }
    }
  }

  await writeAudit({
    orgId, userId, action: 'suggestion.reviewed', resource: 'sme_reviews',
    resourceId: review.id as string, metadata: { verdict: parsed.data.verdict, verifiedPairId },
  });
  return c.json({ ok: true, verifiedPairId });
});
