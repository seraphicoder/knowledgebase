import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { writeAudit } from '../lib/audit.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';

// Domain facts CRUD. These facts ground the extraction prompt (see
// pipeline/domain-facts.ts), so editing them is a privileged action — managers
// only. Every query is scoped by the org_id from the auth context.

export const facts = new Hono<{ Variables: AuthVars }>();
facts.use('*', requireAuth);

const MANAGER_ROLES = new Set(['admin', 'reviewer', 'sme', 'member']);
const canManage = (role: string): boolean => MANAGER_ROLES.has(role);

const COLS = 'id, term, fact, active, created_at, updated_at';

// ─── GET /api/facts — list all facts for the org ────────────
facts.get('/facts', async (c) => {
  const { orgId } = c.get('auth');
  const { data, error } = await getServiceClient()
    .from('domain_facts')
    .select(COLS)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ facts: data ?? [] });
});

const factSchema = z.object({
  term: z.string().trim().min(1).nullable().optional(),
  fact: z.string().trim().min(1),
  active: z.boolean().optional(),
});

// ─── POST /api/facts — create ───────────────────────────────
facts.post('/facts', async (c) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canManage(role)) return c.json({ error: 'Only managers can edit domain facts' }, 403);
  const parsed = factSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);

  const { data, error } = await getServiceClient()
    .from('domain_facts')
    .insert({
      org_id: orgId,
      term: parsed.data.term ?? null,
      fact: parsed.data.fact,
      active: parsed.data.active ?? true,
      created_by: userId,
    })
    .select(COLS)
    .single();
  if (error) return c.json({ error: error.message }, 500);
  await writeAudit({ orgId, userId, action: 'fact.created', resource: 'domain_facts', resourceId: data.id as string });
  return c.json({ fact: data }, 201);
});

const editSchema = z
  .object({
    term: z.string().trim().min(1).nullable().optional(),
    fact: z.string().trim().min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

// ─── PATCH /api/facts/:id — edit / toggle ───────────────────
facts.patch('/facts/:id', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canManage(role)) return c.json({ error: 'Only managers can edit domain facts' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing fact id' }, 400);
  const parsed = editSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);

  const { data, error } = await getServiceClient()
    .from('domain_facts')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', id)
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'Fact not found' }, 404);
  await writeAudit({ orgId, userId, action: 'fact.updated', resource: 'domain_facts', resourceId: id });
  return c.json({ ok: true });
});

// ─── DELETE /api/facts/:id ──────────────────────────────────
facts.delete('/facts/:id', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (!canManage(role)) return c.json({ error: 'Only managers can edit domain facts' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing fact id' }, 400);

  const { data, error } = await getServiceClient()
    .from('domain_facts')
    .delete()
    .eq('org_id', orgId)
    .eq('id', id)
    .select('id');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'Fact not found' }, 404);
  await writeAudit({ orgId, userId, action: 'fact.deleted', resource: 'domain_facts', resourceId: id });
  return c.json({ ok: true });
});
