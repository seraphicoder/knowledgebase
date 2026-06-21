import { Hono } from 'hono';
import { getServiceClient } from '../lib/supabase.js';
import { requireAuth, type AuthVars } from '../lib/auth.js';

// Org-facing analytics (admin). Deflection + usage for the CALLER's org only —
// deliberately no cost/token/storage data (that lives in the vendor console).

export const analytics = new Hono<{ Variables: AuthVars }>();
analytics.use('*', requireAuth);

const since30 = () => new Date(Date.now() - 30 * 86_400_000).toISOString();

analytics.get('/analytics/overview', async (c) => {
  const { orgId, role } = c.get('auth');
  if (role !== 'admin') return c.json({ error: 'Admin access required' }, 403);
  const db = getServiceClient();

  // head:true count helper, always org-scoped.
  const count = async (table: string, col?: string, val?: string): Promise<number> => {
    let q = db.from(table).select('id', { count: 'exact', head: true }).eq('org_id', orgId);
    if (col) q = q.eq(col, val as string);
    const { count: n } = await q;
    return n ?? 0;
  };

  const [
    threadsTotal, staged, queued, excluded,
    extracted, skipped, errored,
    ingested30,
    articles, drafts, verified,
    suggestionRows,
  ] = await Promise.all([
    count('email_threads'),
    count('email_threads', 'approval_status', 'staged'),
    count('email_threads', 'approval_status', 'approved'),
    count('email_threads', 'approval_status', 'excluded'),
    count('email_threads', 'processing_status', 'extracted'),
    count('email_threads', 'processing_status', 'skipped'),
    count('email_threads', 'processing_status', 'error'),
    db.from('email_threads').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('ingested_at', since30()).then((r) => r.count ?? 0),
    count('kb_articles'),
    count('extractions', 'status', 'pending_review'),
    count('verified_pairs'),
    db.from('ticket_suggestions').select('status, confidence_score').eq('org_id', orgId),
  ]);

  // Reply-agent deflection from suggestion outcomes.
  const sugg = (suggestionRows.data ?? []) as { status: string; confidence_score: number | null }[];
  const byStatus = { pending_review: 0, accepted: 0, edited: 0, discarded: 0 } as Record<string, number>;
  let confSum = 0;
  let confN = 0;
  for (const s of sugg) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    if (s.confidence_score != null) {
      confSum += s.confidence_score;
      confN++;
    }
  }
  const used = (byStatus.accepted ?? 0) + (byStatus.edited ?? 0);
  const resolved = used + (byStatus.discarded ?? 0);

  return c.json({
    threads: { total: threadsTotal, staged, queued, excluded, ingestedLast30: ingested30 },
    processing: { extracted, skipped, errored },
    knowledge: { publishedArticles: articles, draftsPendingReview: drafts, verifiedPairs: verified },
    replyAgent: {
      total: sugg.length,
      pending: byStatus.pending_review ?? 0,
      accepted: byStatus.accepted ?? 0,
      edited: byStatus.edited ?? 0,
      discarded: byStatus.discarded ?? 0,
      // Share of decided suggestions that were used (accepted or edited & sent).
      deflectionRate: resolved > 0 ? used / resolved : null,
      avgConfidence: confN > 0 ? Math.round(confSum / confN) : null,
    },
  });
});
