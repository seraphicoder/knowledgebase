import { getServiceClient } from './supabase.js';

// Per-org usage limits (vendor-set caps for cost control). Tokens and ingestion
// are measured against the current calendar month; storage is an absolute total.
// A null limit means unlimited. Enforcement calls limitBlock() at entry points;
// the org dashboard shows usage via evaluateLimits().

export interface Dimension {
  usage: number;
  limit: number | null;
  exceeded: boolean;
}

export interface LimitStatus {
  tokens: Dimension;
  storage: Dimension;
  ingest: Dimension;
}

export type LimitKind = keyof LimitStatus;

/** First instant of the current UTC calendar month. */
export function monthStartIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function dim(usage: number, limit: number | null): Dimension {
  return { usage, limit, exceeded: limit != null && usage >= limit };
}

export async function evaluateLimits(orgId: string): Promise<LimitStatus> {
  const db = getServiceClient();
  const since = monthStartIso();
  const [orgRes, tokRes, storRes, ingRes] = await Promise.all([
    db.from('organizations').select('monthly_token_limit, storage_limit_bytes, monthly_ingest_limit').eq('id', orgId).single(),
    db.rpc('org_token_usage', { p_org: orgId, p_since: since }),
    db.rpc('org_storage_bytes', { p_org: orgId }),
    db.from('email_threads').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('ingested_at', since),
  ]);
  const lim = (orgRes.data ?? {}) as {
    monthly_token_limit?: number | null;
    storage_limit_bytes?: number | null;
    monthly_ingest_limit?: number | null;
  };
  return {
    tokens: dim(Number(tokRes.data ?? 0), lim.monthly_token_limit ?? null),
    storage: dim(Number(storRes.data ?? 0), lim.storage_limit_bytes ?? null),
    ingest: dim(ingRes.count ?? 0, lim.monthly_ingest_limit ?? null),
  };
}

const MESSAGES: Record<LimitKind, string> = {
  tokens: 'Monthly AI token limit reached for this organization — contact your administrator.',
  storage: 'Storage limit reached for this organization — contact your administrator.',
  ingest: 'Monthly ingestion limit reached for this organization — contact your administrator.',
};

/** Returns a user-facing message if any requested dimension is over its cap, else null. */
export async function limitBlock(orgId: string, kinds: LimitKind[]): Promise<string | null> {
  const status = await evaluateLimits(orgId);
  for (const k of kinds) {
    if (status[k].exceeded) return MESSAGES[k];
  }
  return null;
}
