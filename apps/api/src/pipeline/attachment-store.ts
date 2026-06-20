import { randomUUID } from 'node:crypto';
import { getServiceClient } from '../lib/supabase.js';
import { log } from '../lib/logger.js';
import type { CleanThread } from './noise-filter.js';

// Uploads captured image bytes to the private 'attachments' Storage bucket and
// records a row per image, linked to its thread. Runs after thread-store (needs
// the thread ids) and only for NEWLY inserted threads, so re-ingest doesn't
// re-upload. No AI — fits the staging gate. Failures are logged, never fatal.

const BUCKET = 'attachments';

export async function storeAttachments(
  threads: CleanThread[],
  insertedThreads: { id: string; externalId: string }[],
  ctx: { orgId: string },
): Promise<number> {
  if (insertedThreads.length === 0) return 0;
  const db = getServiceClient();
  const idByExternal = new Map(insertedThreads.map((t) => [t.externalId, t.id]));
  let stored = 0;

  for (const thread of threads) {
    const threadId = idByExternal.get(thread.externalId);
    if (!threadId) continue; // only newly inserted threads
    for (const msg of thread.messages) {
      for (const att of msg.attachments ?? []) {
        try {
          const safe = att.filename.replace(/[^a-z0-9._-]+/gi, '_').slice(-100);
          const path = `${ctx.orgId}/${threadId}/${randomUUID()}-${safe}`;
          const up = await db.storage
            .from(BUCKET)
            .upload(path, att.data, { contentType: att.contentType, upsert: false });
          if (up.error) {
            log.error('attachment upload failed', { file: att.filename, error: up.error.message });
            continue;
          }
          const { error: insErr } = await db.from('attachments').insert({
            org_id: ctx.orgId,
            thread_id: threadId,
            filename: att.filename,
            content_type: att.contentType,
            size: att.size,
            storage_path: path,
            inline: att.inline,
          });
          if (insErr) {
            log.error('attachment row insert failed', { error: insErr.message });
            continue;
          }
          stored++;
        } catch (err) {
          log.error('attachment store error', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  if (stored > 0) log.info('attachments stored', { orgId: ctx.orgId, stored });
  return stored;
}
