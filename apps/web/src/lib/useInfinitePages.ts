import { useCallback, useEffect, useRef, useState } from 'react';

// Reusable infinite-scroll pager. Fetches pages of `pageSize` via `loadPage`,
// appending to `items`, and loads the next page when the returned `sentinelRef`
// element scrolls into view. Resets when `depsKey` changes (e.g. server-side
// filters). Client-side sort/search should run over the returned `items`.
export function useInfinitePages<T>(
  loadPage: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  depsKey: string,
  pageSize = 50,
) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  const offsetRef = useRef(0);
  const doneRef = useRef(false);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const { items: page, total: t } = await loadPageRef.current(offsetRef.current, pageSize);
      setItems((prev) => [...prev, ...page]);
      setTotal(t);
      offsetRef.current += page.length;
      if (page.length < pageSize || offsetRef.current >= t) {
        doneRef.current = true;
        setDone(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [pageSize]);

  const reload = useCallback(() => {
    offsetRef.current = 0;
    doneRef.current = false;
    setDone(false);
    setItems([]);
    setTotal(0);
    void loadMore();
  }, [loadMore]);

  // Reset + first page whenever the filter key changes.
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  // Load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore]);

  return { items, total, loading, error, done, hasMore: !done, reload, sentinelRef, setItems };
}
