import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { writeAudit } from '../lib/audit.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';
import { publishExtraction, type ExtractionForPublish, type PublishImage } from '../pipeline/kb-publish.js';
import { mergeArticle } from '../pipeline/kb-merge.js';
import { embedText, toVector } from '../pipeline/embedder.js';

// Milestone 3 — Review Queue. Humans qualify AI-drafted extractions before they
// become KB articles: edit the draft, then approve or reject. Every query is
// scoped by the org_id from the auth context, never from client input.

export const review = new Hono<{ Variables: AuthVars }>();
review.use('*', requireAuth);

// Who may qualify drafts. For now every role except read-only 'viewer' can —
// tighten here to differentiate roles later.
const REVIEWER_ROLES = new Set(['admin', 'reviewer', 'sme', 'member']);
const canReview = (role: string): boolean => REVIEWER_ROLES.has(role);

const EXTRACTION_COLS =
  'id, thread_id, title, question, answer, category, tags, confidence, caveats, status, reviewed_at, created_at, metadata';

// ─── GET /api/extractions?status=pending_review ─────────────
review.get('/extractions', async (c) => {
  const { orgId } = c.get('auth');
  const db = getServiceClient();
  const status = c.req.query('status') ?? 'pending_review';
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
  const offset = Number(c.req.query('offset') ?? 0);

  const { data, error, count } = await db
    .from('extractions')
    .select(EXTRACTION_COLS, { count: 'exact' })
    .eq('org_id', orgId)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ extractions: data ?? [], total: count ?? 0, limit, offset });
});

// ─── GET /api/extractions/:id — draft + its source thread ───
review.get('/extractions/:id', async (c) => {
  const { orgId } = c.get('auth');
  const db = getServiceClient();
  const { data, error } = await db
    .from('extractions')
    .select(EXTRACTION_COLS)
    .eq('org_id', orgId)
    .eq('id', c.req.param('id'))
    .single();
  if (error || !data) return c.json({ error: 'Extraction not found' }, 404);

  let thread: unknown = null;
  if (data.thread_id) {
    const { data: t } = await db
      .from('email_threads')
      .select('id, subject, participants, raw_content')
      .eq('org_id', orgId)
      .eq('id', data.thread_id as string)
      .single();
    thread = t ?? null;
  }
  return c.json({ extraction: data, thread });
});

// ─── GET /api/extractions/:id/similar — near-duplicate KB articles ──
// Uses the draft's stored embedding (no new AI call) to surface published
// articles a reviewer might be duplicating.
review.get('/extractions/:id/similar', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId } = c.get('auth');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing id' }, 400);
  const db = getServiceClient();

  const { data: ex, error } = await db
    .from('extractions')
    .select('embedding')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (error || !ex) return c.json({ error: 'Extraction not found' }, 404);
  if (!ex.embedding) return c.json({ similar: [] });

  const { data, error: mErr } = await db.rpc('match_kb_articles', {
    p_org_id: orgId,
    p_query_embedding: ex.embedding as unknown as string, // stored pgvector text form
    p_match_count: 5,
  });
  if (mErr) return c.json({ error: mErr.message }, 500);

  const similar = ((data ?? []) as { id: string; title: string; similarity: number }[]).map((a) => ({
    id: a.id,
    title: a.title,
    similarity: a.similarity,
  }));
  return c.json({ similar });
});

// ─── PATCH /api/extractions/:id — edit the draft ────────────
const editSchema = z
  .object({
    title: z.string().optional(),
    question: z.string().optional(),
    answer: z.string().optional(),
    category: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    caveats: z.string().nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

review.patch('/extractions/:id', async (c) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canReview(role)) return c.json({ error: 'Only reviewers can edit drafts' }, 403);
  const id = c.req.param('id');
  const parsed = editSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);

  const db = getServiceClient();
  const { data, error } = await db
    .from('extractions')
    .update(parsed.data)
    .eq('org_id', orgId)
    .eq('id', id)
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'Extraction not found' }, 404);

  await writeAudit({
    orgId, userId, action: 'extraction.edited', resource: 'extractions', resourceId: id,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return c.json({ ok: true });
});

// ─── POST /api/extractions/:id/merge-preview — propose a merge ──
// Returns Claude's merged title+body (NOT saved) so a human can review/edit it.
const mergePreviewSchema = z.object({ articleId: z.string().uuid() });

review.post('/extractions/:id/merge-preview', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, role } = c.get('auth');
  if (!canReview(role)) return c.json({ error: 'Only reviewers can merge' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing extraction id' }, 400);
  const parsed = mergePreviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Missing articleId' }, 400);
  const db = getServiceClient();

  const [{ data: draft }, { data: article }] = await Promise.all([
    db.from('extractions').select('title, question, answer, caveats').eq('org_id', orgId).eq('id', id).eq('status', 'pending_review').single(),
    db.from('kb_articles').select('id, title, body').eq('org_id', orgId).eq('id', parsed.data.articleId).single(),
  ]);
  if (!draft) return c.json({ error: 'No pending extraction with that id' }, 404);
  if (!article) return c.json({ error: 'Article not found' }, 404);

  try {
    const merged = await mergeArticle(
      { title: article.title as string, body: article.body as string },
      { title: draft.title as string | null, question: draft.question as string | null, answer: draft.answer as string | null, caveats: draft.caveats as string | null },
    );
    return c.json({ merged });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Merge failed' }, 500);
  }
});

// ─── POST /api/extractions/:id/merge — apply the merge ──────
// Updates the existing article (re-embedded, version bumped) and marks the draft
// 'merged' so it leaves the queue without publishing a duplicate.
const mergeApplySchema = z.object({
  articleId: z.string().uuid(),
  title: z.string().min(1),
  body: z.string().min(1),
});

review.post('/extractions/:id/merge', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canReview(role)) return c.json({ error: 'Only reviewers can merge' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing extraction id' }, 400);
  const parsed = mergeApplySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
  const db = getServiceClient();

  const { data: draft } = await db.from('extractions').select('id').eq('org_id', orgId).eq('id', id).eq('status', 'pending_review').single();
  if (!draft) return c.json({ error: 'No pending extraction with that id' }, 404);
  const { data: article } = await db.from('kb_articles').select('id, version').eq('org_id', orgId).eq('id', parsed.data.articleId).single();
  if (!article) return c.json({ error: 'Article not found' }, 404);

  const embedding = toVector(await embedText(`${parsed.data.title}\n${parsed.data.body}`));
  const { error: upErr } = await db
    .from('kb_articles')
    .update({
      title: parsed.data.title,
      body: parsed.data.body,
      embedding,
      version: ((article.version as number) ?? 1) + 1,
      needs_update: false, // updating it resolves any "needs update" flag
      flag_reason: null,
      flagged_by: null,
      flagged_at: null,
    })
    .eq('org_id', orgId)
    .eq('id', parsed.data.articleId);
  if (upErr) return c.json({ error: upErr.message }, 500);

  await db.from('extractions').update({ status: 'merged', reviewed_by: userId, reviewed_at: new Date().toISOString() }).eq('id', id);

  await writeAudit({
    orgId, userId, action: 'article.merged', resource: 'kb_articles',
    resourceId: parsed.data.articleId, metadata: { fromExtraction: id },
  });
  return c.json({ ok: true });
});

// ─── POST /api/extractions/:id/approve | /reject ────────────
// Approve = publish to the KB. Reject = mark rejected. Both only act on drafts
// still pending, keeping the action idempotent and auditable.
review.post('/extractions/:id/approve', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canReview(role)) return c.json({ error: 'Only reviewers can qualify drafts' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing extraction id' }, 400);
  const db = getServiceClient();

  // Load the pending draft (org-scoped) including its embedding + thread for images.
  const { data: e, error } = await db
    .from('extractions')
    .select('id, thread_id, question, answer, title, category, tags, caveats, embedding')
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('status', 'pending_review')
    .single();
  if (error || !e) return c.json({ error: 'No pending extraction with that id' }, 404);

  // Optional curated image set: omitted => publish includes all source images.
  const body = (await c.req.json().catch(() => ({}))) as { images?: PublishImage[] };

  await db
    .from('extractions')
    .update({ reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq('id', id);
  try {
    const articleId = await publishExtraction(db, orgId, userId, e as ExtractionForPublish, body.images);
    return c.json({ ok: true, status: 'published', articleId });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Publish failed' }, 500);
  }
});

review.post('/extractions/:id/reject', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canReview(role)) return c.json({ error: 'Only reviewers can qualify drafts' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing extraction id' }, 400);
  const db = getServiceClient();

  const { data, error } = await db
    .from('extractions')
    .update({ status: 'rejected', reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('status', 'pending_review')
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'No pending extraction with that id' }, 404);

  await writeAudit({
    orgId, userId, action: 'extraction.rejected', resource: 'extractions', resourceId: id,
  });
  return c.json({ ok: true, status: 'rejected' });
});
