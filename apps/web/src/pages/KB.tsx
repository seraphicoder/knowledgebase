import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  listKb,
  getKbArticle,
  searchKb,
  unpublishArticle,
  type KbArticleSummary,
  type KbArticleDetail,
  type KbSearchResult,
} from '../lib/api';
import { supabase } from '../lib/supabase';
import { ArticleImages } from '../components/ThreadImages';

// Milestone 4 — Knowledge Base. Staff search published articles in plain language
// (semantic via pgvector, keyword fallback) and read them. Articles are published
// here when a reviewer approves a draft.
export function KB() {
  const [articles, setArticles] = useState<KbArticleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<{ mode: string; results: KbSearchResult[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listKb();
      setArticles(res.articles);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load articles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
            <Link to="/approved" className="text-gray-500 hover:underline">Approved</Link>
            <Link to="/review" className="text-gray-500 hover:underline">Review</Link>
            <span className="font-medium text-gray-900">Knowledge Base</span>
            <Link to="/replies" className="text-gray-500 hover:underline">Reply Agent</Link>
            <Link to="/facts" className="text-gray-500 hover:underline">Domain Facts</Link>
          </nav>
          <h1 className="text-2xl font-semibold text-gray-900">Knowledge Base</h1>
          <p className="text-sm text-gray-500">Search published answers in plain language.</p>
        </div>
        <button
          onClick={() => void supabase.auth.signOut()}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
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

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
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
          <h2 className="mb-2 text-sm font-medium text-gray-700">All articles ({articles.length})</h2>
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
                {loading ? (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
                ) : articles.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">No published articles yet. Approve drafts in Review to publish them here.</td></tr>
                ) : (
                  articles.map((a) => (
                    <tr key={a.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <button onClick={() => setOpenId(a.id)} className="text-left font-medium text-blue-700 hover:underline">{a.title}</button>
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
        </div>
      )}

      {openId && <ArticleDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function ArticleDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [article, setArticle] = useState<KbArticleDetail | null>(null);
  const [source, setSource] = useState<{ id: string; subject: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

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
              <button onClick={onEdit} disabled={busy} className="ml-auto rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40">
                {busy ? 'Moving…' : 'Edit'}
              </button>
              <button onClick={download} className="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50">Download .md</button>
            </div>
            <Markdown body={article.body} />
            <ArticleImages articleId={article.id} />
            {source && (
              <p className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500">
                Source thread: <span className="font-medium text-gray-700">{source.subject || '(no subject)'}</span>
              </p>
            )}
          </>
        )}
      </div>
    </div>
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
