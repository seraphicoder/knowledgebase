import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listFacts,
  createFact,
  updateFact,
  deleteFact,
  type DomainFact,
} from '../lib/api';
import { supabase } from '../lib/supabase';

// Domain Facts management. These facts are injected into the extraction prompt
// as authoritative context, so the LLM corrects its assumptions (e.g. a model
// being roll-to-roll, not flatbed). A blank term = a global rule (always applied).
export function Facts() {
  const [items, setItems] = useState<DomainFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [fact, setFact] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listFacts();
      setItems(res.facts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load facts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAdd() {
    if (!fact.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createFact({ term: term.trim() || null, fact: fact.trim() });
      setTerm('');
      setFact('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add fact');
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(f: DomainFact) {
    setError(null);
    try {
      await updateFact(f.id, { active: !f.active });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update fact');
    }
  }

  async function onDelete(f: DomainFact) {
    if (!confirm('Delete this fact?')) return;
    setError(null);
    try {
      await deleteFact(f.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete fact');
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex gap-4 text-sm">
            <Link to="/staging" className="text-gray-500 hover:underline">Staging</Link>
            <Link to="/approved" className="text-gray-500 hover:underline">Approved</Link>
            <Link to="/review" className="text-gray-500 hover:underline">Review</Link>
            <span className="font-medium text-gray-900">Domain Facts</span>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Domain Facts</h1>
          <p className="text-sm text-gray-500">
            Authoritative facts injected into extraction so the AI uses your truth, not its assumptions.
          </p>
        </div>
        <button
          onClick={() => void supabase.auth.signOut()}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {/* Add form */}
      <div className="mb-6 rounded border border-gray-200 bg-gray-50 p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-700">Add a fact</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <label className="text-sm sm:w-56">
            <span className="mb-1 block text-gray-500">Term (optional)</span>
            <input
              className="w-full rounded border border-gray-300 px-2 py-1.5"
              placeholder="e.g. Model XYZ — blank = global rule"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </label>
          <label className="flex-1 text-sm">
            <span className="mb-1 block text-gray-500">Fact</span>
            <textarea
              className="w-full rounded border border-gray-300 px-2 py-1.5"
              rows={2}
              placeholder="e.g. The XYZ is a roll-to-roll UV printer, NOT a flatbed."
              value={fact}
              onChange={(e) => setFact(e.target.value)}
            />
          </label>
          <button
            onClick={onAdd}
            disabled={busy || !fact.trim()}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 sm:mt-6"
          >
            Add
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          A term-triggered fact applies only when that word appears in a thread. Leave Term blank for a rule that always applies.
        </p>
      </div>

      <div className="overflow-hidden rounded border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2">Term</th>
              <th className="px-3 py-2">Fact</th>
              <th className="px-3 py-2 w-20">Active</th>
              <th className="px-3 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">No facts yet. Add one above.</td></tr>
            ) : (
              items.map((f) => (
                <tr key={f.id} className="border-t border-gray-100 align-top">
                  <td className="px-3 py-2 text-gray-700">
                    {f.term ? <code className="rounded bg-gray-100 px-1">{f.term}</code> : <span className="text-gray-400">global</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{f.fact}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => void onToggle(f)}
                      className={`rounded px-2 py-0.5 text-xs font-medium ${f.active ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'}`}
                    >
                      {f.active ? 'On' : 'Off'}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => void onDelete(f)} className="text-xs text-red-600 hover:underline">Delete</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
