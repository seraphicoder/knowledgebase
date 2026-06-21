import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAudit } from '../lib/audit.js';
import { log } from '../lib/logger.js';

// Publishing an approved extraction into the knowledge base: render a markdown
// article body, copy the already-computed embedding (no new AI call), create a
// kb_articles row linked back to the extraction, and attach the reviewer's
// curated set of images (original or edited).

export interface ExtractionForPublish {
  id: string;
  thread_id: string | null;
  question: string | null;
  answer: string | null;
  title: string | null;
  category: string | null;
  tags: string[];
  caveats: string | null;
  embedding: string | null; // pgvector text form, copied straight through
}

// Reviewer's per-image choice at publish time. Only included images are sent.
export interface PublishImage {
  sourceAttachmentId?: string;
  /** Edited/cropped/annotated version as a data URL; absent = use the original. */
  editedDataUrl?: string | null;
  /** Reuse an already-stored object (preserved/edited from a prior publish). */
  storagePath?: string;
  contentType?: string;
  edited?: boolean;
}

const BUCKET = 'attachments';

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
  images?: PublishImage[],
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

  const articleId = article.id as string;
  const imageCount = await attachArticleImages(db, orgId, articleId, e.thread_id, images);

  await writeAudit({
    orgId, userId, action: 'article.published', resource: 'kb_articles',
    resourceId: articleId, metadata: { extractionId: e.id, images: imageCount },
  });
  return articleId;
}

/**
 * Attach the reviewer's curated images to a published article. Included images
 * either copy a source attachment's bytes (by reference, same storage_path) or
 * upload an edited version. If `images` is omitted, defaults to ALL of the source
 * thread's images (preserves "show everything" when the reviewer didn't curate).
 */
export async function attachArticleImages(
  db: SupabaseClient,
  orgId: string,
  articleId: string,
  threadId: string | null,
  images?: PublishImage[],
): Promise<number> {
  // Source attachments (for the "copy original" and default-all cases).
  const { data: atts } = threadId
    ? await db.from('attachments').select('id, storage_path, content_type').eq('org_id', orgId).eq('thread_id', threadId)
    : { data: [] };
  const byId = new Map((atts ?? []).map((a) => [a.id as string, a]));

  // No explicit curation -> include all source images unedited.
  const chosen: PublishImage[] =
    images ?? (atts ?? []).map((a) => ({ sourceAttachmentId: a.id as string }));

  let position = 0;
  let count = 0;
  for (const img of chosen) {
    const src = img.sourceAttachmentId ? byId.get(img.sourceAttachmentId) : undefined;

    let storagePath: string;
    let contentType: string;
    let edited: boolean;

    if (img.editedDataUrl) {
      // Newly edited this session -> upload a fresh object.
      const parsed = parseDataUrl(img.editedDataUrl);
      if (!parsed) continue;
      contentType = parsed.contentType;
      storagePath = `${orgId}/articles/${articleId}/${randomUUID()}.${extFor(contentType)}`;
      const up = await db.storage.from(BUCKET).upload(storagePath, parsed.buffer, { contentType, upsert: false });
      if (up.error) {
        log.error('article image upload failed', { error: up.error.message });
        continue;
      }
      edited = true;
    } else if (img.storagePath) {
      // Reuse an already-stored object (preserved/edited from a prior publish).
      storagePath = img.storagePath;
      contentType = img.contentType ?? (src?.content_type as string | null) ?? 'image/png';
      edited = img.edited ?? false;
    } else if (src) {
      // Copy the original source attachment by reference.
      storagePath = src.storage_path as string;
      contentType = (src.content_type as string | null) ?? 'image/png';
      edited = false;
    } else {
      continue; // nothing to store
    }

    const { error } = await db.from('kb_article_images').insert({
      org_id: orgId,
      kb_article_id: articleId,
      source_attachment_id: src?.id ?? null,
      storage_path: storagePath,
      content_type: contentType,
      edited,
      position: position++,
    });
    if (!error) count++;
    else log.error('kb_article_images insert failed', { error: error.message });
  }
  return count;
}

function parseDataUrl(s: string): { contentType: string; buffer: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(s);
  if (!m) return null;
  try {
    return { contentType: m[1]!, buffer: Buffer.from(m[2]!, 'base64') };
  } catch {
    return null;
  }
}

function extFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('webp')) return 'webp';
  return 'img';
}
