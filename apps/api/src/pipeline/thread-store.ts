import { getServiceClient } from '../lib/supabase.js';
import { writeAuditBatch, type AuditEntry } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { CleanThread } from './noise-filter.js';

// Persists cleaned threads to email_threads. This module is the END of the
// ingestion path. It performs NO AI calls of any kind. Every row is written with
// approval_status = 'staged' and processing_status = 'not_started' — always,
// with no parameter or code path that can set 'approved'. That flip happens only
// via the staging approval routes. (Architecture Rule #7.)
//
// NOTE: table is named `email_threads` but stores conversations from ANY
// connector. Renaming is deferred naming debt — do not rename mid-milestone.

export interface StoreResult {
  inserted: number;
  duplicatesSkipped: number;
  /** Newly inserted threads, for linking attachments (externalId -> db id). */
  insertedThreads: { id: string; externalId: string }[];
}

const BATCH_SIZE = 200;

export async function storeThreads(
  threads: CleanThread[],
  ctx: { orgId: string; sourceId: string },
): Promise<StoreResult> {
  if (threads.length === 0) return { inserted: 0, duplicatesSkipped: 0, insertedThreads: [] };

  const db = getServiceClient();

  // Dedup on (org_id, source_id, external_thread_id) before inserting.
  const externalIds = threads.map((t) => t.externalId);
  const { data: existing, error: selErr } = await db
    .from('email_threads')
    .select('external_thread_id')
    .eq('org_id', ctx.orgId)
    .eq('source_id', ctx.sourceId)
    .in('external_thread_id', externalIds);
  if (selErr) throw new Error(`thread-store dedup query failed: ${selErr.message}`);

  const seen = new Set((existing ?? []).map((r) => r.external_thread_id as string));
  const fresh = threads.filter((t) => !seen.has(t.externalId));
  const duplicatesSkipped = threads.length - fresh.length;

  let inserted = 0;
  const insertedThreads: { id: string; externalId: string }[] = [];
  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    const chunk = fresh.slice(i, i + BATCH_SIZE);
    const rows = chunk.map((t) => ({
      org_id: ctx.orgId,
      source_id: ctx.sourceId,
      external_thread_id: t.externalId,
      subject: t.subject,
      participants: t.participants,
      message_count: t.messages.length,
      raw_content: t.cleanedContent,
      date_range_start: t.dateRange.start.toISOString(),
      date_range_end: t.dateRange.end.toISOString(),
      approval_status: 'staged' as const, // ALWAYS staged — the gate
      processing_status: 'not_started' as const,
      metadata: t.metadata,
      // embedding intentionally omitted — null until approved + processed
    }));

    // ignoreDuplicates guards against races against the unique constraint.
    const { data, error } = await db
      .from('email_threads')
      .upsert(rows, {
        onConflict: 'org_id,source_id,external_thread_id',
        ignoreDuplicates: true,
      })
      .select('id, external_thread_id');
    if (error) throw new Error(`thread-store insert failed: ${error.message}`);

    const insertedRows = data ?? [];
    inserted += insertedRows.length;
    for (const r of insertedRows) {
      insertedThreads.push({ id: r.id as string, externalId: r.external_thread_id as string });
    }

    const audits: AuditEntry[] = insertedRows.map((r) => ({
      orgId: ctx.orgId,
      userId: null, // system ingestion action
      action: 'thread.staged',
      resource: 'email_threads',
      resourceId: r.id as string,
      metadata: { sourceId: ctx.sourceId },
    }));
    await writeAuditBatch(audits);
  }

  log.info('threads stored', {
    orgId: ctx.orgId,
    sourceId: ctx.sourceId,
    inserted,
    duplicatesSkipped,
  });
  return { inserted, duplicatesSkipped, insertedThreads };
}
