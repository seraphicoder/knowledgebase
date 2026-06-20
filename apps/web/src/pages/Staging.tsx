import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listStaged,
  getThread,
  approveBatch,
  excludeThread,
  type StagedThread,
  type ThreadDetail,
  type StagedFilters,
} from '../lib/api';
import { supabase } from '../lib/supabase';

// Milestone 1 Staging Review page. Approving a thread here is the only way its
// approval_status changes. With no pipeline runner yet, an approved thread just
// sits at approval_status='approved', processing_status='not_started' — correct.

export function Staging() {
  const [threads, setThreads] = useState<StagedThread[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<StagedFilters>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ThreadDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listStaged(filters);
      setThreads(res.threads);
      setTotal(res.total);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load staged threads');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const allSelected = threads.length > 0 && selected.size === threads.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(threads.map((t) => t.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectedIds = useMemo(() => [...selected], [selected]);

  async function onApprove() {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await approveBatch(selectedIds);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setBusy(false);
    }
  }

  async function onExclude() {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // exclude endpoint is per-thread; run sequentially to keep audit per row.
      for (const id of selectedIds) await excludeThread(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Exclude failed');
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(id: string) {
    setPreview(null);
    try {
      const res = await getThread(id);
      setPreview(res.thread);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load preview');
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Staging Review</h1>
          <p className="text-sm text-gray-500">
            {total} staged thread{total === 1 ? '' : 's'} — nothing is AI-processed until you approve it.
          </p>
        </div>
        <button
          onClick={() => void supabase.auth.signOut()}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </header>

      <Filters filters={filters} onChange={setFilters} onRefresh={load} />

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={onApprove}
          disabled={busy || selected.size === 0}
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Approve Selected ({selected.size})
        </button>
        <button
          onClick={onExclude}
          disabled={busy || selected.size === 0}
          className="rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-800 disabled:opacity-40"
        >
          Exclude Selected
        </button>
      </div>

      <div className="overflow-hidden rounded border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="w-10 px-3 py-2">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </th>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Participants</th>
              <th className="px-3 py-2">Msgs</th>
              <th className="px-3 py-2">Date</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
            ) : threads.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No staged threads.</td></tr>
            ) : (
              threads.map((t) => (
                <tr key={t.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleOne(t.id)} />
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => openPreview(t.id)} className="text-left font-medium text-blue-700 hover:underline">
                      {t.subject || '(no subject)'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{t.source_id.slice(0, 8)}…</td>
                  <td className="px-3 py-2 text-gray-600">{t.participants.slice(0, 2).join(', ')}{t.participants.length > 2 ? '…' : ''}</td>
                  <td className="px-3 py-2 text-gray-600">{t.message_count}</td>
                  <td className="px-3 py-2 text-gray-600">{fmtDate(t.date_range_start)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {preview && <PreviewDrawer thread={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function Filters({
  filters,
  onChange,
  onRefresh,
}: {
  filters: StagedFilters;
  onChange: (f: StagedFilters) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="mb-1 block text-gray-500">Search subject</span>
        <input
          className="rounded border border-gray-300 px-2 py-1"
          value={filters.q ?? ''}
          onChange={(e) => onChange({ ...filters, q: e.target.value || undefined })}
        />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-gray-500">From</span>
        <input
          type="date"
          className="rounded border border-gray-300 px-2 py-1"
          value={filters.from ?? ''}
          onChange={(e) => onChange({ ...filters, from: e.target.value || undefined })}
        />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-gray-500">To</span>
        <input
          type="date"
          className="rounded border border-gray-300 px-2 py-1"
          value={filters.to ?? ''}
          onChange={(e) => onChange({ ...filters, to: e.target.value || undefined })}
        />
      </label>
      <button onClick={onRefresh} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
        Apply
      </button>
    </div>
  );
}

function PreviewDrawer({ thread, onClose }: { thread: ThreadDetail; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-10 flex justify-end bg-black/20" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{thread.subject || '(no subject)'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        <dl className="mb-4 space-y-1 text-sm text-gray-600">
          <div><span className="font-medium">Participants:</span> {thread.participants.join(', ')}</div>
          <div><span className="font-medium">Messages:</span> {thread.message_count}</div>
          <div><span className="font-medium">Status:</span> {thread.approval_status}</div>
        </dl>
        <h3 className="mb-2 text-sm font-medium text-gray-700">Cleaned content</h3>
        <pre className="whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm text-gray-800">
          {thread.raw_content || '(empty)'}
        </pre>
      </div>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}
