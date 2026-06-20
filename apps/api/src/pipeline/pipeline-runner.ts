import { getServiceClient } from '../lib/supabase.js';
import { writeAudit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import { embedText } from './embedder.js';
import { scoreRelevance, RELEVANCE_THRESHOLD } from './relevance-scorer.js';
import { checkDuplicate } from './dedup-checker.js';
import { extractKnowledge, ExtractionParseError } from './extractor.js';

// THE APPROVAL GATE ENFORCEMENT POINT.
//
// The very first query filters approval_status = 'approved'. No AI module
// (embedder, scorer, dedup, extractor) is reachable from anywhere except here,
// and this function only ever loads approved threads. Do not add a code path
// that calls these modules on staged threads — not even for preview/test.

const BATCH_SIZE = 10;

export interface PipelineStats {
  considered: number;
  embedded: number;
  skippedLowRelevance: number;
  skippedDuplicate: number;
  skippedNoKnowledge: number;
  extracted: number; // total draft entries created (a thread can yield several)
  errored: number;
}

export async function runPipeline(orgId: string): Promise<PipelineStats> {
  const db = getServiceClient();
  const stats: PipelineStats = {
    considered: 0, embedded: 0, skippedLowRelevance: 0, skippedDuplicate: 0,
    skippedNoKnowledge: 0, extracted: 0, errored: 0,
  };

  // ── FIRST QUERY — the gate. approval_status='approved' is mandatory here. ──
  const { data: threads, error } = await db
    .from('email_threads')
    .select('id, raw_content')
    .eq('org_id', orgId)
    .eq('approval_status', 'approved')
    .eq('processing_status', 'not_started');
  if (error) throw new Error(`pipeline gate query failed: ${error.message}`);

  const approved = threads ?? [];
  stats.considered = approved.length;
  await writeAudit({
    orgId, userId: null, action: 'pipeline.run_started', resource: 'email_threads',
    resourceId: orgId, metadata: { considered: approved.length },
  });

  for (let i = 0; i < approved.length; i += BATCH_SIZE) {
    const batch = approved.slice(i, i + BATCH_SIZE);
    const ids = batch.map((t) => t.id as string);
    await db.from('email_threads').update({ processing_status: 'pending' }).in('id', ids);

    for (const thread of batch) {
      const id = thread.id as string;
      const content = (thread.raw_content as string | null) ?? '';
      try {
        await db.from('email_threads').update({ processing_status: 'processing' }).eq('id', id);

        // 1. Embed (post-approval, as required).
        const embedding = await embedText(content);
        await db
          .from('email_threads')
          .update({ embedding: embedding as unknown as string })
          .eq('id', id);
        stats.embedded++;

        // 2. Relevance gate.
        const relevance = await scoreRelevance(content);
        await db.from('email_threads').update({ relevance_score: relevance.score }).eq('id', id);
        if (relevance.score < RELEVANCE_THRESHOLD) {
          await markSkipped(orgId, id, 'low_relevance', { score: relevance.score, reason: relevance.skipReason });
          stats.skippedLowRelevance++;
          continue;
        }

        // 3. Dedup gate.
        const dedup = await checkDuplicate(orgId, embedding);
        if (dedup.verdict === 'duplicate') {
          await markSkipped(orgId, id, 'duplicate', {
            topSimilarity: dedup.topSimilarity, similar: dedup.similarExtractionIds,
          });
          stats.skippedDuplicate++;
          continue;
        }

        // 4. Extract (Sonnet) — may yield several Q&A entries for a multi-issue thread.
        const extractions = await extractKnowledge(content);
        if (extractions.length === 0) {
          // Passed the gates but Sonnet found no reusable, resolved knowledge.
          await markSkipped(orgId, id, 'no_reusable_knowledge', {});
          stats.skippedNoKnowledge++;
          continue;
        }

        const mergeMeta =
          dedup.verdict === 'potential_merge'
            ? { potential_merge: dedup.similarExtractionIds, topSimilarity: dedup.topSimilarity }
            : {};

        for (const extraction of extractions) {
          const extractionEmbedding = await embedText(
            `${extraction.title}\n${extraction.question}\n${extraction.answer}`,
          );
          const { data: inserted, error: insErr } = await db
            .from('extractions')
            .insert({
              org_id: orgId,
              thread_id: id,
              question: extraction.question,
              answer: extraction.answer,
              title: extraction.title,
              category: extraction.category,
              tags: extraction.tags,
              confidence: extraction.confidence,
              caveats: extraction.caveats,
              embedding: extractionEmbedding as unknown as string,
              status: 'pending_review',
              metadata: mergeMeta,
            })
            .select('id')
            .single();
          if (insErr) throw new Error(insErr.message);

          await writeAudit({
            orgId, userId: null, action: 'extraction.created', resource: 'extractions',
            resourceId: inserted.id as string, metadata: { threadId: id },
          });
          stats.extracted++;
        }

        await db.from('email_threads').update({ processing_status: 'extracted' }).eq('id', id);
      } catch (err) {
        stats.errored++;
        const message = err instanceof Error ? err.message : String(err);
        await db
          .from('email_threads')
          .update({
            processing_status: 'error',
            metadata: { error: message, parseError: err instanceof ExtractionParseError },
          })
          .eq('id', id);
        log.error('pipeline thread failed', { threadId: id, error: message });
        // Never let one thread crash the run — continue.
      }
    }
  }

  await writeAudit({
    orgId, userId: null, action: 'pipeline.run_finished', resource: 'email_threads',
    resourceId: orgId, metadata: { ...stats },
  });
  log.info('pipeline run complete', { orgId, ...stats });
  return stats;
}

async function markSkipped(
  orgId: string, threadId: string, reason: string, metadata: Record<string, unknown>,
): Promise<void> {
  const db = getServiceClient();
  await db
    .from('email_threads')
    .update({ processing_status: 'skipped', metadata: { skipReason: reason, ...metadata } })
    .eq('id', threadId);
  await writeAudit({
    orgId, userId: null, action: 'thread.skipped', resource: 'email_threads',
    resourceId: threadId, metadata: { reason, ...metadata },
  });
}
