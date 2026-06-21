import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// Shared user-provisioning used by both org-admin invites and super-admin org
// creation. Creates a Supabase Auth user with instant access (email pre-confirmed,
// no verification email — so no SMTP dependency) and links it to an org in
// public.users. Returns a one-time temp password for the admin to hand off.

/** URL-safe, ~16-char temporary password (caller surfaces it once). */
export function generateTempPassword(): string {
  return randomBytes(12).toString('base64url'); // 16 chars, mixed case + digits
}

export interface ProvisionResult {
  userId: string;
  tempPassword: string;
}

/**
 * Create an auth user (pre-confirmed) and its public.users row for `orgId`.
 * If the profile insert fails, the orphaned auth user is cleaned up so a retry
 * with the same email can succeed. Throws Error with a user-facing message.
 */
export async function provisionUser(
  db: SupabaseClient,
  opts: { email: string; orgId: string; role: string },
): Promise<ProvisionResult> {
  const email = opts.email.trim().toLowerCase();
  const tempPassword = generateTempPassword();

  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true, // instant access — no confirmation email
  });
  if (createErr || !created.user) {
    // Supabase returns a 422 with this message when the email already exists.
    const msg = createErr?.message ?? 'Failed to create user';
    throw new Error(/already.*registered|already.*exist/i.test(msg) ? 'A user with that email already exists' : msg);
  }

  const userId = created.user.id;
  const { error: profErr } = await db.from('users').insert({
    id: userId,
    org_id: opts.orgId,
    email,
    role: opts.role,
  });
  if (profErr) {
    // Roll back the auth user so the email isn't left half-provisioned.
    await db.auth.admin.deleteUser(userId).catch(() => {});
    throw new Error(`Failed to link user to org: ${profErr.message}`);
  }

  return { userId, tempPassword };
}
