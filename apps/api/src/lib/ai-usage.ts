import { AsyncLocalStorage } from 'node:async_hooks';
import { getServiceClient } from './supabase.js';
import { log } from './logger.js';

// Token-usage attribution. AI calls happen deep in the pipeline/agent code where
// org_id isn't always in scope, so we carry it on an AsyncLocalStorage set at the
// request/run boundary (withOrg). The AI client wrappers (lib/ai.ts) call
// recordUsage(), which reads the current org and writes a row to ai_usage.
//
// Recording is best-effort and fire-and-forget: analytics must never slow down or
// break a model call. An unattributed call (no org context) records org_id=null.

const orgStore = new AsyncLocalStorage<{ orgId: string | null }>();

/** Run `fn` with `orgId` attributed to any AI usage recorded inside it. */
export function withOrg<T>(orgId: string | null, fn: () => Promise<T>): Promise<T> {
  return orgStore.run({ orgId }, fn);
}

export interface UsageRecord {
  provider: 'anthropic' | 'openai';
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
}

export function recordUsage(u: UsageRecord): void {
  const orgId = orgStore.getStore()?.orgId ?? null;
  void getServiceClient()
    .from('ai_usage')
    .insert({
      org_id: orgId,
      provider: u.provider,
      model: u.model,
      operation: u.operation,
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
    })
    .then(({ error }) => {
      if (error) log.warn('ai_usage record failed', { error: error.message });
    });
}
