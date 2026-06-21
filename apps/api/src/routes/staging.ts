import { Hono } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { writeAudit, writeAuditBatch, type AuditEntry } from '../lib/audit.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';

// Staging API. The approve routes here are the ONLY code paths permitted to move
// a thread from 'staged' to 'approved'. Every query is scoped by the org_id from
// the auth context, never from client input.

export const staging = new Hono<{ Variables: AuthVars }>();
staging.use('*', requireAuth);

// ─── GET /api/threads/staged ────────────────────────────────
// Lists staged threads. Returns metadata only — NO AI summary/score, since none
// has been generated at staging time.
staging.get('/threads/staged', async (c) => {
  const { orgId } = c.get('auth');
  const db = getServiceClient();

  const sourceId = c.req.query('source_id');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const search = c.req.query('q');
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
  const offset = Number(c.req.query('offset') ?? 0);

  let query = db
    .from('email_threads')
    .select(
      'id, source_id, external_thread_id, subject, participants, message_count, date_range_start, date_range_end, ingested_at',
      { count: 'exact' },
    )
    .eq('org_id', orgId)
    .eq('approval_status', 'staged')
    .range(offset, offset + limit - 1);

  // Server-side sort over the whole dataset (default: newest conversations first).
  query = applyThreadSort(query, c.req.query('sort'), c.req.query('dir'));

  if (sourceId) query = query.eq('source_id', sourceId);
  if (from) query = query.gte('date_range_start', from);
  if (to) query = query.lte('date_range_end', to);
  // Substring match over subject + participants (trigram-indexed search_text).
  if (search) query = query.ilike('search_text', `%${search}%`);

  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 500);

  // Flag which threads carry attachments (e.g. photos) so the list can badge
  // them without loading any image bytes. One scoped query over the page's ids.
  const ids = (data ?? []).map((t) => t.id as string);
  const withCounts = await annotateAttachmentCounts(db, orgId, ids, data ?? []);
  return c.json({ threads: withCounts, total: count ?? 0, limit, offset });
});

// Whitelist of sortable columns → server-side ORDER BY. Unknown/absent sort
// falls back to newest-conversation-first (date_range_end, then ingest order).
function applyThreadSort<
  T extends { order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => T },
>(query: T, sort: string | undefined, dir: string | undefined): T {
  const ascending = dir === 'asc';
  switch (sort) {
    case 'subject':
      return query.order('subject', { ascending });
    case 'source_id':
      return query.order('source_id', { ascending });
    case 'participants':
      return query.order('participants', { ascending });
    case 'message_count':
      return query.order('message_count', { ascending });
    case 'date_range_start':
      return query.order('date_range_start', { ascending, nullsFirst: false });
    default:
      return query
        .order('date_range_end', { ascending: false, nullsFirst: false })
        .order('ingested_at', { ascending: false });
  }
}

// Adds `attachment_count` to each thread row using a single org-scoped query.
async function annotateAttachmentCounts(
  db: ReturnType<typeof getServiceClient>,
  orgId: string,
  threadIds: string[],
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (threadIds.length === 0) return rows;
  const { data: atts } = await db
    .from('attachments')
    .select('thread_id')
    .eq('org_id', orgId)
    .in('thread_id', threadIds);
  const counts = new Map<string, number>();
  for (const a of atts ?? []) {
    const tid = a.thread_id as string;
    counts.set(tid, (counts.get(tid) ?? 0) + 1);
  }
  return rows.map((r) => ({ ...r, attachment_count: counts.get(r.id as string) ?? 0 }));
}

// ─── GET /api/threads/approved ──────────────────────────────
// Approved threads leave the staging list, so this is where you see what's been
// approved and its pipeline state (processing_status). Read-only.
staging.get('/threads/approved', async (c) => {
  const { orgId } = c.get('auth');
  const db = getServiceClient();
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
  const offset = Number(c.req.query('offset') ?? 0);
  const search = c.req.query('q');

  let query = db
    .from('email_threads')
    .select(
      'id, source_id, external_thread_id, subject, participants, message_count, date_range_start, date_range_end, ingested_at, approved_at, processing_status',
      { count: 'exact' },
    )
    .eq('org_id', orgId)
    .eq('approval_status', 'approved')
    .order('date_range_end', { ascending: false, nullsFirst: false })
    .order('approved_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (search) query = query.ilike('search_text', `%${search}%`);

  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ threads: data ?? [], total: count ?? 0, limit, offset });
});

// ─── GET /api/threads/:id — preview cleaned content ─────────
staging.get('/threads/:id', async (c) => {
  const { orgId } = c.get('auth');
  const db = getServiceClient();
  const { data, error } = await db
    .from('email_threads')
    .select('id, subject, participants, message_count, raw_content, date_range_start, date_range_end, approval_status, source_id')
    .eq('org_id', orgId)
    .eq('id', c.req.param('id'))
    .single();
  if (error || !data) return c.json({ error: 'Thread not found' }, 404);
  return c.json({ thread: data });
});

// ─── GET /api/threads/:id/attachments — images w/ signed URLs ──
staging.get('/threads/:id/attachments', async (c) => {
  const { orgId } = c.get('auth');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing thread id' }, 400);
  const db = getServiceClient();

  const { data: rows, error } = await db
    .from('attachments')
    .select('id, filename, content_type, size, storage_path, inline')
    .eq('org_id', orgId)
    .eq('thread_id', id)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  if (!rows || rows.length === 0) return c.json({ attachments: [] });

  // Short-lived signed URLs keep the bucket private and access org-scoped.
  const paths = rows.map((r) => r.storage_path as string);
  const { data: signed, error: sErr } = await db.storage.from('attachments').createSignedUrls(paths, 3600);
  if (sErr) return c.json({ error: sErr.message }, 500);
  const urlByPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  const attachments = rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    content_type: r.content_type,
    inline: r.inline,
    url: urlByPath.get(r.storage_path as string) ?? null,
  }));
  return c.json({ attachments });
});

// ─── POST /api/threads/:id/approve ──────────────────────────
staging.post('/threads/:id/approve', async (c) => {
  const { orgId, userId } = c.get('auth');
  const id = c.req.param('id');
  const db = getServiceClient();

  // Only flip rows that are currently 'staged' and belong to this org.
  const { data, error } = await db
    .from('email_threads')
    .update({ approval_status: 'approved', approved_by: userId, approved_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('approval_status', 'staged')
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'No staged thread with that id' }, 404);

  await writeAudit({
    orgId, userId, action: 'thread.approved', resource: 'email_threads', resourceId: id,
  });
  return c.json({ approved: id });
});

// ─── POST /api/threads/approve-batch ────────────────────────
const batchSchema = z
  .object({
    thread_ids: z.array(z.string().uuid()).optional(),
    source_id: z.string().uuid().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .refine((b) => b.thread_ids?.length || b.source_id || b.from || b.to, {
    message: 'Provide thread_ids or a filter (source_id / from / to)',
  });

staging.post('/threads/approve-batch', async (c) => {
  const { orgId, userId } = c.get('auth');
  const body = batchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Invalid body' }, 400);

  const db = getServiceClient();
  let q = db
    .from('email_threads')
    .update({ approval_status: 'approved', approved_by: userId, approved_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('approval_status', 'staged');

  const { thread_ids, source_id, from, to } = body.data;
  if (thread_ids?.length) q = q.in('id', thread_ids);
  if (source_id) q = q.eq('source_id', source_id);
  if (from) q = q.gte('date_range_start', from);
  if (to) q = q.lte('date_range_end', to);

  const { data, error } = await q.select('id');
  if (error) return c.json({ error: error.message }, 500);

  const ids = (data ?? []).map((r) => r.id as string);
  const audits: AuditEntry[] = ids.map((resourceId) => ({
    orgId, userId, action: 'thread.approved', resource: 'email_threads', resourceId,
  }));
  await writeAuditBatch(audits);
  return c.json({ approved: ids.length, ids });
});

// ─── POST /api/threads/:id/exclude ──────────────────────────
staging.post('/threads/:id/exclude', async (c) => {
  const { orgId, userId } = c.get('auth');
  const id = c.req.param('id');
  const db = getServiceClient();

  const { data, error } = await db
    .from('email_threads')
    .update({ approval_status: 'excluded' })
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('approval_status', 'staged')
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'No staged thread with that id' }, 404);

  await writeAudit({
    orgId, userId, action: 'thread.excluded', resource: 'email_threads', resourceId: id,
  });
  return c.json({ excluded: id });
});
