import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listExtractions,
  getExtraction,
  editExtraction,
  approveExtraction,
  rejectExtraction,
  listThreadAttachments,
  type Extraction,
  type ExtractionSourceThread,
  type ExtractionEdit,
  type ThreadAttachment,
  type PublishImageInput,
} from '../lib/api';
import { supabase } from '../lib/supabase';

// Heavy canvas editor — lazy-loaded so it stays out of the main bundle.
const ImageEditorModal = lazy(() => import('../components/ImageEditorModal'));

interface ImageChoice {
  included: boolean;
  editedDataUrl?: string;
}

// Milestone 3 Review Queue. Humans qualify AI-drafted extractions: edit the
// title/question/answer, then approve (becomes eligible to publish) or reject.
export function Review() {
  const [items, setItems] = useState<Extraction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listExtractions('pending_review');
      setItems(res.extractions);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load review queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex gap-4 text-sm">
            <Link to="/staging" className="text-gray-500 hover:underline">Staging</Link>
            <Link to="/approved" className="text-gray-500 hover:underline">Approved</Link>
            <span className="font-medium text-gray-900">Review</span>
            <Link to="/kb" className="text-gray-500 hover:underline">Knowledge Base</Link>
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
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
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">No drafts to review. Approve threads in Staging, then run the pipeline.</td></tr>
            ) : (
              items.map((x) => (
                <tr key={x.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <button onClick={() => setOpenId(x.id)} className="text-left font-medium text-blue-700 hover:underline">
                      {x.title || '(untitled)'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{x.category || '—'}</td>
                  <td className="px-3 py-2 text-gray-600">{fmtConfidence(x.confidence)}</td>
                  <td className="px-3 py-2 text-gray-600">{x.tags.slice(0, 3).join(', ')}{x.tags.length > 3 ? '…' : ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
  const [images, setImages] = useState<ThreadAttachment[]>([]);
  const [choices, setChoices] = useState<Record<string, ImageChoice>>({});
  const [editing, setEditing] = useState<{ id: string; source: string } | null>(null);

  useEffect(() => {
    let active = true;
    getExtraction(id)
      .then(async (res) => {
        if (!active) return;
        setDraft(res.extraction);
        setThread(res.thread);
        // Load the source thread's images and default them all to "included".
        if (res.thread) {
          const att = await listThreadAttachments(res.thread.id).catch(() => ({ attachments: [] }));
          if (!active) return;
          setImages(att.attachments);
          setChoices(Object.fromEntries(att.attachments.map((a) => [a.id, { included: true }])));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load draft'));
    return () => {
      active = false;
    };
  }, [id]);

  function imagePayload(): PublishImageInput[] {
    return images
      .filter((a) => choices[a.id]?.included)
      .map((a) => ({ sourceAttachmentId: a.id, editedDataUrl: choices[a.id]?.editedDataUrl ?? null }));
  }

  // Open the editor with a data URL (avoids tainted-canvas on cross-origin images).
  async function openEditor(att: ThreadAttachment) {
    const existing = choices[att.id]?.editedDataUrl;
    if (existing) {
      setEditing({ id: att.id, source: existing });
      return;
    }
    if (!att.url) return;
    try {
      const blob = await (await fetch(att.url)).blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      setEditing({ id: att.id, source: dataUrl });
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

            {images.length > 0 && (
              <div className="border-t border-gray-100 pt-4">
                <h3 className="mb-2 text-sm font-medium text-gray-700">
                  Images ({images.filter((a) => choices[a.id]?.included).length}/{images.length} included)
                </h3>
                <p className="mb-2 text-xs text-gray-400">Uncheck to leave an image off the published article, or edit to crop/annotate it.</p>
                <div className="flex flex-wrap gap-3">
                  {images.map((a) => {
                    const ch = choices[a.id];
                    const preview = ch?.editedDataUrl ?? a.url ?? '';
                    return (
                      <div key={a.id} className="w-28">
                        <div className={`relative rounded border ${ch?.included ? 'border-emerald-400' : 'border-gray-200 opacity-50'}`}>
                          {preview && <img src={preview} alt={a.filename ?? ''} className="h-24 w-full rounded object-cover" />}
                          {ch?.editedDataUrl && (
                            <span className="absolute left-1 top-1 rounded bg-blue-600 px-1 text-[10px] text-white">edited</span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center justify-between text-xs">
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={Boolean(ch?.included)}
                              onChange={(e) =>
                                setChoices((s) => ({ ...s, [a.id]: { ...s[a.id], included: e.target.checked } }))
                              }
                            />
                            include
                          </label>
                          <button type="button" onClick={() => void openEditor(a)} className="text-blue-700 hover:underline">
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
              setChoices((s) => ({ ...s, [editing.id]: { included: true, editedDataUrl: dataUrl } }));
              setEditing(null);
            }}
          />
        </Suspense>
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
