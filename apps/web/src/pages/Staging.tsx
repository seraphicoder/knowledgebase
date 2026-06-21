import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfinitePages } from '../lib/useInfinitePages';
import {
  listStaged,
  getThread,
  approveBatch,
  excludeThread,
  runPipeline,
  type StagedThread,
  type ThreadDetail,
  type StagedFilters,
  type PipelineStats,
} from '../lib/api';
import { supabase } from '../lib/supabase';
import { ThreadImages } from '../components/ThreadImages';

// Milestone 1 Staging Review page. Approving a thread here is the only way its
// approval_status changes. With no pipeline runner yet, an approved thread just
// sits at approval_status='approved', processing_status='not_started' — correct.

type SortKey = 'subject' | 'source_id' | 'participants' | 'message_count' | 'date_range_start';
type SortDir = 'asc' | 'desc';

function ts(d: string | null): number {
  return d ? new Date(d).getTime() : 0;
}

// Match a thread against a lowercased query across every displayed column.
function matchesSearch(t: StagedThread, q: string): boolean {
  const haystack = [
    t.subject ?? '',
    t.source_id,
    t.participants.join(' '),
    String(t.message_count),
    fmtDate(t.date_range_start),
    t.date_range_start ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function compareThreads(a: StagedThread, b: StagedThread, key: SortKey): number {
  switch (key) {
    case 'subject':
      return (a.subject ?? '').localeCompare(b.subject ?? '');
    case 'source_id':
      return a.source_id.localeCompare(b.source_id);
    case 'participants':
      return a.participants.join(', ').localeCompare(b.participants.join(', '));
    case 'message_count':
      return a.message_count - b.message_count;
    case 'date_range_start':
      return ts(a.date_range_start) - ts(b.date_range_start);
  }
}

export function Staging() {
  const [filters, setFilters] = useState<StagedFilters>({});
  const { items: threads, total, loading, error: loadError, reload, sentinelRef } = useInfinitePages<StagedThread>(
    (offset, limit) => listStaged(filters, { offset, limit }).then((r) => ({ items: r.threads, total: r.total })),
    JSON.stringify(filters),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ThreadDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<PipelineStats | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('date_range_start');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [search, setSearch] = useState('');
  const error = loadError ?? actionError;

  // Reload from the top and clear selection (after approve/exclude).
  function refresh() {
    setSelected(new Set());
    reload();
  }

  // Instant client-side search across all displayed columns, then sort.
  const sortedThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? threads.filter((t) => matchesSearch(t, q)) : threads;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => dir * compareThreads(a, b, sortKey));
  }, [threads, search, sortKey, sortDir]);

  // Select-all operates on the currently visible (searched) rows.
  const allSelected = sortedThreads.length > 0 && sortedThreads.every((t) => selected.has(t.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(sortedThreads.map((t) => t.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectedIds = useMemo(() => [...selected], [selected]);

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Dates feel natural newest-first; text/number ascending.
      setSortDir(key === 'date_range_start' ? 'desc' : 'asc');
    }
  }

  async function onApprove() {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await approveBatch(selectedIds);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Queue failed');
    } finally {
      setBusy(false);
    }
  }

  async function onExclude() {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      // exclude endpoint is per-thread; run sequentially to keep audit per row.
      for (const id of selectedIds) await excludeThread(id);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Exclude failed');
    } finally {
      setBusy(false);
    }
  }

  async function onRunPipeline() {
    setRunning(true);
    setActionError(null);
    setRunResult(null);
    try {
      const res = await runPipeline();
      setRunResult(res.stats);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Pipeline run failed');
    } finally {
      setRunning(false);
    }
  }

  async function openPreview(id: string) {
    setPreview(null);
    try {
      const res = await getThread(id);
      setPreview(res.thread);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to load preview');
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex gap-4 text-sm">
            <span className="font-medium text-gray-900">Staging</span>
            <Link to="/queued" className="text-gray-500 hover:underline">Queued</Link>
            <Link to="/review" className="text-gray-500 hover:underline">Review</Link>
            <Link to="/kb" className="text-gray-500 hover:underline">Knowledge Base</Link>
            <Link to="/replies" className="text-gray-500 hover:underline">Reply Agent</Link>
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
            <Link to="/users" className="text-gray-500 hover:underline">Users</Link>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Staging Review</h1>
          <p className="text-sm text-gray-500">
            {total} staged thread{total === 1 ? '' : 's'} — nothing is AI-processed until you queue it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRunPipeline}
            disabled={running}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            title="Runs the AI extraction pipeline on all queued threads"
          >
            {running ? 'Processing…' : 'Process Queued Threads'}
          </button>
          <button
            onClick={() => void supabase.auth.signOut()}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Sign out
          </button>
        </div>
      </header>

      {runResult && (
        <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Pipeline run: <strong>{runResult.extracted} draft{runResult.extracted === 1 ? '' : 's'}</strong> created from{' '}
          {runResult.considered} queued thread{runResult.considered === 1 ? '' : 's'} — {runResult.skippedLowRelevance} low-relevance,{' '}
          {runResult.skippedDuplicate} duplicate, {runResult.skippedNoKnowledge} no reusable knowledge, {runResult.errored} errored.{' '}
          {runResult.extracted > 0 && (
            <Link to="/review" className="font-medium underline">Review drafts →</Link>
          )}
        </div>
      )}

      <Filters filters={filters} onChange={setFilters} onRefresh={refresh} />

      {/* Instant search across all columns of the loaded threads. */}
      <div className="mb-3 flex items-center gap-2">
        <input
          type="search"
          placeholder="Search all columns (subject, source, participants, date…)"
          className="w-full max-w-md rounded border border-gray-300 px-3 py-1.5 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <span className="text-xs text-gray-500">
            {sortedThreads.length} match{sortedThreads.length === 1 ? '' : 'es'}
          </span>
        )}
      </div>

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
          Queue Selected ({selected.size})
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
              <SortHeader label="Subject" col="subject" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Source" col="source_id" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Participants" col="participants" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Msgs" col="message_count" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Date" col="date_range_start" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {loading && threads.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
            ) : sortedThreads.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                {search ? 'No threads match your search.' : 'No staged threads.'}
              </td></tr>
            ) : (
              sortedThreads.map((t) => (
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
      <div ref={sentinelRef} className="h-8" />
      {loading && threads.length > 0 && <p className="py-2 text-center text-xs text-gray-400">Loading more…</p>}

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
        <ThreadImages threadId={thread.id} />
      </div>
    </div>
  );
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <th className="px-3 py-2">
      <button
        onClick={() => onSort(col)}
        className={`flex items-center gap-1 font-medium hover:text-gray-900 ${active ? 'text-gray-900' : ''}`}
      >
        {label}
        <span className="text-xs">{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}
