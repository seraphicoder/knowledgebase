import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listSources,
  createSource,
  updateSource,
  deleteSource,
  testSource,
  ingestAllSources,
  ingestOneSource,
  getIngestStatus,
  type IngestionSource,
  type CreateSourceInput,
  type IngestStats,
} from '../lib/api';
import { supabase } from '../lib/supabase';

// Admin page to connect ingestion sources — Zendesk + email (IMAP) — and pull
// from all active sources together. Credentials are encrypted server-side.
export function Sources() {
  const [sources, setSources] = useState<IngestionSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const [running, setRunning] = useState(false);
  const [ingestResult, setIngestResult] = useState<IngestStats | null>(null);
  const [limit, setLimit] = useState('250'); // newest N per source; blank = backend default

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSources((await listSources()).sources);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load sources';
      if (msg.toLowerCase().includes('admin')) setDenied(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Reflect a run already in progress on the backend (survives page reloads).
    void getIngestStatus()
      .then((s) => {
        if (s.running) {
          setRunning(true);
          pollIngest();
        } else if (s.lastFinished) {
          setIngestResult(s.lastFinished.stats);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  function limitArg(): number | undefined {
    const n = Number(limit);
    return limit.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
  }

  function pollIngest() {
    getIngestStatus()
      .then((s) => {
        if (s.running) setTimeout(pollIngest, 2500);
        else {
          setRunning(false);
          if (s.lastFinished) setIngestResult(s.lastFinished.stats);
          void load();
        }
      })
      .catch(() => setRunning(false));
  }

  async function onIngestAll() {
    setRunning(true);
    setError(null);
    setIngestResult(null);
    try {
      await ingestAllSources(limitArg());
      pollIngest();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start ingestion');
      setRunning(false);
    }
  }

  async function onIngestOne(id: string) {
    setRunning(true);
    setError(null);
    setIngestResult(null);
    try {
      await ingestOneSource(id, limitArg());
      pollIngest();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start ingestion');
      setRunning(false);
    }
  }

  async function onTest(id: string) {
    setBusyId(id);
    try {
      const r = await testSource(id);
      setTestResult((m) => ({ ...m, [id]: r.ok ? '✓ Connected' : `✗ ${r.error ?? 'Failed'}` }));
    } finally {
      setBusyId(null);
    }
  }

  async function onToggleStatus(s: IngestionSource) {
    setBusyId(s.id);
    setError(null);
    try {
      const next = s.status === 'active' ? 'paused' : 'active';
      await updateSource(s.id, { status: next });
      setSources((list) => list.map((x) => (x.id === s.id ? { ...x, status: next } : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update source');
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(s: IngestionSource) {
    if (!confirm(`Delete source "${s.label}"? Ingested tickets stay, but no new ones will be pulled from it.`)) return;
    setBusyId(s.id);
    setError(null);
    try {
      await deleteSource(s.id);
      setSources((list) => list.filter((x) => x.id !== s.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete source');
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
            <Link to="/queued" className="text-gray-500 hover:underline">Queued</Link>
            <Link to="/review" className="text-gray-500 hover:underline">Review</Link>
            <Link to="/kb" className="text-gray-500 hover:underline">Knowledge Base</Link>
            <Link to="/replies" className="text-gray-500 hover:underline">Reply Agent</Link>
            <Link to="/users" className="text-gray-500 hover:underline">Users</Link>
            <span className="font-medium text-gray-900">Sources</span>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Ingestion Sources</h1>
          <p className="text-sm text-gray-500">Connect Zendesk and email (IMAP), then pull tickets from all active sources.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-gray-500">
            Newest
            <input
              type="number"
              min={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              disabled={running}
              className="w-20 rounded border border-gray-300 px-2 py-1.5 text-sm disabled:opacity-50"
              placeholder="all"
              title="How many of the newest tickets to pull per source (blank = backend default). Re-run to walk further back."
            />
            per source
          </label>
          <button
            onClick={() => void onIngestAll()}
            disabled={running}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            title="Pull new tickets from every active source"
          >
            {running ? 'Pulling…' : 'Pull new tickets'}
          </button>
          <button onClick={() => void supabase.auth.signOut()} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            Sign out
          </button>
        </div>
      </header>

      {denied ? (
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
          Admin access required to manage sources.
        </div>
      ) : (
        <>
          {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {running && (
            <div className="mb-4 flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
              Pulling tickets in the background… this keeps running even if you leave the page.
            </div>
          )}

          {ingestResult && !running && (
            <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              Pulled from {ingestResult.sources} source{ingestResult.sources === 1 ? '' : 's'}:{' '}
              <strong>{ingestResult.inserted} new ticket{ingestResult.inserted === 1 ? '' : 's'}</strong> staged,{' '}
              {ingestResult.duplicates} duplicate{ingestResult.duplicates === 1 ? '' : 's'} skipped
              {ingestResult.errored > 0 && `, ${ingestResult.errored} errored`}.{' '}
              <Link to="/staging" className="font-medium underline">Review in Staging →</Link>
            </div>
          )}

          <div className="mb-6 overflow-hidden rounded border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Label</th>
                  <th className="px-3 py-2">Connection</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last synced</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
                ) : sources.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No sources yet. Add one below.</td></tr>
                ) : (
                  sources.map((s) => (
                    <tr key={s.id} className="border-t border-gray-100 align-top">
                      <td className="px-3 py-2 font-medium text-gray-800">{s.type === 'zendesk' ? 'Zendesk' : 'Email'}</td>
                      <td className="px-3 py-2 text-gray-700">{s.label}</td>
                      <td className="px-3 py-2 text-gray-500">{connectionSummary(s)}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.status === 'active' ? 'bg-emerald-100 text-emerald-800' : s.status === 'error' ? 'bg-red-100 text-red-800' : 'bg-gray-200 text-gray-600'}`}>{s.status}</span>
                        {testResult[s.id] && <div className="mt-1 text-xs text-gray-500">{testResult[s.id]}</div>}
                      </td>
                      <td className="px-3 py-2 text-gray-500">{s.last_synced_at ? new Date(s.last_synced_at).toLocaleString() : '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          <button onClick={() => void onIngestOne(s.id)} disabled={running || s.status !== 'active'} title={s.status !== 'active' ? 'Activate the source to pull' : 'Pull new tickets from this source'} className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-40">Pull</button>
                          <button onClick={() => void onTest(s.id)} disabled={busyId === s.id} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40">Test</button>
                          <button onClick={() => void onToggleStatus(s)} disabled={busyId === s.id} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40">{s.status === 'active' ? 'Pause' : 'Activate'}</button>
                          <button onClick={() => void onDelete(s)} disabled={busyId === s.id} className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <AddSourceForm onAdded={() => void load()} onError={setError} />
        </>
      )}
    </div>
  );
}

function connectionSummary(s: IngestionSource): string {
  const c = s.connection;
  if (s.type === 'zendesk') return c.subdomain ? `${String(c.subdomain)}.zendesk.com` : '—';
  const parts = [c.host ? String(c.host) : null, c.mailbox ? `(${String(c.mailbox)})` : null].filter(Boolean);
  return parts.length ? parts.join(' ') : '—';
}

function AddSourceForm({ onAdded, onError }: { onAdded: () => void; onError: (m: string | null) => void }) {
  const [type, setType] = useState<'zendesk' | 'imap'>('zendesk');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  // Zendesk
  const [subdomain, setSubdomain] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  // IMAP
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [mailbox, setMailbox] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');

  function reset() {
    setLabel(''); setSubdomain(''); setEmail(''); setApiToken('');
    setHost(''); setPort('993'); setMailbox(''); setUser(''); setPassword('');
  }

  async function onSubmit() {
    onError(null);
    if (!label.trim()) return onError('Give the source a label');
    setBusy(true);
    try {
      const input: CreateSourceInput =
        type === 'zendesk'
          ? { type, label: label.trim(), subdomain: subdomain.trim(), email: email.trim(), apiToken: apiToken.trim() }
          : { type, label: label.trim(), host: host.trim(), port: Number(port) || 993, mailbox: mailbox.trim() || undefined, user: user.trim(), password };
      await createSource(input);
      reset();
      onAdded();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to add source');
    } finally {
      setBusy(false);
    }
  }

  const field = 'w-full rounded border border-gray-300 px-2 py-1.5 text-sm';

  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-4">
      <h2 className="mb-3 text-sm font-medium text-gray-700">Add a source</h2>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as 'zendesk' | 'imap')} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
            <option value="zendesk">Zendesk</option>
            <option value="imap">Email (IMAP)</option>
          </select>
        </label>
        <label className="text-sm flex-1 min-w-[200px]">
          <span className="mb-1 block text-xs text-gray-500">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Support inbox" className={field} />
        </label>
      </div>

      {type === 'zendesk' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-sm"><span className="mb-1 block text-xs text-gray-500">Subdomain</span><input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="yourco" className={field} /></label>
          <label className="text-sm"><span className="mb-1 block text-xs text-gray-500">Agent email</span><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@yourco.com" className={field} /></label>
          <label className="text-sm"><span className="mb-1 block text-xs text-gray-500">API token</span><input type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} className={field} /></label>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-sm"><span className="mb-1 block text-xs text-gray-500">IMAP host</span><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.gmail.com" className={field} /></label>
          <label className="text-sm"><span className="mb-1 block text-xs text-gray-500">Port</span><input value={port} onChange={(e) => setPort(e.target.value)} className={field} /></label>
          <label className="text-sm"><span className="mb-1 block text-xs text-gray-500">Mailbox (optional)</span><input value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="INBOX" className={field} /></label>
          <label className="text-sm"><span className="mb-1 block text-xs text-gray-500">Username</span><input value={user} onChange={(e) => setUser(e.target.value)} placeholder="support@yourco.com" className={field} /></label>
          <label className="text-sm"><span className="mb-1 block text-xs text-gray-500">Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} /></label>
        </div>
      )}

      <div className="mt-3">
        <button onClick={() => void onSubmit()} disabled={busy} className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
          {busy ? 'Adding…' : 'Add source'}
        </button>
      </div>
    </div>
  );
}
