import { createConnector, type IngestionSourceRow } from './connector-factory.js';
import { reconstructThreads } from './thread-reconstructor.js';
import { filterThread } from './noise-filter.js';
import { storeThreads, type StoreResult } from './thread-store.js';
import { storeAttachments } from './attachment-store.js';
import { getServiceClient } from '../lib/supabase.js';
import { log } from '../lib/logger.js';

// Milestone 1 ingestion orchestrator: connector -> reconstruct -> noise filter
// -> store. This is the COMPLETE ingestion path and it contains ZERO AI calls.
// It must run end-to-end with ANTHROPIC_API_KEY and OPENAI_API_KEY absent.

export interface IngestOptions {
  /** Cap conversations pulled this run; resumes forward on the next run. */
  limit?: number;
  /**
   * Incremental "pull new": start from the newest record and stop at the first
   * already-ingested conversation (skips the expensive per-item fetch for known
   * ones). Does NOT advance the backward backfill cursor. Omitted = backfill.
   */
  incremental?: boolean;
}

export interface IngestResult extends StoreResult {
  /** Whether there is more history to pull on the next run. */
  backfillComplete: boolean;
}

export async function ingestSource(
  source: IngestionSourceRow,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const db = getServiceClient();
  const incremental = options.incremental ?? false;

  // Incremental "pull new" starts from the newest record and stops at the first
  // already-ingested conversation. Backfill resumes the backwards walk from the
  // saved cursor.
  let cursor: string | null = null;
  if (!incremental) {
    const { data: row } = await db
      .from('ingestion_sources')
      .select('sync_cursor')
      .eq('id', source.id)
      .single();
    cursor = (row?.sync_cursor as string | null) ?? null;
  }

  // Cheap existence check used by the connector to skip/stop on known items.
  const isKnown = incremental
    ? async (externalId: string): Promise<boolean> => {
        const { count } = await db
          .from('email_threads')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', source.org_id)
          .eq('source_id', source.id)
          .eq('external_thread_id', externalId);
        return (count ?? 0) > 0;
      }
    : undefined;

  const connector = createConnector(source);
  const startedAt = new Date();

  const page = await connector.fetchConversations(cursor, { limit: options.limit, isKnown });
  const threads = reconstructThreads(page.conversations, source.type);
  const cleaned = threads.map(filterThread);
  const result = await storeThreads(cleaned, { orgId: source.org_id, sourceId: source.id });

  // Persist image attachments for the newly stored threads (no AI; storage only).
  await storeAttachments(cleaned, result.insertedThreads, { orgId: source.org_id });

  const backfillComplete = page.nextCursor === null;
  // Incremental is a forward catch-up — don't disturb the backfill cursor.
  const update: Record<string, unknown> = incremental
    ? { last_synced_at: startedAt.toISOString(), status: 'active' }
    : {
        last_synced_at: startedAt.toISOString(),
        sync_cursor: page.nextCursor,
        backfill_complete: backfillComplete,
        status: 'active',
      };
  await db.from('ingestion_sources').update(update).eq('id', source.id);

  log.info('source ingestion complete', {
    sourceId: source.id,
    type: source.type,
    incremental,
    conversations: page.conversations.length,
    threads: threads.length,
    limit: options.limit ?? null,
    nextCursor: page.nextCursor,
    backfillComplete,
    ...result,
  });
  return { ...result, backfillComplete };
}
