import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listApproved,
  suggestForThread,
  listSuggestions,
  getSuggestion,
  decideSuggestion,
  reviewSuggestion,
  type ApprovedThread,
  type SuggestionSummary,
  type SuggestionDetailResponse,
} from '../lib/api';
import { supabase } from '../lib/supabase';

// Milestone 5 — Reply Agent. Pick a ticket, generate a KB-grounded suggested
// reply (with confidence + cited sources), edit/accept/discard it, and score it.
// Scoring feeds verified pairs that improve future suggestions. NEVER auto-sends.
export function Replies() {
  const [threads, setThreads] = useState<ApprovedThread[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionSummary[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [genId, setGenId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const loadSuggestions = useCallback(async () => {
    try {
      setSuggestions((await listSuggestions()).suggestions);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suggestions');
    }
  }, []);

  useEffect(() => {
    listApproved().then((r) => setThreads(r.threads)).catch(() => setThreads([]));
    void loadSuggestions();
  }, [loadSuggestions]);

  const visibleThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads.slice(0, 20);
    return threads.filter((t) => (t.subject ?? '').toLowerCase().includes(q)).slice(0, 20);
  }, [threads, search]);

  async function onGenerate(threadId: string) {
    setGenId(threadId);
    setError(null);
    try {
      const res = await suggestForThread(threadId);
      await loadSuggestions();
      setOpenId(res.suggestion.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate a suggestion');
    } finally {
      setGenId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex flex-wrap gap-4 text-sm">
            <Link to="/staging" className="text-gray-500 hover:underline">Staging</Link>
            <Link to="/approved" className="text-gray-500 hover:underline">Approved</Link>
            <Link to="/review" className="text-gray-500 hover:underline">Review</Link>
            <Link to="/kb" className="text-gray-500 hover:underline">Knowledge Base</Link>
            <span className="font-medium text-gray-900">Reply Agent</span>
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Reply Agent</h1>
          <p className="text-sm text-gray-500">Draft a KB-grounded reply for a ticket. Suggestions only — nothing is ever sent.</p>
        </div>
        <button onClick={() => void supabase.auth.signOut()} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          Sign out
        </button>
      </header>

      {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Pick a ticket to draft a reply for */}
        <section>
          <h2 className="mb-2 text-sm font-medium text-gray-700">Draft a reply for a ticket</h2>
          <input
            type="search"
            placeholder="Search approved tickets…"
            className="mb-2 w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="divide-y divide-gray-100 rounded border border-gray-200">
            {visibleThreads.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-gray-400">No approved tickets.</p>
            ) : (
              visibleThreads.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="truncate text-gray-700">{t.subject || '(no subject)'}</span>
                  <button
                    onClick={() => void onGenerate(t.id)}
                    disabled={genId === t.id}
                    className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                  >
                    {genId === t.id ? 'Drafting…' : 'Suggest reply'}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Existing suggestions */}
        <section>
          <h2 className="mb-2 text-sm font-medium text-gray-700">Suggestions ({suggestions.length})</h2>
          <div className="divide-y divide-gray-100 rounded border border-gray-200">
            {suggestions.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-gray-400">No suggestions yet.</p>
            ) : (
              suggestions.map((s) => (
                <button key={s.id} onClick={() => setOpenId(s.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50">
                  <span className="truncate text-blue-700">{(s.suggested_reply ?? '').slice(0, 60) || '(empty)'}…</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <ConfidenceBadge score={s.confidence_score} />
                    <StatusBadge status={s.status} />
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
      </div>

      {openId && (
        <SuggestionDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void loadSuggestions()}
        />
      )}
    </div>
  );
}

function SuggestionDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<SuggestionDetailResponse | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // SME review state
  const [verdict, setVerdict] = useState<'correct' | 'partial' | 'wrong'>('correct');
  const [accuracy, setAccuracy] = useState(90);
  const [corrected, setCorrected] = useState('');
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getSuggestion(id);
      setData(res);
      setReply(res.suggestion.final_reply ?? res.suggestion.suggested_reply ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suggestion');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(status: 'accepted' | 'edited' | 'discarded') {
    setBusy(true);
    setError(null);
    try {
      await decideSuggestion(id, { status, finalReply: status === 'discarded' ? undefined : reply });
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitReview() {
    setBusy(true);
    setReviewMsg(null);
    setError(null);
    try {
      const res = await reviewSuggestion(id, {
        verdict,
        accuracyScore: accuracy,
        correctedAnswer: verdict === 'correct' ? undefined : corrected,
      });
      setReviewMsg(res.verifiedPairId ? 'Saved — added a verified answer for future tickets.' : 'Review saved.');
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex justify-end bg-black/20" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">Suggested reply</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {!data ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <ConfidenceBadge score={data.suggestion.confidence_score} />
              <StatusBadge status={data.suggestion.status} />
            </div>

            <div>
              <span className="mb-1 block text-sm font-medium text-gray-600">Suggested reply (editable)</span>
              <textarea className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" rows={8} value={reply} onChange={(e) => setReply(e.target.value)} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => void decide('accepted')} disabled={busy} className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">Accept</button>
              <button onClick={() => void decide('edited')} disabled={busy} className="rounded border border-gray-300 px-3 py-1.5 text-sm">Save as edited</button>
              <button onClick={() => void decide('discarded')} disabled={busy} className="rounded bg-gray-200 px-3 py-1.5 text-sm text-gray-800">Discard</button>
              <button
                onClick={() => navigator.clipboard?.writeText(reply)}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm"
                title="Copy to paste into your support tool"
              >
                Copy
              </button>
            </div>

            {/* Cited sources */}
            <div className="rounded border border-gray-200 p-3 text-xs text-gray-600">
              <p className="mb-1 font-medium text-gray-700">Grounded in</p>
              {data.citedArticles.length === 0 && data.citedThreads.length === 0 ? (
                <p className="text-gray-400">No sources retrieved.</p>
              ) : (
                <ul className="list-inside list-disc space-y-0.5">
                  {data.citedArticles.map((a) => <li key={a.id}>KB: {a.title}</li>)}
                  {data.citedThreads.map((t) => <li key={t.id}>Past ticket: {t.subject || '(no subject)'}</li>)}
                </ul>
              )}
            </div>

            {/* SME scoring -> verified pairs */}
            <div className="rounded border border-gray-200 p-3">
              <h3 className="mb-2 text-sm font-medium text-gray-700">Score this suggestion (SME)</h3>
              {data.review && (
                <p className="mb-2 text-xs text-gray-500">Last scored: {data.review.verdict} ({data.review.accuracy_score ?? '—'}%)</p>
              )}
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)} className="rounded border border-gray-300 px-2 py-1">
                  <option value="correct">Correct</option>
                  <option value="partial">Partially correct</option>
                  <option value="wrong">Wrong</option>
                </select>
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  accuracy
                  <input type="number" min={0} max={100} value={accuracy} onChange={(e) => setAccuracy(Number(e.target.value))} className="w-16 rounded border border-gray-300 px-2 py-1" />
                </label>
              </div>
              {verdict !== 'correct' && (
                <textarea
                  className="mt-2 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                  rows={3}
                  placeholder="Corrected answer (becomes a verified answer for future tickets)"
                  value={corrected}
                  onChange={(e) => setCorrected(e.target.value)}
                />
              )}
              <button onClick={() => void submitReview()} disabled={busy} className="mt-2 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
                Submit score
              </button>
              {reviewMsg && <p className="mt-2 text-xs text-emerald-700">{reviewMsg}</p>}
            </div>

            {/* The ticket */}
            {data.ticket && (
              <details className="rounded border border-gray-200 p-3">
                <summary className="cursor-pointer text-sm font-medium text-gray-700">Ticket: {data.ticket.subject || '(no subject)'}</summary>
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-gray-50 p-3 text-xs text-gray-700">
                  {data.ticket.raw_content || '(empty)'}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfidenceBadge({ score }: { score: number | null }) {
  if (score == null) return null;
  const color = score >= 70 ? 'bg-emerald-100 text-emerald-800' : score >= 40 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800';
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>{score}% confidence</span>;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending_review: 'bg-gray-100 text-gray-600',
    accepted: 'bg-emerald-100 text-emerald-800',
    edited: 'bg-blue-100 text-blue-800',
    discarded: 'bg-gray-200 text-gray-500',
  };
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>{status.replace('_', ' ')}</span>;
}
