import { Hono } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { writeAudit } from '../lib/audit.js';
import { requirePlatformAdmin } from '../lib/auth.js';
import { provisionUser } from '../lib/provision.js';

// Vendor (super-admin) console — cross-org. Orgs are vendor-provisioned here:
// create an org + its first admin, list orgs with usage, and suspend/reactivate.
// Gated by requirePlatformAdmin (independent of org membership).

export const platform = new Hono<{ Variables: { platformUserId: string } }>();
platform.use('*', requirePlatformAdmin);

const PLANS = ['starter', 'pro', 'enterprise'] as const;

// ─── GET /api/platform/orgs — list orgs + usage counts ──────
platform.get('/platform/orgs', async (c) => {
  const db = getServiceClient();
  const { data: orgs, error } = await db
    .from('organizations')
    .select('id, name, plan, suspended, created_at')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);

  // Per-org counts. Small org counts make N head-queries acceptable; revisit with
  // a single grouped RPC if the org list grows large.
  const withCounts = await Promise.all(
    (orgs ?? []).map(async (o) => {
      const id = o.id as string;
      const [users, threads, articles] = await Promise.all([
        db.from('users').select('id', { count: 'exact', head: true }).eq('org_id', id),
        db.from('email_threads').select('id', { count: 'exact', head: true }).eq('org_id', id),
        db.from('kb_articles').select('id', { count: 'exact', head: true }).eq('org_id', id),
      ]);
      return {
        ...o,
        user_count: users.count ?? 0,
        thread_count: threads.count ?? 0,
        article_count: articles.count ?? 0,
      };
    }),
  );
  return c.json({ orgs: withCounts });
});

// ─── POST /api/platform/orgs — create org + first admin ─────
const createSchema = z.object({
  name: z.string().trim().min(1, 'Org name is required'),
  adminEmail: z.string().email(),
  plan: z.enum(PLANS).default('starter'),
});

platform.post('/platform/orgs', async (c) => {
  const platformUserId = c.get('platformUserId');
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
  const db = getServiceClient();

  const { data: org, error: orgErr } = await db
    .from('organizations')
    .insert({ name: parsed.data.name, plan: parsed.data.plan })
    .select('id, name, plan, suspended, created_at')
    .single();
  if (orgErr || !org) return c.json({ error: orgErr?.message ?? 'Failed to create org' }, 500);

  const orgId = org.id as string;
  try {
    const { userId: adminId, tempPassword } = await provisionUser(db, {
      email: parsed.data.adminEmail,
      orgId,
      role: 'admin',
    });
    await writeAudit({
      orgId, userId: platformUserId, action: 'org.created', resource: 'organizations', resourceId: orgId,
      metadata: { name: parsed.data.name, adminEmail: parsed.data.adminEmail.toLowerCase() },
    });
    return c.json({ org: { ...org, user_count: 1, thread_count: 0, article_count: 0 }, adminEmail: parsed.data.adminEmail.toLowerCase(), tempPassword });
  } catch (e) {
    // Provisioning the admin failed — remove the empty org we just created.
    await db.from('organizations').delete().eq('id', orgId);
    return c.json({ error: e instanceof Error ? e.message : 'Failed to create admin' }, 400);
  }
});

// ─── PATCH /api/platform/orgs/:id — suspend / reactivate ────
const patchSchema = z.object({ suspended: z.boolean() });

platform.patch('/platform/orgs/:id', async (c) => {
  const platformUserId = c.get('platformUserId');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing org id' }, 400);
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400);
  const db = getServiceClient();

  const { data, error } = await db
    .from('organizations')
    .update({ suspended: parsed.data.suspended })
    .eq('id', id)
    .select('id')
    .single();
  if (error || !data) return c.json({ error: error?.message ?? 'Org not found' }, 404);

  await writeAudit({
    orgId: id, userId: platformUserId,
    action: parsed.data.suspended ? 'org.suspended' : 'org.reactivated',
    resource: 'organizations', resourceId: id,
  });
  return c.json({ ok: true, suspended: parsed.data.suspended });
});
