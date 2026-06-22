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
  /** Cap conversations pulled this run; the forward cursor resumes on the next run. */
  limit?: number;
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

  // Forward sync: resume from the saved cursor and pull records created after it.
  const { data: row } = await db
    .from('ingestion_sources')
    .select('sync_cursor')
    .eq('id', source.id)
    .single();
  const cursor = (row?.sync_cursor as string | null) ?? null;

  const connector = createConnector(source);
  const startedAt = new Date();

  const page = await connector.fetchConversations(cursor, { limit: options.limit });
  const threads = reconstructThreads(page.conversations, source.type);
  const cleaned = threads.map(filterThread);
  const result = await storeThreads(cleaned, { orgId: source.org_id, sourceId: source.id });

  // Persist image attachments for the newly stored threads (no AI; storage only).
  await storeAttachments(cleaned, result.insertedThreads, { orgId: source.org_id });

  // `caughtUp` = we've reached the end of history for now. The cursor still
  // advances (and is persisted) so the next run fetches only newer records.
  const caughtUp = !page.hasMore;
  await db
    .from('ingestion_sources')
    .update({
      last_synced_at: startedAt.toISOString(),
      sync_cursor: page.nextCursor,
      backfill_complete: caughtUp,
      status: 'active',
    })
    .eq('id', source.id);

  log.info('source ingestion complete', {
    sourceId: source.id,
    type: source.type,
    conversations: page.conversations.length,
    threads: threads.length,
    limit: options.limit ?? null,
    nextCursor: page.nextCursor,
    caughtUp,
    ...result,
  });
  return { ...result, backfillComplete: caughtUp };
}
