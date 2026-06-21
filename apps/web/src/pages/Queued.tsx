import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listQueued, getThread, type QueuedThread, type ThreadDetail } from '../lib/api';
import { supabase } from '../lib/supabase';
import { ThreadImages } from '../components/ThreadImages';
import { SourceBadge } from '../components/SourceBadge';
import { useInfinitePages } from '../lib/useInfinitePages';

// Queued threads leave the Staging list, so this read-only tab is where you see
// what's been queued, its pipeline state, and the original source content.
export function Queued() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState(''); // debounced, server-side query

  // Debounce the search box so each keystroke doesn't refetch.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { items: threads, total, loading, error: loadError, sentinelRef } = useInfinitePages<QueuedThread>(
    (offset, limit) => listQueued({ offset, limit }, q || undefined).then((r) => ({ items: r.threads, total: r.total })),
    q, // reload whenever the server-side query changes
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ThreadDetail | null>(null);
  const error = loadError ?? previewError;

  async function openPreview(id: string) {
    setPreview(null);
    setPreviewError(null);
    try {
      const res = await getThread(id);
      setPreview(res.thread);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Failed to load preview');
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex gap-4 text-sm">
            <Link to="/staging" className="text-gray-500 hover:underline">Staging</Link>
            <span className="font-medium text-gray-900">Queued</span>
            <Link to="/review" className="text-gray-500 hover:underline">Review</Link>
            <Link to="/kb" className="text-gray-500 hover:underline">Knowledge Base</Link>
            <Link to="/replies" className="text-gray-500 hover:underline">Reply Agent</Link>
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
            <Link to="/users" className="text-gray-500 hover:underline">Users</Link>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Queued Threads</h1>
          <p className="text-sm text-gray-500">{total} queued — waiting for or already processed by the pipeline.</p>
        </div>
        <button
          onClick={() => void supabase.auth.signOut()}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </header>

      <div className="mb-3 flex items-center gap-2">
        <input
          type="search"
          placeholder="Search subject or participants…"
          className="w-full max-w-md rounded border border-gray-300 px-3 py-1.5 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search.trim() && !loading && <span className="text-xs text-gray-500">{total} match{total === 1 ? '' : 'es'}</span>}
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="overflow-hidden rounded border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Participants</th>
              <th className="px-3 py-2">Msgs</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && threads.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
            ) : threads.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                {search.trim() ? 'No threads match your search.' : 'No queued threads yet.'}
              </td></tr>
            ) : (
              threads.map((t) => (
                <tr key={t.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <button onClick={() => openPreview(t.id)} className="text-left font-medium text-blue-700 hover:underline">
                      {t.subject || '(no subject)'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-gray-600"><SourceBadge source={t.source} /></td>
                  <td className="px-3 py-2 text-gray-600">{t.participants.slice(0, 2).join(', ')}{t.participants.length > 2 ? '…' : ''}</td>
                  <td className="px-3 py-2 text-gray-600">{t.message_count}</td>
                  <td className="px-3 py-2 text-gray-600">{fmtDate(t.date_range_start)}</td>
                  <td className="px-3 py-2"><StatusBadge status={t.processing_status} /></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Infinite-scroll sentinel */}
      <div ref={sentinelRef} className="h-8" />
      {loading && threads.length > 0 && <p className="py-2 text-center text-xs text-gray-400">Loading more…</p>}

      {preview && <PreviewDrawer thread={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    not_started: 'bg-gray-100 text-gray-600',
    pending: 'bg-amber-100 text-amber-800',
    processing: 'bg-amber-100 text-amber-800',
    extracted: 'bg-emerald-100 text-emerald-800',
    skipped: 'bg-gray-200 text-gray-600',
    error: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status.replace('_', ' ')}
    </span>
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
          <div className="flex items-center gap-1"><span className="font-medium">Source:</span> <SourceBadge source={thread.source} /></div>
          <div><span className="font-medium">Status:</span> {thread.approval_status}</div>
        </dl>
        <h3 className="mb-2 text-sm font-medium text-gray-700">Original cleaned content</h3>
        <pre className="whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm text-gray-800">
          {thread.raw_content || '(empty)'}
        </pre>
        <ThreadImages threadId={thread.id} />
      </div>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}
