import { Hono } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';
import { writeAudit } from '../lib/audit.js';
import { encryptConfig } from '../lib/crypto.js';
import { createConnector, type IngestionSourceRow } from '../pipeline/connector-factory.js';
import { ingestSource } from '../pipeline/ingest.js';
import { limitBlock } from '../lib/limits.js';
import { log } from '../lib/logger.js';

// Ingestion source management (admin). Lets an org connect Zendesk and email
// (IMAP) sources from the app — credentials are encrypted server-side via
// lib/crypto — and pull from all active sources together. Mirrors what the
// set-source-credentials / test-ingest CLI scripts do, but in-product.

export const sources = new Hono<{ Variables: AuthVars }>();
sources.use('*', requireAuth);

function requireAdmin(role: string): boolean {
  return role === 'admin';
}

// Per-type config: plaintext (queryable) vs secrets (encrypted into config.credentials).
const zendeskSchema = z.object({
  type: z.literal('zendesk'),
  label: z.string().trim().min(1),
  subdomain: z.string().trim().min(1),
  email: z.string().email(),
  apiToken: z.string().min(1),
});
const imapSchema = z.object({
  type: z.literal('imap'),
  label: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.coerce.number().int().positive().optional(),
  mailbox: z.string().trim().optional(),
  user: z.string().trim().min(1),
  password: z.string().min(1),
});
const createSchema = z.discriminatedUnion('type', [zendeskSchema, imapSchema]);

function buildConfig(data: z.infer<typeof createSchema>): Record<string, unknown> {
  let plaintext: Record<string, unknown>;
  let secrets: Record<string, unknown>;
  if (data.type === 'zendesk') {
    plaintext = { subdomain: data.subdomain };
    secrets = { email: data.email, apiToken: data.apiToken };
  } else {
    plaintext = { host: data.host, port: data.port ?? 993, ...(data.mailbox ? { mailbox: data.mailbox } : {}) };
    secrets = { user: data.user, password: data.password };
  }
  return { ...plaintext, credentials: encryptConfig(JSON.stringify(secrets)) };
}

// Strip secrets from a stored config for safe display (plaintext fields only).
function safeConnection(config: Record<string, unknown>): Record<string, unknown> {
  const { credentials: _omit, ...plain } = config;
  return plain;
}

// ─── GET /api/sources/options — id/type/label for filters ───
// Any org member (used to populate the source filter on Staging/Queued).
sources.get('/sources/options', async (c) => {
  const { orgId } = c.get('auth');
  const { data, error } = await getServiceClient()
    .from('ingestion_sources')
    .select('id, type, label')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ sources: data ?? [] });
});

// ─── GET /api/sources — list org sources (no secrets) ───────
sources.get('/sources', async (c) => {
  const { orgId, role } = c.get('auth');
  if (!requireAdmin(role)) return c.json({ error: 'Admin access required' }, 403);
  const { data, error } = await getServiceClient()
    .from('ingestion_sources')
    .select('id, type, label, status, config, last_synced_at, backfill_complete, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  const list = (data ?? []).map((s) => ({
    id: s.id,
    type: s.type,
    label: s.label,
    status: s.status,
    last_synced_at: s.last_synced_at,
    backfill_complete: s.backfill_complete,
    created_at: s.created_at,
    connection: safeConnection((s.config as Record<string, unknown>) ?? {}),
    configured: !!(s.config as Record<string, unknown>)?.credentials,
  }));
  return c.json({ sources: list });
});

// ─── POST /api/sources — create a source ────────────────────
sources.post('/sources', async (c) => {
  const { orgId, userId, role } = c.get('auth');
  if (!requireAdmin(role)) return c.json({ error: 'Admin access required' }, 403);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);

  const db = getServiceClient();
  const config = buildConfig(parsed.data);
  const { data, error } = await db
    .from('ingestion_sources')
    .insert({ org_id: orgId, type: parsed.data.type, label: parsed.data.label, config, status: 'active' })
    .select('id')
    .single();
  if (error || !data) return c.json({ error: error?.message ?? 'Failed to create source' }, 500);

  await writeAudit({ orgId, userId, action: 'source.created', resource: 'ingestion_sources', resourceId: data.id as string, metadata: { type: parsed.data.type } });
  return c.json({ id: data.id });
});

// ─── PATCH /api/sources/:id — update label/status/credentials ──
const patchSchema = z.object({
  label: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'paused']).optional(),
  // Optional credential rotation (same per-type fields, all optional).
  subdomain: z.string().trim().optional(),
  email: z.string().email().optional(),
  apiToken: z.string().optional(),
  host: z.string().trim().optional(),
  port: z.coerce.number().int().positive().optional(),
  mailbox: z.string().trim().optional(),
  user: z.string().trim().optional(),
  password: z.string().optional(),
});

sources.patch('/sources/:id', async (c) => {
  const { orgId, userId, role } = c.get('auth');
  if (!requireAdmin(role)) return c.json({ error: 'Admin access required' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing source id' }, 400);
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
  const db = getServiceClient();

  const { data: existing } = await db
    .from('ingestion_sources')
    .select('type, config')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (!existing) return c.json({ error: 'Source not found' }, 404);

  const update: Record<string, unknown> = {};
  if (parsed.data.label) update.label = parsed.data.label;
  if (parsed.data.status) update.status = parsed.data.status;

  // Rebuild config if any credential/connection field was supplied.
  const type = existing.type as string;
  const cfg = (existing.config as Record<string, unknown>) ?? {};
  const d = parsed.data;
  const touchesCreds =
    d.subdomain || d.email || d.apiToken || d.host || d.port || d.mailbox || d.user || d.password;
  if (touchesCreds) {
    if (type === 'zendesk') {
      const merged = zendeskSchema.safeParse({
        type, label: parsed.data.label ?? 'x',
        subdomain: d.subdomain ?? cfg.subdomain,
        email: d.email, apiToken: d.apiToken,
      });
      if (!merged.success) return c.json({ error: 'Provide subdomain, email and apiToken to update Zendesk credentials' }, 400);
      update.config = buildConfig(merged.data);
    } else {
      const merged = imapSchema.safeParse({
        type, label: parsed.data.label ?? 'x',
        host: d.host ?? cfg.host,
        port: d.port ?? cfg.port,
        mailbox: d.mailbox ?? cfg.mailbox,
        user: d.user, password: d.password,
      });
      if (!merged.success) return c.json({ error: 'Provide host, user and password to update email credentials' }, 400);
      update.config = buildConfig(merged.data);
    }
  }

  if (Object.keys(update).length === 0) return c.json({ error: 'Nothing to update' }, 400);
  const { error } = await db.from('ingestion_sources').update(update).eq('org_id', orgId).eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  await writeAudit({ orgId, userId, action: 'source.updated', resource: 'ingestion_sources', resourceId: id, metadata: { fields: Object.keys(update) } });
  return c.json({ ok: true });
});

// ─── DELETE /api/sources/:id ────────────────────────────────
sources.delete('/sources/:id', async (c) => {
  const { orgId, userId, role } = c.get('auth');
  if (!requireAdmin(role)) return c.json({ error: 'Admin access required' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing source id' }, 400);
  const { error } = await getServiceClient().from('ingestion_sources').delete().eq('org_id', orgId).eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  await writeAudit({ orgId, userId, action: 'source.deleted', resource: 'ingestion_sources', resourceId: id });
  return c.json({ ok: true });
});

// ─── POST /api/sources/:id/test — verify the live connection ──
sources.post('/sources/:id/test', async (c) => {
  const { orgId, role } = c.get('auth');
  if (!requireAdmin(role)) return c.json({ error: 'Admin access required' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing source id' }, 400);
  const { data } = await getServiceClient()
    .from('ingestion_sources')
    .select('id, org_id, type, config')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (!data) return c.json({ error: 'Source not found' }, 404);
  try {
    const connector = createConnector(data as IngestionSourceRow);
    const ok = await connector.testConnection();
    return c.json({ ok });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'Connection test failed' });
  }
});

// ─── POST /api/sources/ingest — pull from ALL active sources ──
// Backgrounded (202) like the pipeline run; progress polled via /sources/ingest/status.
const running = new Set<string>();
const ingestSchema = z.object({ limit: z.coerce.number().int().positive().max(500).optional() });

// Forward sync: each pull resumes the source's cursor and fetches records created
// after it, so a caught-up source pulls only genuinely-new ones (no dup churn).
// This caps how many records a single run pulls; the cursor advances either way,
// so clicking again continues forward. Bulk historical catch-up: the CLI.
const DEFAULT_INGEST_LIMIT = 25;
// Hard cap per source so a hung/stalled connector can't wedge the run (and the
// in-memory `running` flag) forever — the run always settles and clears the flag.
const PER_SOURCE_TIMEOUT_MS = 5 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

sources.post('/sources/ingest', async (c) => {
  const { orgId, userId, role } = c.get('auth');
  if (!requireAdmin(role)) return c.json({ error: 'Admin access required' }, 403);
  const parsed = ingestSchema.safeParse(await c.req.json().catch(() => ({})));
  const limit = (parsed.success && parsed.data.limit) || DEFAULT_INGEST_LIMIT;
  if (running.has(orgId)) return c.json({ ok: true, started: false, alreadyRunning: true });

  const blocked = await limitBlock(orgId, ['ingest', 'storage']);
  if (blocked) return c.json({ error: blocked }, 403);

  const db = getServiceClient();
  const { data: srcs } = await db
    .from('ingestion_sources')
    .select('id, org_id, type, config')
    .eq('org_id', orgId)
    .eq('status', 'active');

  running.add(orgId);
  void runIngest(orgId, userId, (srcs ?? []) as IngestionSourceRow[], limit)
    .catch((err) => log.error('ingest-all failed', { orgId, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => running.delete(orgId));
  return c.json({ ok: true, started: true }, 202);
});

// ─── POST /api/sources/:id/ingest — pull ONE source ─────────
sources.post('/sources/:id/ingest', async (c) => {
  const { orgId, userId, role } = c.get('auth');
  if (!requireAdmin(role)) return c.json({ error: 'Admin access required' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing source id' }, 400);
  const parsed = ingestSchema.safeParse(await c.req.json().catch(() => ({})));
  const limit = (parsed.success && parsed.data.limit) || DEFAULT_INGEST_LIMIT;
  if (running.has(orgId)) return c.json({ ok: true, started: false, alreadyRunning: true });

  const blocked = await limitBlock(orgId, ['ingest', 'storage']);
  if (blocked) return c.json({ error: blocked }, 403);

  const db = getServiceClient();
  const { data: src } = await db
    .from('ingestion_sources')
    .select('id, org_id, type, config')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (!src) return c.json({ error: 'Source not found' }, 404);

  running.add(orgId);
  void runIngest(orgId, userId, [src as IngestionSourceRow], limit)
    .catch((err) => log.error('source ingest failed', { orgId, sourceId: id, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => running.delete(orgId));
  return c.json({ ok: true, started: true }, 202);
});

sources.get('/sources/ingest/status', async (c) => {
  const { orgId } = c.get('auth');
  const { data } = await getServiceClient()
    .from('audit_log')
    .select('action, metadata, created_at')
    .eq('org_id', orgId)
    .in('action', ['ingest.run_started', 'ingest.run_finished'])
    .order('created_at', { ascending: false })
    .limit(1);
  const last = data?.[0];
  const lastFinished = last && last.action === 'ingest.run_finished' ? { stats: last.metadata, at: last.created_at } : null;
  return c.json({ running: running.has(orgId), lastFinished });
});

async function runIngest(orgId: string, userId: string, list: IngestionSourceRow[], limit?: number): Promise<void> {
  await writeAudit({ orgId, userId, action: 'ingest.run_started', resource: 'ingestion_sources', resourceId: orgId, metadata: { sources: list.length, limit: limit ?? null } });

  let inserted = 0;
  let duplicates = 0;
  let errored = 0;
  const perSource: Record<string, unknown>[] = [];
  for (const src of list) {
    try {
      const r = await withTimeout(ingestSource(src, { limit }), PER_SOURCE_TIMEOUT_MS, `ingest ${src.type}`);
      inserted += r.inserted;
      duplicates += r.duplicatesSkipped;
      perSource.push({ id: src.id, type: src.type, inserted: r.inserted, duplicates: r.duplicatesSkipped, backfillComplete: r.backfillComplete });
    } catch (e) {
      errored++;
      perSource.push({ id: src.id, type: src.type, error: e instanceof Error ? e.message : String(e) });
      log.error('source ingest failed', { sourceId: src.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await writeAudit({ orgId, userId, action: 'ingest.run_finished', resource: 'ingestion_sources', resourceId: orgId, metadata: { sources: list.length, inserted, duplicates, errored, perSource } });
  log.info('ingest-all complete', { orgId, sources: list.length, inserted, duplicates, errored });
}
