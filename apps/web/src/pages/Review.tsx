import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listExtractions,
  getExtraction,
  editExtraction,
  approveExtraction,
  rejectExtraction,
  listThreadAttachments,
  getExtractionSimilar,
  mergePreview,
  mergeApply,
  type MergeCandidate,
  type Extraction,
  type ExtractionSourceThread,
  type ExtractionEdit,
  type PublishImageInput,
  type SimilarArticle,
} from '../lib/api';
import { supabase } from '../lib/supabase';
import { Lightbox } from '../components/Lightbox';
import { useInfinitePages } from '../lib/useInfinitePages';

// Heavy canvas editor — lazy-loaded so it stays out of the main bundle.
const ImageEditorModal = lazy(() => import('../components/ImageEditorModal'));

// A unified curation item: a source-thread attachment OR an image preserved from
// a prior publish (possibly edited). On publish it resolves to a source ref, a
// reused storage object, or a freshly uploaded edit.
interface CurImage {
  key: string;
  url: string | null;
  filename?: string | null;
  included: boolean;
  edited: boolean;
  sourceAttachmentId?: string;
  storagePath?: string;
  contentType?: string | null;
  editedDataUrl?: string; // set if re-edited this session
}

// Milestone 3 Review Queue. Humans qualify AI-drafted extractions: edit the
// title/question/answer, then approve (becomes eligible to publish) or reject.
export function Review() {
  const { items, total, loading, error, reload: load, sentinelRef } = useInfinitePages<Extraction>(
    (offset, limit) => listExtractions('pending_review', { offset, limit }).then((r) => ({ items: r.extractions, total: r.total })),
    'review',
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [similarFlags, setSimilarFlags] = useState<Set<string>>(new Set());

  // Flag drafts that closely match an existing published article (best-effort).
  useEffect(() => {
    let active = true;
    if (items.length === 0) {
      setSimilarFlags(new Set());
      return;
    }
    Promise.all(
      items.map(async (x) => {
        try {
          const r = await getExtractionSimilar(x.id);
          return r.similar.some((s) => s.similarity >= 0.6) ? x.id : null;
        } catch {
          return null;
        }
      }),
    ).then((ids) => {
      if (active) setSimilarFlags(new Set(ids.filter((i): i is string => i !== null)));
    });
    return () => {
      active = false;
    };
  }, [items]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex gap-4 text-sm">
            <Link to="/staging" className="text-gray-500 hover:underline">Staging</Link>
            <Link to="/queued" className="text-gray-500 hover:underline">Queued</Link>
            <span className="font-medium text-gray-900">Review</span>
            <Link to="/kb" className="text-gray-500 hover:underline">Knowledge Base</Link>
            <Link to="/replies" className="text-gray-500 hover:underline">Reply Agent</Link>
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
            <Link to="/users" className="text-gray-500 hover:underline">Users</Link>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Review Queue</h1>
          <p className="text-sm text-gray-500">
            {total} draft{total === 1 ? '' : 's'} awaiting review — edit, then approve or reject.
          </p>
        </div>
        <button
          onClick={() => void supabase.auth.signOut()}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Confidence</th>
              <th className="px-3 py-2">Tags</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400">No drafts to review. Queue threads in Staging, then run the pipeline.</td></tr>
            ) : (
              items.map((x) => (
                <tr key={x.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <button onClick={() => setOpenId(x.id)} className="text-left font-medium text-blue-700 hover:underline">
                      {x.title || '(untitled)'}
                    </button>
                    {similarFlags.has(x.id) && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800" title="A similar published article exists">
                        ⚠ similar
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{x.category || '—'}</td>
                  <td className="px-3 py-2 text-gray-600">{fmtConfidence(x.confidence)}</td>
                  <td className="px-3 py-2 text-gray-600">{x.tags.slice(0, 3).join(', ')}{x.tags.length > 3 ? '…' : ''}</td>
                  <td className="px-3 py-2 text-gray-500">{fmtDateTime(x.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div ref={sentinelRef} className="h-8" />
      {loading && items.length > 0 && <p className="py-2 text-center text-xs text-gray-400">Loading more…</p>}

      {openId && (
        <ReviewDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onResolved={() => {
            setOpenId(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ReviewDrawer({
  id,
  onClose,
  onResolved,
}: {
  id: string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [draft, setDraft] = useState<Extraction | null>(null);
  const [thread, setThread] = useState<ExtractionSourceThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [curImages, setCurImages] = useState<CurImage[]>([]);
  const [fromArticle, setFromArticle] = useState(false);
  const [editing, setEditing] = useState<{ key: string; source: string } | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [similar, setSimilar] = useState<SimilarArticle[]>([]);
  const [merging, setMerging] = useState<{ articleId: string; title: string; body: string } | null>(null);
  const [mergeImages, setMergeImages] = useState<(MergeCandidate & { included: boolean; key: string })[]>([]);
  const [mergeBusy, setMergeBusy] = useState(false);

  async function startMerge(articleId: string) {
    setMergeBusy(true);
    setError(null);
    try {
      const { merged, images } = await mergePreview(id, articleId);
      setMerging({ articleId, title: merged.title, body: merged.body });
      setMergeImages(images.map((im, i) => ({ ...im, included: true, key: `${im.source}-${im.storagePath ?? im.sourceAttachmentId ?? i}` })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build a merge preview');
    } finally {
      setMergeBusy(false);
    }
  }

  async function applyMerge() {
    if (!merging) return;
    setMergeBusy(true);
    setError(null);
    const images: PublishImageInput[] = mergeImages
      .filter((m) => m.included)
      .map((m) =>
        m.storagePath
          ? { storagePath: m.storagePath, contentType: m.contentType, edited: m.edited }
          : { sourceAttachmentId: m.sourceAttachmentId ?? undefined },
      );
    try {
      await mergeApply(id, { articleId: merging.articleId, title: merging.title, body: merging.body, images });
      setMerging(null);
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed');
      setMergeBusy(false);
    }
  }

  async function loadSourceImages(threadId: string): Promise<CurImage[]> {
    const att = await listThreadAttachments(threadId).catch(() => ({ attachments: [] }));
    return att.attachments.map((a) => ({
      key: a.id,
      url: a.url,
      filename: a.filename,
      included: true,
      edited: false,
      sourceAttachmentId: a.id,
    }));
  }

  useEffect(() => {
    let active = true;
    getExtraction(id)
      .then(async (res) => {
        if (!active) return;
        setDraft(res.extraction);
        setThread(res.thread);
        if (res.curatedImages && res.curatedImages.length > 0) {
          // Re-editing a published article — keep its curated/edited images.
          setFromArticle(true);
          setCurImages(
            res.curatedImages.map((ci, i) => ({
              key: ci.storage_path || `c${i}`,
              url: ci.url,
              included: true,
              edited: ci.edited,
              sourceAttachmentId: ci.source_attachment_id ?? undefined,
              storagePath: ci.storage_path,
              contentType: ci.content_type,
            })),
          );
        } else if (res.thread) {
          setFromArticle(false);
          const imgs = await loadSourceImages(res.thread.id);
          if (active) setCurImages(imgs);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load draft'));
    // Surface near-duplicate published articles (best-effort).
    getExtractionSimilar(id)
      .then((r) => active && setSimilar(r.similar.filter((s) => s.similarity >= 0.6)))
      .catch(() => active && setSimilar([]));
    return () => {
      active = false;
    };
  }, [id]);

  async function resetToOriginals() {
    if (!thread) return;
    setCurImages(await loadSourceImages(thread.id));
    setFromArticle(false);
  }

  function imagePayload(): PublishImageInput[] {
    return curImages
      .filter((c) => c.included)
      .map((c) => {
        if (c.editedDataUrl) return { editedDataUrl: c.editedDataUrl, sourceAttachmentId: c.sourceAttachmentId };
        if (c.storagePath) return { storagePath: c.storagePath, contentType: c.contentType, edited: c.edited, sourceAttachmentId: c.sourceAttachmentId };
        return { sourceAttachmentId: c.sourceAttachmentId };
      });
  }

  // Open the editor with a data URL (avoids tainted-canvas on cross-origin images).
  async function openEditor(img: CurImage) {
    if (img.editedDataUrl) {
      setEditing({ key: img.key, source: img.editedDataUrl });
      return;
    }
    if (!img.url) return;
    try {
      const blob = await (await fetch(img.url)).blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      setEditing({ key: img.key, source: dataUrl });
    } catch {
      setError('Could not open the image for editing.');
    }
  }

  function set<K extends keyof Extraction>(key: K, value: Extraction[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function onSave() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const patch: ExtractionEdit = {
      title: draft.title ?? '',
      question: draft.question ?? '',
      answer: draft.answer ?? '',
      category: draft.category,
      tags: draft.tags,
      caveats: draft.caveats,
    };
    try {
      await editExtraction(id, patch);
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setBusy(false);
    }
  }

  async function onDecision(kind: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      // Persist any edits before approving so the approved draft reflects them.
      if (kind === 'approve' && draft) {
        await editExtraction(id, {
          title: draft.title ?? '',
          question: draft.question ?? '',
          answer: draft.answer ?? '',
          category: draft.category,
          tags: draft.tags,
          caveats: draft.caveats,
        });
      }
      await (kind === 'approve' ? approveExtraction(id, imagePayload()) : rejectExtraction(id));
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${kind} failed`);
      setBusy(false);
    }
  }

  return (
    <>
    <div className="fixed inset-0 z-10 flex justify-end bg-black/20" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">Review draft</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        {error && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {!draft ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <div className="space-y-4">
            {similar.length > 0 && (
              <div className={`rounded border px-3 py-2 text-sm ${similar[0]!.similarity >= 0.9 ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
                <p className="font-medium">
                  {similar[0]!.similarity >= 0.9 ? '⚠ Possible duplicate — very similar to an existing article' : 'Similar existing articles'}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {similar.map((s) => (
                    <li key={s.id}>
                      {Math.round(s.similarity * 100)}% —{' '}
                      <Link to={`/kb?article=${s.id}`} className="text-blue-700 underline hover:text-blue-900">
                        {s.title}
                      </Link>
                      <button
                        onClick={() => void startMerge(s.id)}
                        disabled={mergeBusy}
                        className="ml-2 text-blue-700 underline hover:text-blue-900 disabled:opacity-40"
                      >
                        merge into this
                      </button>
                    </li>
                  ))}
                </ul>
                {similar[0]!.similarity >= 0.9 && (
                  <p className="mt-1 text-xs">Consider rejecting this draft and editing the existing article instead.</p>
                )}
              </div>
            )}

            <Field label="Title">
              <input className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" value={draft.title ?? ''} onChange={(e) => set('title', e.target.value)} />
            </Field>
            <Field label="Question">
              <textarea className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" rows={2} value={draft.question ?? ''} onChange={(e) => set('question', e.target.value)} />
            </Field>
            <Field label="Answer">
              <textarea className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" rows={6} value={draft.answer ?? ''} onChange={(e) => set('answer', e.target.value)} />
            </Field>
            <div className="flex gap-3">
              <Field label="Category">
                <input className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" value={draft.category ?? ''} onChange={(e) => set('category', e.target.value)} />
              </Field>
              <Field label="Tags (comma-separated)">
                <input
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                  value={draft.tags.join(', ')}
                  onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
                />
              </Field>
            </div>
            <Field label="Caveats">
              <textarea className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" rows={2} value={draft.caveats ?? ''} onChange={(e) => set('caveats', e.target.value)} />
            </Field>

            {curImages.length > 0 && (
              <div className="border-t border-gray-100 pt-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-700">
                    Images ({curImages.filter((c) => c.included).length}/{curImages.length} included)
                  </h3>
                  {fromArticle && (
                    <button type="button" onClick={() => void resetToOriginals()} className="text-xs text-blue-700 hover:underline">
                      Reset to original images
                    </button>
                  )}
                </div>
                <p className="mb-2 text-xs text-gray-400">Uncheck to leave an image off the published article, or edit to crop/annotate it.</p>
                <div className="flex flex-wrap gap-3">
                  {curImages.map((c, idx) => {
                    const preview = c.editedDataUrl ?? c.url ?? '';
                    return (
                      <div key={c.key} className="w-28">
                        <div className={`relative rounded border ${c.included ? 'border-emerald-400' : 'border-gray-200 opacity-50'}`}>
                          {preview && (
                            <button type="button" onClick={() => setPreviewIndex(idx)} className="block w-full" title="Preview">
                              <img src={preview} alt={c.filename ?? ''} className="h-24 w-full cursor-zoom-in rounded object-cover" />
                            </button>
                          )}
                          {(c.editedDataUrl || c.edited) && (
                            <span className="absolute left-1 top-1 rounded bg-blue-600 px-1 text-[10px] text-white">edited</span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center justify-between text-xs">
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={c.included}
                              onChange={(e) =>
                                setCurImages((list) => list.map((x) => (x.key === c.key ? { ...x, included: e.target.checked } : x)))
                              }
                            />
                            include
                          </label>
                          <button type="button" onClick={() => void openEditor(c)} className="text-blue-700 hover:underline">
                            edit
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <p className="text-xs text-gray-500">AI confidence: {fmtConfidence(draft.confidence)}</p>

            <div className="flex items-center gap-2 border-t border-gray-100 pt-4">
              <button onClick={() => void onDecision('approve')} disabled={busy} className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
                Approve &amp; Publish
              </button>
              <button onClick={() => void onDecision('reject')} disabled={busy} className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
                Reject
              </button>
              <button onClick={() => void onSave()} disabled={busy} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
                Save edits
              </button>
            </div>

            {thread && (
              <details open className="mt-4 rounded border border-gray-200 p-3">
                <summary className="cursor-pointer text-sm font-medium text-gray-700">
                  Source thread — where this came from
                </summary>
                <p className="mt-2 text-xs font-medium text-gray-600">{thread.subject || '(no subject)'}</p>
                <p className="text-xs text-gray-400">{thread.participants.join(', ')}</p>
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-gray-50 p-3 text-xs text-gray-700">
                  {thread.raw_content || '(empty)'}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>

      {previewIndex != null && (
        <Lightbox
          images={curImages.map((c) => ({ url: c.editedDataUrl ?? c.url ?? '', filename: c.filename }))}
          index={previewIndex}
          onIndex={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}

      {editing && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 text-sm text-white">
              Loading editor…
            </div>
          }
        >
          <ImageEditorModal
            source={editing.source}
            onClose={() => setEditing(null)}
            onSave={(dataUrl) => {
              setCurImages((list) =>
                list.map((x) => (x.key === editing.key ? { ...x, included: true, edited: true, editedDataUrl: dataUrl } : x)),
              );
              setEditing(null);
            }}
          />
        </Suspense>
      )}

      {merging && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-6" onClick={() => !mergeBusy && setMerging(null)}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 text-lg font-semibold">Merge into existing article</h3>
            <p className="mb-3 text-xs text-gray-500">
              AI-merged result — edit if needed, then apply. This updates the existing article (new version) and removes this draft from the queue.
            </p>
            <label className="mb-2 block text-sm">
              <span className="mb-1 block font-medium text-gray-600">Title</span>
              <input
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                value={merging.title}
                onChange={(e) => setMerging((m) => (m ? { ...m, title: e.target.value } : m))}
              />
            </label>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block font-medium text-gray-600">Body (merged)</span>
              <textarea
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                rows={12}
                value={merging.body}
                onChange={(e) => setMerging((m) => (m ? { ...m, body: e.target.value } : m))}
              />
            </label>

            {mergeImages.length > 0 && (
              <div className="mb-3">
                <p className="mb-1 text-sm font-medium text-gray-600">
                  Images ({mergeImages.filter((m) => m.included).length}/{mergeImages.length} included)
                </p>
                <p className="mb-2 text-xs text-gray-400">Article images and the ticket's images combined — uncheck any you don't want on the merged article.</p>
                <div className="flex flex-wrap gap-3">
                  {mergeImages.map((m) => (
                    <div key={m.key} className="w-24">
                      <div className={`relative rounded border ${m.included ? 'border-emerald-400' : 'border-gray-200 opacity-50'}`}>
                        {m.url && <img src={m.url} alt={m.filename ?? ''} className="h-20 w-full rounded object-cover" />}
                        <span className={`absolute left-1 top-1 rounded px-1 text-[10px] text-white ${m.source === 'article' ? 'bg-gray-600' : 'bg-blue-600'}`}>
                          {m.source}
                        </span>
                      </div>
                      <label className="mt-1 flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={m.included}
                          onChange={(e) => setMergeImages((list) => list.map((x) => (x.key === m.key ? { ...x, included: e.target.checked } : x)))}
                        />
                        include
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={() => void applyMerge()} disabled={mergeBusy} className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
                {mergeBusy ? 'Applying…' : 'Apply merge'}
              </button>
              <button onClick={() => setMerging(null)} disabled={mergeBusy} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block flex-1 text-sm">
      <span className="mb-1 block font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}

function fmtConfidence(c: number | null): string {
  if (c == null) return '—';
  return `${Math.round(c * 100)}%`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
