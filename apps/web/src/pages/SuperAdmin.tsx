import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listOrgs, createOrg, setOrgSuspended, getPlatformAnalytics, type PlatformOrg, type PlatformAnalytics, type ModelUsage } from '../lib/api';
import { supabase } from '../lib/supabase';

function fmtNum(n: number): string {
  return n.toLocaleString();
}

interface MergedModelUsage {
  provider: string;
  model: string;
  input30: number; output30: number;
  inputAll: number; outputAll: number;
  callsAll: number;
}

// Join the 30-day and all-time per-model usage into one row per model so cost can
// be computed for either window from the same table.
function mergeByModel(last30: ModelUsage[], allTime: ModelUsage[]): MergedModelUsage[] {
  const map = new Map<string, MergedModelUsage>();
  const row = (m: ModelUsage): MergedModelUsage => {
    const key = `${m.provider}:${m.model}`;
    let e = map.get(key);
    if (!e) {
      e = { provider: m.provider, model: m.model, input30: 0, output30: 0, inputAll: 0, outputAll: 0, callsAll: 0 };
      map.set(key, e);
    }
    return e;
  };
  for (const m of last30) {
    const e = row(m);
    e.input30 = m.input;
    e.output30 = m.output;
  }
  for (const m of allTime) {
    const e = row(m);
    e.inputAll = m.input;
    e.outputAll = m.output;
    e.callsAll = m.calls;
  }
  return [...map.values()].sort((a, b) => b.inputAll + b.outputAll - (a.inputAll + a.outputAll));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="text-xl font-semibold text-gray-900">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {hint && <div className="mt-0.5 text-[10px] text-gray-400">{hint}</div>}
    </div>
  );
}

// Vendor (super-admin) console. Orgs are vendor-provisioned here: create an org +
// its first admin, see usage, and suspend/reactivate. Access is gated server-side
// by platform_admins; a non-platform user just sees an access-denied notice.
export function SuperAdmin() {
  const [orgs, setOrgs] = useState<PlatformOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stats, setStats] = useState<PlatformAnalytics | null>(null);

  // Create-org form.
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [plan, setPlan] = useState<PlatformOrg['plan']>('starter');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; adminEmail: string; tempPassword: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [orgsRes, statsRes] = await Promise.all([listOrgs(), getPlatformAnalytics()]);
      setOrgs(orgsRes.orgs);
      setStats(statsRes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load orgs';
      if (msg.toLowerCase().includes('platform admin')) setDenied(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate() {
    if (!name.trim() || !adminEmail.trim()) return;
    setCreating(true);
    setError(null);
    setCreated(null);
    try {
      const res = await createOrg(name.trim(), adminEmail.trim(), plan);
      setCreated({ name: res.org.name, adminEmail: res.adminEmail, tempPassword: res.tempPassword });
      setName('');
      setAdminEmail('');
      setPlan('starter');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create org');
    } finally {
      setCreating(false);
    }
  }

  async function onToggleSuspend(o: PlatformOrg) {
    const next = !o.suspended;
    if (next && !confirm(`Suspend "${o.name}"? All of its users will be blocked until reactivated.`)) return;
    setBusyId(o.id);
    setError(null);
    try {
      await setOrgSuspended(o.id, next);
      setOrgs((list) => list.map((x) => (x.id === o.id ? { ...x, suspended: next } : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update org');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex flex-wrap gap-4 text-sm">
            <Link to="/staging" className="text-gray-500 hover:underline">Staging</Link>
            <Link to="/users" className="text-gray-500 hover:underline">Users</Link>
            <span className="font-medium text-gray-900">Platform</span>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Platform Admin</h1>
          <p className="text-sm text-gray-500">Provision and manage customer organizations.</p>
        </div>
        <button onClick={() => void supabase.auth.signOut()} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          Sign out
        </button>
      </header>

      {denied ? (
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
          Platform admin access required.
        </div>
      ) : (
        <>
          {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {/* Create an org + its first admin. */}
          <div className="mb-6 rounded border border-gray-200 bg-gray-50 p-3">
            <h2 className="mb-2 text-sm font-medium text-gray-700">Create organization</h2>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="mb-1 block text-xs text-gray-500">Org name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." className="w-56 rounded border border-gray-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-gray-500">First admin email</span>
                <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@acme.com" className="w-64 rounded border border-gray-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-gray-500">Plan</span>
                <select value={plan} onChange={(e) => setPlan(e.target.value as PlatformOrg['plan'])} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                  <option value="starter">starter</option>
                  <option value="pro">pro</option>
                  <option value="enterprise">enterprise</option>
                </select>
              </label>
              <button onClick={() => void onCreate()} disabled={creating || !name.trim() || !adminEmail.trim()} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
                {creating ? 'Creating…' : 'Create org'}
              </button>
            </div>
            {created && (
              <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <p className="font-medium">Created “{created.name}” with admin {created.adminEmail}.</p>
                <p className="mt-1">
                  Temporary password (shown once — share securely):{' '}
                  <code className="rounded bg-white px-1.5 py-0.5 font-mono text-emerald-800">{created.tempPassword}</code>
                </p>
              </div>
            )}
          </div>

          {/* AI usage & storage (raw token counts — no $ conversion). */}
          {stats && (
            <div className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-gray-700">AI usage & storage</h2>
              <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Tokens in (30d)" value={fmtNum(stats.last30.totalInput)} hint={`${fmtNum(stats.allTime.totalInput)} all-time`} />
                <Stat label="Tokens out (30d)" value={fmtNum(stats.last30.totalOutput)} hint={`${fmtNum(stats.allTime.totalOutput)} all-time`} />
                <Stat label="AI calls (30d)" value={fmtNum(stats.last30.totalCalls)} hint={`${fmtNum(stats.allTime.totalCalls)} all-time`} />
                <Stat label="Storage" value={fmtBytes(stats.storageTotalBytes)} hint={`${fmtNum(stats.storageTotalFiles)} files`} />
              </div>

              {(() => {
                const rows = mergeByModel(stats.last30.byModel, stats.allTime.byModel);
                if (rows.length === 0) return null;
                return (
                  <div className="mb-3 overflow-hidden rounded border border-gray-200">
                    <p className="bg-gray-50 px-3 pt-2 text-xs text-gray-500">
                      Tokens by model — multiply by each model's input/output rate to estimate cost.
                    </p>
                    <table className="w-full text-left text-sm">
                      <thead className="bg-gray-50 text-gray-600">
                        <tr>
                          <th className="px-3 py-2">Model</th>
                          <th className="px-3 py-2">Input (30d)</th>
                          <th className="px-3 py-2">Output (30d)</th>
                          <th className="px-3 py-2">Input (all)</th>
                          <th className="px-3 py-2">Output (all)</th>
                          <th className="px-3 py-2">Calls (all)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((m) => (
                          <tr key={`${m.provider}:${m.model}`} className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-700">{m.model} <span className="text-xs text-gray-400">({m.provider})</span></td>
                            <td className="px-3 py-2 text-gray-600">{fmtNum(m.input30)}</td>
                            <td className="px-3 py-2 text-gray-600">{fmtNum(m.output30)}</td>
                            <td className="px-3 py-2 text-gray-600">{fmtNum(m.inputAll)}</td>
                            <td className="px-3 py-2 text-gray-600">{fmtNum(m.outputAll)}</td>
                            <td className="px-3 py-2 text-gray-600">{fmtNum(m.callsAll)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              <div className="overflow-hidden rounded border border-gray-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-3 py-2">Org</th>
                      <th className="px-3 py-2">Tokens (30d)</th>
                      <th className="px-3 py-2">Tokens (all)</th>
                      <th className="px-3 py-2">Storage</th>
                      <th className="px-3 py-2">Threads (30d)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byOrg.map((o) => (
                      <tr key={o.id} className="border-t border-gray-100">
                        <td className="px-3 py-2 font-medium text-gray-800">{o.name}</td>
                        <td className="px-3 py-2 text-gray-600">{fmtNum(o.input30 + o.output30)}</td>
                        <td className="px-3 py-2 text-gray-600">{fmtNum(o.inputAll + o.outputAll)}</td>
                        <td className="px-3 py-2 text-gray-600">{fmtBytes(o.storageBytes)}</td>
                        <td className="px-3 py-2 text-gray-600">{fmtNum(o.threads30)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <h2 className="mb-2 text-sm font-medium text-gray-700">Organizations ({orgs.length})</h2>
          <div className="overflow-hidden rounded border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Users</th>
                  <th className="px-3 py-2">Threads</th>
                  <th className="px-3 py-2">Articles</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
                ) : orgs.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No organizations yet.</td></tr>
                ) : (
                  orgs.map((o) => (
                    <tr key={o.id} className="border-t border-gray-100">
                      <td className="px-3 py-2 font-medium text-gray-800">{o.name}</td>
                      <td className="px-3 py-2 text-gray-600">{o.plan}</td>
                      <td className="px-3 py-2 text-gray-600">{o.user_count}</td>
                      <td className="px-3 py-2 text-gray-600">{o.thread_count}</td>
                      <td className="px-3 py-2 text-gray-600">{o.article_count}</td>
                      <td className="px-3 py-2">
                        {o.suspended ? (
                          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">suspended</span>
                        ) : (
                          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">active</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => void onToggleSuspend(o)}
                          disabled={busyId === o.id}
                          className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40"
                        >
                          {o.suspended ? 'Reactivate' : 'Suspend'}
                        </button>
                      </td>
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
