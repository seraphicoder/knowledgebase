import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { writeAudit } from '../lib/audit.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';

// User & role management. Admin-only. Manages roles of EXISTING users in the org
// (users are created via Supabase Auth + linked in public.users). Every role
// except read-only 'viewer' currently has the same permissions — see the route
// gates — but this is where roles are assigned so differentiation is ready.

export const users = new Hono<{ Variables: AuthVars }>();
users.use('*', requireAuth);

const ROLES = ['admin', 'reviewer', 'sme', 'member', 'viewer'] as const;

// ─── GET /api/me — current user's identity + role ───────────
users.get('/me', (c) => {
  const { userId, orgId, role } = c.get('auth');
  return c.json({ userId, orgId, role });
});

// ─── GET /api/users — list org members (admin) ──────────────
users.get('/users', async (c) => {
  const { orgId, role } = c.get('auth');
  if (role !== 'admin') return c.json({ error: 'Admin access required' }, 403);
  const { data, error } = await getServiceClient()
    .from('users')
    .select('id, email, role, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ users: data ?? [] });
});

// ─── PATCH /api/users/:id — change a member's role (admin) ──
const roleSchema = z.object({ role: z.enum(ROLES) });

users.patch('/users/:id', async (c: Context<{ Variables: AuthVars }>) => {
  const { orgId, userId, role } = c.get('auth');
  if (role !== 'admin') return c.json({ error: 'Admin access required' }, 403);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing user id' }, 400);
  const parsed = roleSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid role' }, 400);
  const db = getServiceClient();

  const { data: target, error: tErr } = await db
    .from('users')
    .select('id, role')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (tErr || !target) return c.json({ error: 'User not found' }, 404);

  // Don't allow removing the org's last admin (avoids lockout).
  if (target.role === 'admin' && parsed.data.role !== 'admin') {
    const { count } = await db
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('role', 'admin');
    if ((count ?? 0) <= 1) return c.json({ error: 'Cannot remove the last admin' }, 400);
  }

  const { error } = await db.from('users').update({ role: parsed.data.role }).eq('org_id', orgId).eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  await writeAudit({
    orgId, userId, action: 'user.role_changed', resource: 'users', resourceId: id,
    metadata: { from: target.role, to: parsed.data.role },
  });
  return c.json({ ok: true });
});
