import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';
import { writeAudit } from '../lib/audit.js';
import { embedText, toVector } from '../pipeline/embedder.js';
import { withOrg } from '../lib/ai-usage.js';
import { log } from '../lib/logger.js';

const MANAGER_ROLES = new Set(['admin', 'reviewer', 'sme', 'member']);

// Knowledge base read + search. Published articles are readable by everyone in
// the org (that's the point of the KB). Search is semantic (pgvector) with a
// keyword fallback when embeddings are unavailable or return nothing. All
// queries are org-scoped from the auth context.

export const kb = new Hono<{ Variables: AuthVars }>();
kb.use('*', requireAuth);

// ─── GET /api/kb — list published articles ──────────────────
kb.get('/kb', async (c) => {
  const { orgId } = c.get('auth');
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
  const offset = Number(c.req.query('offset') ?? 0);
  const { data, error, count } = await getServiceClient()
    .from('kb_articles')
    .select('id, title, category, tags, published_at, needs_update', { count: 'exact' })
    .eq('org_id', orgId)
    .order('published_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ articles: data ?? [], total: count ?? 0 });
});

// ─── GET /api/kb/:id — read one article + its source ────────
kb.get('/kb/:id', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId } = c.get('auth');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing article id' }, 400);
  const db = getServiceClient();

  const { data: article, error } = await db
    .from('kb_articles')
    .select('id, title, body, category, tags, published_at, extraction_id, needs_update, flag_reason, flagged_at')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (error || !article) return c.json({ error: 'Article not found' }, 404);

  // Trace back to the original source thread: article -> extraction -> thread.
  let source: { id: string; subject: string | null } | null = null;
  if (article.extraction_id) {
    const { data: ex } = await db
      .from('extractions')
      .select('thread_id')
      .eq('org_id', orgId)
      .eq('id', article.extraction_id as string)
      .single();
    if (ex?.thread_id) {
      const { data: th } = await db
        .from('email_threads')
        .select('id, subject')
        .eq('org_id', orgId)
        .eq('id', ex.thread_id as string)
        .single();
      source = (th as { id: string; subject: string | null } | null) ?? null;
    }
  }
  return c.json({ article, source });
});

// ─── GET /api/kb/:id/images — the article's curated images ──
kb.get('/kb/:id/images', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId } = c.get('auth');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing article id' }, 400);
  const db = getServiceClient();

  const { data: rows, error } = await db
    .from('kb_article_images')
    .select('id, storage_path, content_type, edited')
    .eq('org_id', orgId)
    .eq('kb_article_id', id)
    .order('position', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  if (!rows || rows.length === 0) return c.json({ images: [] });

  const paths = rows.map((r) => r.storage_path as string);
  const { data: signed, error: sErr } = await db.storage.from('attachments').createSignedUrls(paths, 3600);
  if (sErr) return c.json({ error: sErr.message }, 500);
  const urlByPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  const images = rows.map((r) => ({
    id: r.id,
    content_type: r.content_type,
    edited: r.edited,
    url: urlByPath.get(r.storage_path as string) ?? null,
  }));
  return c.json({ images });
});

// ─── GET /api/kb/:id/comments ───────────────────────────────
kb.get('/kb/:id/comments', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId } = c.get('auth');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing article id' }, 400);
  const db = getServiceClient();

  const { data: comments, error } = await db
    .from('kb_article_comments')
    .select('id, user_id, body, created_at')
    .eq('org_id', orgId)
    .eq('kb_article_id', id)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);

  const rows = comments ?? [];
  const userIds = [...new Set(rows.map((r) => r.user_id as string).filter(Boolean))];
  const emailById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await db.from('users').select('id, email').in('id', userIds);
    for (const u of users ?? []) emailById.set(u.id as string, u.email as string);
  }
  return c.json({
    comments: rows.map((r) => ({
      id: r.id,
      body: r.body,
      created_at: r.created_at,
      author: emailById.get(r.user_id as string) ?? 'unknown',
    })),
  });
});

// ─── POST /api/kb/:id/comments — add a comment (any member) ──
const commentSchema = z.object({ body: z.string().trim().min(1).max(5000) });

kb.post('/kb/:id/comments', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId } = c.get('auth');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing article id' }, 400);
  const parsed = commentSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Comment cannot be empty' }, 400);
  const db = getServiceClient();

  const { data, error } = await db
    .from('kb_article_comments')
    .insert({ org_id: orgId, kb_article_id: id, user_id: userId, body: parsed.data.body })
    .select('id')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  await writeAudit({ orgId, userId, action: 'comment.created', resource: 'kb_article_comments', resourceId: data.id as string, metadata: { articleId: id } });
  return c.json({ ok: true, id: data.id });
});

// ─── POST /api/kb/:id/flag — mark needs update (any member) ──
const flagSchema = z.object({ reason: z.string().trim().max(2000).optional() });

kb.post('/kb/:id/flag', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId } = c.get('auth');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing article id' }, 400);
  const parsed = flagSchema.safeParse(await c.req.json().catch(() => ({})));
  const db = getServiceClient();

  const { data, error } = await db
    .from('kb_articles')
    .update({ needs_update: true, flag_reason: parsed.success ? parsed.data.reason ?? null : null, flagged_by: userId, flagged_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', id)
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'Article not found' }, 404);
  await writeAudit({ orgId, userId, action: 'article.flagged', resource: 'kb_articles', resourceId: id });
  return c.json({ ok: true });
});

// ─── POST /api/kb/:id/unflag — clear the flag (managers) ────
kb.post('/kb/:id/unflag', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!MANAGER_ROLES.has(role)) return c.json({ error: 'Only reviewers can clear flags' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing article id' }, 400);

  const { data, error } = await getServiceClient()
    .from('kb_articles')
    .update({ needs_update: false, flag_reason: null, flagged_by: null, flagged_at: null })
    .eq('org_id', orgId)
    .eq('id', id)
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'Article not found' }, 404);
  await writeAudit({ orgId, userId, action: 'article.unflagged', resource: 'kb_articles', resourceId: id });
  return c.json({ ok: true });
});

// ─── POST /api/kb/:id/unpublish — move article back to draft ──
// Sends the linked extraction back to 'pending_review' and removes the live
// article (cascades its images) so it can be re-edited in Review and re-published.
kb.post('/kb/:id/unpublish', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!MANAGER_ROLES.has(role)) return c.json({ error: 'Only reviewers can edit articles' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing article id' }, 400);
  const db = getServiceClient();

  const { data: art, error } = await db
    .from('kb_articles')
    .select('id, extraction_id')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (error || !art) return c.json({ error: 'Article not found' }, 404);
  if (!art.extraction_id) return c.json({ error: 'This article has no source draft to edit' }, 400);
  const extractionId = art.extraction_id as string;

  // Snapshot the article's curated images onto the draft so the re-edit KEEPS
  // them (including edited versions). Storage objects are intentionally NOT
  // deleted — the reviewer can choose to reset to the originals in Review.
  const { data: imgs } = await db
    .from('kb_article_images')
    .select('storage_path, content_type, edited, source_attachment_id, position')
    .eq('org_id', orgId)
    .eq('kb_article_id', id)
    .order('position', { ascending: true });
  const curatedImages = (imgs ?? []).map((i) => ({
    storage_path: i.storage_path,
    content_type: i.content_type,
    edited: i.edited,
    source_attachment_id: i.source_attachment_id,
  }));

  const { data: ex } = await db.from('extractions').select('metadata').eq('org_id', orgId).eq('id', extractionId).single();
  const meta = (ex?.metadata as Record<string, unknown> | null) ?? {};

  // Back to draft (carrying the curated-image snapshot) so it reappears in Review.
  await db
    .from('extractions')
    .update({ status: 'pending_review', reviewed_by: null, reviewed_at: null, metadata: { ...meta, curated_images: curatedImages } })
    .eq('org_id', orgId)
    .eq('id', extractionId);

  // Remove the live article (cascade clears kb_article_images rows; storage kept).
  const { error: delErr } = await db.from('kb_articles').delete().eq('org_id', orgId).eq('id', id);
  if (delErr) return c.json({ error: delErr.message }, 500);

  await writeAudit({
    orgId, userId, action: 'article.unpublished', resource: 'extractions',
    resourceId: extractionId, metadata: { articleId: id },
  });
  return c.json({ ok: true, extractionId });
});

// ─── POST /api/kb/search — semantic search w/ keyword fallback ──
const searchSchema = z.object({ q: z.string().trim().min(1), limit: z.number().int().positive().max(20).optional() });

kb.post('/kb/search', async (c) => {
  const { orgId } = c.get('auth');
  const parsed = searchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
  const { q } = parsed.data;
  const limit = parsed.data.limit ?? 8;
  const db = getServiceClient();

  // Attach the needs_update flag so search results can show it like the list does.
  async function attachFlags<T extends { id: string }>(rows: T[]): Promise<(T & { needs_update: boolean })[]> {
    if (rows.length === 0) return [];
    const { data } = await db.from('kb_articles').select('id, needs_update').eq('org_id', orgId).in('id', rows.map((r) => r.id));
    const flagged = new Map((data ?? []).map((a) => [a.id as string, a.needs_update as boolean]));
    return rows.map((r) => ({ ...r, needs_update: flagged.get(r.id) ?? false }));
  }

  // 1. Try semantic search (needs an OpenAI key to embed the query).
  try {
    const embedding = await withOrg(orgId, () => embedText(q));
    const { data, error } = await db.rpc('match_kb_articles', {
      p_org_id: orgId,
      p_query_embedding: toVector(embedding),
      p_match_count: limit,
    });
    if (error) throw new Error(error.message);
    const results = (data ?? []) as { id: string; title: string; body: string; similarity: number }[];
    if (results.length > 0) return c.json({ mode: 'semantic', results: await attachFlags(results) });
    // No semantic hits — fall through to keyword so the user still gets something.
  } catch (err) {
    log.info('kb semantic search unavailable, using keyword', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Keyword fallback (no AI required).
  const safe = q.replace(/[%,()]/g, ' ').trim();
  const { data, error } = await db
    .from('kb_articles')
    .select('id, title, body')
    .eq('org_id', orgId)
    .or(`title.ilike.%${safe}%,body.ilike.%${safe}%`)
    .limit(limit);
  if (error) return c.json({ error: error.message }, 500);
  const results = (data ?? []).map((a) => ({ ...a, similarity: null }));
  return c.json({ mode: 'keyword', results: await attachFlags(results) });
});
