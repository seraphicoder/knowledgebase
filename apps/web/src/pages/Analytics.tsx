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
          {/* Usage vs limits (only shown when the vendor has set a cap). */}
          {(data.limits.tokens.limit != null || data.limits.storage.limit != null || data.limits.ingest.limit != null) && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-gray-700">Usage this month</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <LimitBar label="AI tokens" dim={data.limits.tokens} fmt={(n) => n.toLocaleString()} />
                <LimitBar label="Storage" dim={data.limits.storage} fmt={fmtBytes} />
                <LimitBar label="Tickets ingested" dim={data.limits.ingest} fmt={(n) => n.toLocaleString()} />
              </div>
            </section>
          )}

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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function LimitBar({ label, dim, fmt }: { label: string; dim: { usage: number; limit: number | null; exceeded: boolean }; fmt: (n: number) => string }) {
  const pct = dim.limit && dim.limit > 0 ? Math.min(100, Math.round((dim.usage / dim.limit) * 100)) : 0;
  const bar = dim.exceeded ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-gray-500">{label}</span>
        {dim.exceeded && <span className="text-[10px] font-medium text-red-600">over limit</span>}
      </div>
      <div className="text-sm font-medium text-gray-900">
        {fmt(dim.usage)} {dim.limit != null ? <span className="text-gray-400">/ {fmt(dim.limit)}</span> : <span className="text-gray-400">/ unlimited</span>}
      </div>
      {dim.limit != null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-gray-100">
          <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
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
