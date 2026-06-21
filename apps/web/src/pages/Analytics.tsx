import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAnalyticsOverview, type AnalyticsOverview } from '../lib/api';
import { supabase } from '../lib/supabase';

// Org-facing analytics (admin). Deflection + usage for this org. No cost/token
// data here — that's vendor-only in the Platform console.
export function Analytics() {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAnalyticsOverview()
      .then(setData)
      .catch((e) => {
        const msg = e instanceof Error ? e.message : 'Failed to load analytics';
        if (msg.toLowerCase().includes('admin')) setDenied(true);
        else setError(msg);
      })
      .finally(() => setLoading(false));
  }, []);

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
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
            <Link to="/users" className="text-gray-500 hover:underline">Users</Link>
            <span className="font-medium text-gray-900">Analytics</span>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500">Deflection and usage for your organization.</p>
        </div>
        <button onClick={() => void supabase.auth.signOut()} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          Sign out
        </button>
      </header>

      {denied ? (
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
          Admin access required to view analytics.
        </div>
      ) : error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : loading || !data ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-6">
          {/* Headline: reply-agent deflection */}
          <section>
            <h2 className="mb-2 text-sm font-medium text-gray-700">Reply agent</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Deflection rate" value={data.replyAgent.deflectionRate == null ? '—' : `${Math.round(data.replyAgent.deflectionRate * 100)}%`} hint="accepted or edited ÷ decided" />
              <Stat label="Suggestions" value={data.replyAgent.total} />
              <Stat label="Used (acc.+edited)" value={data.replyAgent.accepted + data.replyAgent.edited} />
              <Stat label="Avg confidence" value={data.replyAgent.avgConfidence == null ? '—' : `${data.replyAgent.avgConfidence}%`} />
            </div>
            <p className="mt-2 text-xs text-gray-400">
              {data.replyAgent.pending} pending · {data.replyAgent.accepted} accepted · {data.replyAgent.edited} edited · {data.replyAgent.discarded} discarded
            </p>
          </section>

          {/* Knowledge base */}
          <section>
            <h2 className="mb-2 text-sm font-medium text-gray-700">Knowledge base</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Published articles" value={data.knowledge.publishedArticles} />
              <Stat label="Drafts in review" value={data.knowledge.draftsPendingReview} />
              <Stat label="Verified pairs" value={data.knowledge.verifiedPairs} />
            </div>
          </section>

          {/* Tickets / ingestion */}
          <section>
            <h2 className="mb-2 text-sm font-medium text-gray-700">Tickets & ingestion</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total threads" value={data.threads.total} />
              <Stat label="Ingested (30d)" value={data.threads.ingestedLast30} />
              <Stat label="Staged" value={data.threads.staged} />
              <Stat label="Queued" value={data.threads.queued} />
            </div>
            <p className="mt-2 text-xs text-gray-400">
              Processed: {data.processing.extracted} extracted · {data.processing.skipped} skipped · {data.processing.errored} errored · {data.threads.excluded} excluded
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {hint && <div className="mt-0.5 text-[10px] text-gray-400">{hint}</div>}
    </div>
  );
}
