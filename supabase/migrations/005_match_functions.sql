-- Migration 005 — Vector similarity RPCs.
--
-- pgvector's <=> is cosine DISTANCE (0 = identical). Similarity = 1 - distance.
-- These are SECURITY INVOKER (default): when called with the anon/auth key, RLS
-- on the underlying tables still applies. The backend calls them via the service
-- role and passes p_org_id explicitly, which we also filter on for safety.

-- Nearest existing extractions to a query embedding (dedup / merge suggestions).
create or replace function public.match_extractions(
  p_org_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 5
)
returns table (id uuid, title text, confidence float, similarity float)
language sql
stable
as $$
  select e.id,
         e.title,
         e.confidence,
         1 - (e.embedding <=> p_query_embedding) as similarity
  from public.extractions e
  where e.org_id = p_org_id
    and e.status <> 'rejected'
    and e.embedding is not null
  order by e.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- Nearest published KB articles to a query embedding (semantic KB search / RAG).
create or replace function public.match_kb_articles(
  p_org_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 5
)
returns table (id uuid, title text, body text, similarity float)
language sql
stable
as $$
  select a.id,
         a.title,
         a.body,
         1 - (a.embedding <=> p_query_embedding) as similarity
  from public.kb_articles a
  where a.org_id = p_org_id
    and a.embedding is not null
  order by a.embedding <=> p_query_embedding
  limit p_match_count;
$$;
