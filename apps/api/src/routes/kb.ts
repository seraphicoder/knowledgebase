import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';
import { writeAudit } from '../lib/audit.js';
import { embedText, toVector } from '../pipeline/embedder.js';
import { log } from '../lib/logger.js';

const MANAGER_ROLES = new Set(['admin', 'reviewer', 'sme']);

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
    .select('id, title, category, tags, published_at', { count: 'exact' })
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
    .select('id, title, body, category, tags, published_at, extraction_id')
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

  // Back to draft so it reappears in the Review queue.
  await db
    .from('extractions')
    .update({ status: 'pending_review', reviewed_by: null, reviewed_at: null })
    .eq('org_id', orgId)
    .eq('id', art.extraction_id as string);

  // Remove the live article (cascade clears kb_article_images).
  const { error: delErr } = await db.from('kb_articles').delete().eq('org_id', orgId).eq('id', id);
  if (delErr) return c.json({ error: delErr.message }, 500);

  await writeAudit({
    orgId, userId, action: 'article.unpublished', resource: 'extractions',
    resourceId: art.extraction_id as string, metadata: { articleId: id },
  });
  return c.json({ ok: true, extractionId: art.extraction_id });
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

  // 1. Try semantic search (needs an OpenAI key to embed the query).
  try {
    const embedding = await embedText(q);
    const { data, error } = await db.rpc('match_kb_articles', {
      p_org_id: orgId,
      p_query_embedding: toVector(embedding),
      p_match_count: limit,
    });
    if (error) throw new Error(error.message);
    const results = (data ?? []) as { id: string; title: string; body: string; similarity: number }[];
    if (results.length > 0) return c.json({ mode: 'semantic', results });
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
  return c.json({ mode: 'keyword', results });
});
