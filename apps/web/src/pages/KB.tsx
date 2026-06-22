import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { useInfinitePages } from '../lib/useInfinitePages';

// Heavy canvas editor — lazy-loaded so it stays out of the main bundle.
const ImageEditorModal = lazy(() => import('../components/ImageEditorModal'));
import {
  listKb,
  getKbArticle,
  searchKb,
  unpublishArticle,
  listComments,
  addComment,
  flagArticle,
  unflagArticle,
  createArticle,
  deleteArticle,
  getMe,
  type KbArticleSummary,
  type KbArticleDetail,
  type KbSearchResult,
  type ArticleComment,
  type NewArticleInput,
} from '../lib/api';

const AUTHOR_ROLES = new Set(['admin', 'reviewer', 'sme', 'member']);
import { supabase } from '../lib/supabase';
import { ArticleImages } from '../components/ThreadImages';

// Milestone 4 — Knowledge Base. Staff search published articles in plain language
// (semantic via pgvector, keyword fallback) and read them. Articles are published
// here when a reviewer approves a draft.
export function KB() {
  const { items: articles, total, loading, error: loadError, sentinelRef, reload } = useInfinitePages<KbArticleSummary>(
    (offset, limit) => listKb({ offset, limit }).then((r) => ({ items: r.articles, total: r.total })),
    'kb',
  );
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<{ mode: string; results: KbSearchResult[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [canAuthor, setCanAuthor] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    void getMe()
      .then((me) => {
        setCanAuthor(!!me.role && AUTHOR_ROLES.has(me.role));
        setIsAdmin(me.role === 'admin');
      })
      .catch(() => {});
  }, []);

  // Deep-link: /kb?article=<id> opens that article (e.g. from a Review warning).
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const a = searchParams.get('article');
    if (a) setOpenId(a);
  }, [searchParams]);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      setResults(await searchKb(query.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setQuery('');
    setResults(null);
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <nav className="mb-2 flex gap-4 text-sm">
            <Link to="/staging" className="text-gray-500 hover:underline">Staging</Link>
            <Link to="/queued" className="text-gray-500 hover:underline">Queued</Link>
            <Link to="/review" className="text-gray-500 hover:underline">Review</Link>
            <span className="font-medium text-gray-900">Knowledge Base</span>
            <Link to="/replies" className="text-gray-500 hover:underline">Reply Agent</Link>
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
            <Link to="/users" className="text-gray-500 hover:underline">Users</Link>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Knowledge Base</h1>
          <p className="text-sm text-gray-500">Search published answers in plain language.</p>
        </div>
        <div className="flex items-center gap-2">
          {canAuthor && (
            <button
              onClick={() => setShowNew(true)}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              New Article
            </button>
          )}
          <button
            onClick={() => void supabase.auth.signOut()}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Sign out
          </button>
        </div>
      </header>

      <form onSubmit={onSearch} className="mb-4 flex gap-2">
        <input
          type="search"
          placeholder="Ask a question, e.g. how do I fix banding?"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={searching} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          {searching ? 'Searching…' : 'Search'}
        </button>
        {results && (
          <button type="button" onClick={clearSearch} className="rounded border border-gray-300 px-3 py-2 text-sm">
            Clear
          </button>
        )}
      </form>

      {(error ?? loadError) && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error ?? loadError}</div>
      )}

      {results ? (
        <div>
          <p className="mb-2 text-xs text-gray-500">
            {results.results.length} result{results.results.length === 1 ? '' : 's'} ({results.mode} search)
          </p>
          {results.results.length === 0 ? (
            <p className="text-sm text-gray-400">No matching articles.</p>
          ) : (
            <ul className="space-y-2">
              {results.results.map((r) => (
                <li key={r.id} className="rounded border border-gray-200 p-3 hover:bg-gray-50">
                  <button onClick={() => setOpenId(r.id)} className="text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-blue-700">{r.title}</span>
                      {r.similarity != null && (
                        <span className="text-xs text-gray-400">{Math.round(r.similarity * 100)}% match</span>
                      )}
                      {r.needs_update && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">⚠ needs update</span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-gray-600">{snippet(r.body)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div>
          <h2 className="mb-2 text-sm font-medium text-gray-700">All articles ({total})</h2>
          <div className="overflow-hidden rounded border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Tags</th>
                  <th className="px-3 py-2">Published</th>
                </tr>
              </thead>
              <tbody>
                {loading && articles.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
                ) : articles.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">No published articles yet. Approve drafts in Review to publish them here.</td></tr>
                ) : (
                  articles.map((a) => (
                    <tr key={a.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <button onClick={() => setOpenId(a.id)} className="text-left font-medium text-blue-700 hover:underline">{a.title}</button>
                        {a.needs_update && (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800" title="Flagged: needs update">⚠ needs update</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{a.category || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{a.tags.slice(0, 3).join(', ')}</td>
                      <td className="px-3 py-2 text-gray-600">{fmtDate(a.published_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div ref={sentinelRef} className="h-8" />
          {loading && articles.length > 0 && <p className="py-2 text-center text-xs text-gray-400">Loading more…</p>}
        </div>
      )}

      {openId && (
        <ArticleDrawer
          id={openId}
          isAdmin={isAdmin}
          onClose={() => setOpenId(null)}
          onDeleted={() => { setOpenId(null); reload(); }}
        />
      )}
      {showNew && (
        <NewArticleDrawer
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); reload(); }}
        />
      )}
    </div>
  );
}

function ArticleDrawer({ id, isAdmin, onClose, onDeleted }: { id: string; isAdmin: boolean; onClose: () => void; onDeleted: () => void }) {
  const [article, setArticle] = useState<KbArticleDetail | null>(null);
  const [source, setSource] = useState<{ id: string; subject: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comments, setComments] = useState<ArticleComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const navigate = useNavigate();

  const reloadArticle = useCallback(async () => {
    const res = await getKbArticle(id);
    setArticle(res.article);
    setSource(res.source);
  }, [id]);

  const reloadComments = useCallback(async () => {
    setComments((await listComments(id)).comments);
  }, [id]);

  useEffect(() => {
    void reloadComments().catch(() => setComments([]));
  }, [reloadComments]);

  async function onPostComment() {
    if (!newComment.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addComment(id, newComment.trim());
      setNewComment('');
      await reloadComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add comment');
    } finally {
      setBusy(false);
    }
  }

  async function onFlag() {
    const reason = prompt('Why does this article need updating? (optional)') ?? undefined;
    setBusy(true);
    setError(null);
    try {
      await flagArticle(id, reason);
      await reloadArticle();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to flag article');
    } finally {
      setBusy(false);
    }
  }

  async function onUnflag() {
    setBusy(true);
    setError(null);
    try {
      await unflagArticle(id);
      await reloadArticle();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear flag');
    } finally {
      setBusy(false);
    }
  }

  async function onEdit() {
    if (!article) return;
    if (!confirm('Move this article back to draft for editing? It will leave the Knowledge Base until you re-publish it in Review.')) return;
    setBusy(true);
    setError(null);
    try {
      await unpublishArticle(article.id);
      navigate('/review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to move article to draft');
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!article) return;
    if (!confirm('Permanently delete this article? This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteArticle(article.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete article');
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    getKbArticle(id)
      .then((res) => {
        if (!active) return;
        setArticle(res.article);
        setSource(res.source);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load article'));
    return () => {
      active = false;
    };
  }, [id]);

  function download() {
    if (!article) return;
    const md = `# ${article.title}\n\n${article.body}\n`;
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${article.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-10 flex justify-end bg-black/20" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{article?.title ?? 'Loading…'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {article && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              {article.category && <span className="rounded bg-gray-100 px-2 py-0.5">{article.category}</span>}
              {article.tags.map((t) => <span key={t} className="rounded bg-gray-100 px-2 py-0.5">{t}</span>)}
              {article.needs_update ? (
                <button onClick={onUnflag} disabled={busy} className="ml-auto rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-800 hover:bg-amber-100 disabled:opacity-40">
                  Clear flag
                </button>
              ) : (
                <button onClick={onFlag} disabled={busy} className="ml-auto rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40">
                  Flag for update
                </button>
              )}
              <button onClick={onEdit} disabled={busy} className="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40">
                {busy ? '…' : 'Edit'}
              </button>
              <button onClick={download} className="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50">Download .md</button>
              {isAdmin && (
                <button onClick={() => void onDelete()} disabled={busy} className="rounded border border-red-300 bg-red-50 px-2 py-0.5 text-red-700 hover:bg-red-100 disabled:opacity-40">
                  Delete
                </button>
              )}
            </div>

            {article.needs_update && (
              <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                ⚠ Flagged as needing an update{article.flag_reason ? `: ${article.flag_reason}` : ''}.
              </div>
            )}
            <Markdown body={article.body} />
            <ArticleImages articleId={article.id} />
            {source && (
              <p className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500">
                Source thread: <span className="font-medium text-gray-700">{source.subject || '(no subject)'}</span>
              </p>
            )}

            {/* Comments */}
            <div className="mt-4 border-t border-gray-100 pt-3">
              <h3 className="mb-2 text-sm font-medium text-gray-700">Comments ({comments.length})</h3>
              <div className="space-y-2">
                {comments.map((cm) => (
                  <div key={cm.id} className="rounded bg-gray-50 px-3 py-2 text-sm">
                    <p className="text-gray-800">{cm.body}</p>
                    <p className="mt-1 text-xs text-gray-400">{cm.author} · {new Date(cm.created_at).toLocaleString()}</p>
                  </div>
                ))}
                {comments.length === 0 && <p className="text-xs text-gray-400">No comments yet.</p>}
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                  placeholder="Add a comment…"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void onPostComment()}
                />
                <button onClick={() => void onPostComment()} disabled={busy || !newComment.trim()} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
                  Post
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Author a new article from scratch — same fields as the review form, plus
// directly-uploaded photos. Published immediately on submit.
function NewArticleDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [caveats, setCaveats] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [photos, setPhotos] = useState<string[]>([]); // data URLs
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAddFiles(files: FileList | null) {
    if (!files) return;
    const reads = await Promise.all(
      Array.from(files)
        .filter((f) => f.type.startsWith('image/'))
        .map(
          (f) =>
            new Promise<string>((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result));
              r.onerror = () => reject(r.error);
              r.readAsDataURL(f);
            }),
        ),
    );
    setPhotos((p) => [...p, ...reads]);
  }

  async function onSubmit() {
    if (!title.trim() || !question.trim() || !answer.trim()) {
      setError('Title, question, and answer are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: NewArticleInput = {
        title: title.trim(),
        question: question.trim(),
        answer: answer.trim(),
        caveats: caveats.trim() || undefined,
        category: category.trim() || undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        images: photos.map((dataUrl) => ({ dataUrl })),
      };
      await createArticle(input);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create article');
      setBusy(false);
    }
  }

  const field = 'w-full rounded border border-gray-300 px-2 py-1.5 text-sm';
  return (
    <>
    <div className="fixed inset-0 z-10 flex justify-end bg-black/20" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">New article</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        {error && <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <label className="mb-3 block text-sm">
          <span className="mb-1 block font-medium text-gray-600">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block font-medium text-gray-600">Question</span>
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} className={field} />
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block font-medium text-gray-600">Answer</span>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={8} className={field} />
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block font-medium text-gray-600">Caveats (optional)</span>
          <textarea value={caveats} onChange={(e) => setCaveats(e.target.value)} rows={2} className={field} />
        </label>
        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-600">Category</span>
            <input value={category} onChange={(e) => setCategory(e.target.value)} className={field} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-600">Tags (comma-separated)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} className={field} />
          </label>
        </div>

        {/* Photos */}
        <div className="mb-4">
          <span className="mb-1 block text-sm font-medium text-gray-600">Photos</span>
          <input type="file" accept="image/*" multiple onChange={(e) => void onAddFiles(e.target.files)} className="text-sm" />
          {photos.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-3">
              {photos.map((src, i) => (
                <div key={i} className="w-24">
                  <img src={src} alt="" className="h-20 w-full rounded border border-gray-200 object-cover" />
                  <div className="mt-1 flex gap-1">
                    <button
                      onClick={() => setEditingIndex(i)}
                      className="flex-1 rounded border border-gray-300 px-1 py-0.5 text-xs text-blue-700 hover:bg-gray-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                      className="flex-1 rounded border border-gray-300 px-1 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button onClick={() => void onSubmit()} disabled={busy} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
            {busy ? 'Publishing…' : 'Publish article'}
          </button>
          <button onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm">Cancel</button>
        </div>
      </div>
    </div>

      {/* Editor sits outside the backdrop so clicks inside it don't close the drawer. */}
      {editingIndex != null && photos[editingIndex] && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 text-sm text-white">Loading editor…</div>
          }
        >
          <ImageEditorModal
            source={photos[editingIndex]}
            onClose={() => setEditingIndex(null)}
            onSave={(dataUrl) => {
              setPhotos((p) => p.map((x, j) => (j === editingIndex ? dataUrl : x)));
              setEditingIndex(null);
            }}
          />
        </Suspense>
      )}
    </>
  );
}

// Render the article markdown (headings, lists, blockquotes, bold, code, links).
// Styled via a components map since the Tailwind typography plugin isn't installed.
function Markdown({ body }: { body: string }) {
  return (
    <div className="text-sm text-gray-800">
      <ReactMarkdown
        components={{
          h1: ({ children }) => <h1 className="mb-1 mt-4 text-lg font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-1 mt-4 text-base font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold">{children}</h3>,
          p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-gray-300 pl-3 italic text-gray-600">{children}</blockquote>
          ),
          code: ({ children }) => <code className="rounded bg-gray-100 px-1 text-xs">{children}</code>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 underline">{children}</a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function snippet(body: string): string {
  // Strip common markdown markers for a clean text preview.
  return body.replace(/[#>*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}
