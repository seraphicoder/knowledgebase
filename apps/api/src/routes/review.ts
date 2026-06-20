import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { writeAudit } from '../lib/audit.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';
import { publishExtraction, type ExtractionForPublish } from '../pipeline/kb-publish.js';

// Milestone 3 — Review Queue. Humans qualify AI-drafted extractions before they
// become KB articles: edit the draft, then approve or reject. Every query is
// scoped by the org_id from the auth context, never from client input.

export const review = new Hono<{ Variables: AuthVars }>();
review.use('*', requireAuth);

// Who may qualify drafts. Viewers are read-only.
const REVIEWER_ROLES = new Set(['admin', 'reviewer', 'sme']);
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

// ─── POST /api/extractions/:id/approve | /reject ────────────
// Approve = publish to the KB. Reject = mark rejected. Both only act on drafts
// still pending, keeping the action idempotent and auditable.
review.post('/extractions/:id/approve', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canReview(role)) return c.json({ error: 'Only reviewers can qualify drafts' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing extraction id' }, 400);
  const db = getServiceClient();

  // Load the pending draft (org-scoped) including its embedding to copy to the article.
  const { data: e, error } = await db
    .from('extractions')
    .select('id, question, answer, title, category, tags, caveats, embedding')
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('status', 'pending_review')
    .single();
  if (error || !e) return c.json({ error: 'No pending extraction with that id' }, 404);

  await db
    .from('extractions')
    .update({ reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq('id', id);
  try {
    const articleId = await publishExtraction(db, orgId, userId, e as ExtractionForPublish);
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
