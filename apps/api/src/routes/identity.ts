import { Hono } from 'hono';
import { getServiceClient } from '../lib/supabase.js';

// GET /api/me — current identity. Does its own token validation (rather than
// requireAuth) so a vendor platform-admin account that doesn't belong to any org
// still resolves. Returns the org context when present plus isPlatformAdmin so
// the SPA can route to the org app and/or the super-admin area.
export const identity = new Hono();

identity.get('/me', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return c.json({ error: 'Missing bearer token' }, 401);

  const db = getServiceClient();
  const { data: userData, error } = await db.auth.getUser(token);
  if (error || !userData.user) return c.json({ error: 'Invalid or expired token' }, 401);
  const userId = userData.user.id;

  const [{ data: profile }, { data: pa }] = await Promise.all([
    db.from('users').select('org_id, role, organizations(name, suspended)').eq('id', userId).maybeSingle(),
    db.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
  ]);

  const org = profile
    ? (() => {
        const o = Array.isArray(profile.organizations) ? profile.organizations[0] : profile.organizations;
        return { id: profile.org_id as string, name: (o?.name as string) ?? null, suspended: !!o?.suspended };
      })()
    : null;

  return c.json({
    userId,
    email: userData.user.email ?? null,
    org,
    role: profile?.role ?? null,
    isPlatformAdmin: !!pa,
  });
});
