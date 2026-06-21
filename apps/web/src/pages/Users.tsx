import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listUsers, updateUserRole, inviteUser, getMe, type OrgUser, type UserRole } from '../lib/api';
import { supabase } from '../lib/supabase';

const ROLES: UserRole[] = ['admin', 'reviewer', 'sme', 'member', 'viewer'];

// Admin-only user management. Assign roles to existing org members. Today every
// role except 'viewer' has the same permissions; this is where you'd start
// differentiating later.
export function Users() {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  // Invite form state.
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('member');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [invited, setInvited] = useState<{ email: string; tempPassword: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers((await listUsers()).users);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load users';
      if (msg.toLowerCase().includes('admin')) setDenied(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void getMe().then((me) => setIsPlatformAdmin(me.isPlatformAdmin)).catch(() => {});
  }, [load]);

  async function onInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteBusy(true);
    setError(null);
    setInvited(null);
    try {
      const res = await inviteUser(email, inviteRole);
      setInvited({ email: res.email, tempPassword: res.tempPassword });
      setInviteEmail('');
      setInviteRole('member');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to invite teammate');
    } finally {
      setInviteBusy(false);
    }
  }

  async function onChangeRole(id: string, role: UserRole) {
    setSavingId(id);
    setError(null);
    try {
      await updateUserRole(id, role);
      setUsers((us) => us.map((u) => (u.id === id ? { ...u, role } : u)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update role');
      await load(); // re-sync if the change was rejected (e.g. last admin)
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex flex-wrap gap-4 text-sm">
            <Link to="/staging" className="text-gray-500 hover:underline">Staging</Link>
            <Link to="/queued" className="text-gray-500 hover:underline">Queued</Link>
            <Link to="/review" className="text-gray-500 hover:underline">Review</Link>
            <Link to="/kb" className="text-gray-500 hover:underline">Knowledge Base</Link>
            <Link to="/replies" className="text-gray-500 hover:underline">Reply Agent</Link>
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
            <span className="font-medium text-gray-900">Users</span>
            {isPlatformAdmin && <Link to="/admin" className="text-indigo-600 hover:underline">Platform</Link>}
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Users &amp; Roles</h1>
          <p className="text-sm text-gray-500">Assign roles to members of your organization.</p>
        </div>
        <button onClick={() => void supabase.auth.signOut()} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          Sign out
        </button>
      </header>

      {denied ? (
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
          Admin access required to manage users.
        </div>
      ) : (
        <>
          {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {/* Invite a teammate — creates a pre-confirmed account with a one-time password. */}
          <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3">
            <h2 className="mb-2 text-sm font-medium text-gray-700">Invite a teammate</h2>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="mb-1 block text-xs text-gray-500">Email</span>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  className="w-64 rounded border border-gray-300 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-gray-500">Role</span>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as UserRole)}
                  className="rounded border border-gray-300 px-2 py-1.5 text-sm"
                >
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <button
                onClick={() => void onInvite()}
                disabled={inviteBusy || !inviteEmail.trim()}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {inviteBusy ? 'Inviting…' : 'Invite'}
              </button>
            </div>
            {invited && (
              <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <p className="font-medium">Account created for {invited.email}.</p>
                <p className="mt-1">
                  Temporary password (shown once — copy and share securely):{' '}
                  <code className="rounded bg-white px-1.5 py-0.5 font-mono text-emerald-800">{invited.tempPassword}</code>
                </p>
              </div>
            )}
          </div>

          <p className="mb-3 text-xs text-gray-400">
            Note: every role except <code className="rounded bg-gray-100 px-1">viewer</code> currently has the same
            permissions. <code className="rounded bg-gray-100 px-1">viewer</code> is read-only.
          </p>
          <div className="overflow-hidden rounded border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Joined</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.id} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-gray-700">{u.email}</td>
                      <td className="px-3 py-2">
                        <select
                          value={u.role}
                          disabled={savingId === u.id}
                          onChange={(e) => void onChangeRole(u.id, e.target.value as UserRole)}
                          className="rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-50"
                        >
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-gray-500">{new Date(u.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
