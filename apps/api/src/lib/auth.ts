import { createMiddleware } from 'hono/factory';
import { getServiceClient } from './supabase.js';

// Resolves the authenticated user's org_id and role from the Supabase JWT and
// pins them onto the request context. Every protected route reads org_id from
// here — NEVER from a request body or query param — so a user can never act on
// another org's data even by guessing a valid UUID. (Architecture Rule #4.)

export interface AuthContext {
  userId: string;
  orgId: string;
  role: string;
}

export type AuthVars = { auth: AuthContext };

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return c.json({ error: 'Missing bearer token' }, 401);

  const db = getServiceClient();
  const { data: userData, error } = await db.auth.getUser(token);
  if (error || !userData.user) return c.json({ error: 'Invalid or expired token' }, 401);

  // Map the auth user to their org + role via public.users, pulling the org's
  // suspended flag in the same round-trip.
  const { data: profile, error: profErr } = await db
    .from('users')
    .select('org_id, role, organizations(suspended)')
    .eq('id', userData.user.id)
    .single();
  if (profErr || !profile) return c.json({ error: 'User has no org profile' }, 403);

  const org = Array.isArray(profile.organizations) ? profile.organizations[0] : profile.organizations;
  if (org?.suspended) return c.json({ error: 'Organization suspended' }, 403);

  c.set('auth', {
    userId: userData.user.id,
    orgId: profile.org_id as string,
    role: profile.role as string,
  });
  await next();
});

// Gate for vendor-level (cross-org) endpoints. Verifies the JWT and that the user
// is listed in platform_admins. Independent of org membership.
export const requirePlatformAdmin = createMiddleware<{ Variables: { platformUserId: string } }>(
  async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return c.json({ error: 'Missing bearer token' }, 401);

    const db = getServiceClient();
    const { data: userData, error } = await db.auth.getUser(token);
    if (error || !userData.user) return c.json({ error: 'Invalid or expired token' }, 401);

    const { data: pa } = await db
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (!pa) return c.json({ error: 'Platform admin access required' }, 403);

    c.set('platformUserId', userData.user.id);
    await next();
  },
);

/** True if the given auth user id is a vendor platform admin. */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await getServiceClient()
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}
