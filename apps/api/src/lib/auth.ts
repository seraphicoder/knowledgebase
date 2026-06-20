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

  // Map the auth user to their org + role via public.users.
  const { data: profile, error: profErr } = await db
    .from('users')
    .select('org_id, role')
    .eq('id', userData.user.id)
    .single();
  if (profErr || !profile) return c.json({ error: 'User has no org profile' }, 403);

  c.set('auth', {
    userId: userData.user.id,
    orgId: profile.org_id as string,
    role: profile.role as string,
  });
  await next();
});
