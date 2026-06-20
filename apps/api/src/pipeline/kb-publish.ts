import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAudit } from '../lib/audit.js';

// Publishing an approved extraction into the knowledge base: render a markdown
// article body, copy the already-computed embedding (no new AI call), and create
// a kb_articles row linked back to the extraction.

export interface ExtractionForPublish {
  id: string;
  question: string | null;
  answer: string | null;
  title: string | null;
  category: string | null;
  tags: string[];
  caveats: string | null;
  embedding: string | null; // pgvector text form, copied straight through
}

/** Render an extraction's Q&A into a markdown article body. */
export function buildArticleBody(e: {
  question: string | null;
  answer: string | null;
  caveats: string | null;
}): string {
  const parts = [
    '**Question**',
    '',
    e.question?.trim() || '_(none)_',
    '',
    '**Answer**',
    '',
    e.answer?.trim() || '_(none)_',
  ];
  if (e.caveats?.trim()) {
    parts.push('', '**Caveats**', '', e.caveats.trim());
  }
  return parts.join('\n');
}

/**
 * Publishes an extraction to kb_articles and marks it 'published'. Returns the
 * new article id. Caller must have already verified the extraction belongs to
 * the org and is in 'pending_review'.
 */
export async function publishExtraction(
  db: SupabaseClient,
  orgId: string,
  userId: string,
  e: ExtractionForPublish,
): Promise<string> {
  const { data: article, error: insErr } = await db
    .from('kb_articles')
    .insert({
      org_id: orgId,
      extraction_id: e.id,
      title: e.title?.trim() || 'Untitled',
      body: buildArticleBody(e),
      category: e.category,
      tags: e.tags ?? [],
      embedding: e.embedding, // already in pgvector text form from the extraction
      published_at: new Date().toISOString(),
      version: 1,
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`KB publish failed: ${insErr.message}`);

  await db.from('extractions').update({ status: 'published' }).eq('id', e.id);

  await writeAudit({
    orgId, userId, action: 'article.published', resource: 'kb_articles',
    resourceId: article.id as string, metadata: { extractionId: e.id },
  });
  return article.id as string;
}
