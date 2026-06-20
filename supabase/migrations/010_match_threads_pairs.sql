-- Migration 010 — Match RPCs for the reply agent (Milestone 5).
--
-- Cosine similarity (1 - distance), org-scoped. Same SECURITY INVOKER posture as
-- migration 005. Used to retrieve context for a suggested ticket reply.

-- Similar past (processed) threads — examples of how similar issues were handled.
-- p_exclude lets the caller drop the incoming ticket's own thread.
create or replace function public.match_email_threads(
  p_org_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 5,
  p_exclude uuid default null
)
returns table (id uuid, subject text, raw_content text, similarity float)
language sql
stable
as $$
  select t.id,
         t.subject,
         t.raw_content,
         1 - (t.embedding <=> p_query_embedding) as similarity
  from public.email_threads t
  where t.org_id = p_org_id
    and t.embedding is not null
    and (p_exclude is null or t.id <> p_exclude)
  order by t.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- SME-verified Q&A pairs — ground truth, retrieved as priority context.
create or replace function public.match_verified_pairs(
  p_org_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 3
)
returns table (id uuid, question text, answer text, accuracy_score int, similarity float)
language sql
stable
as $$
  select v.id,
         v.question,
         v.answer,
         v.accuracy_score,
         1 - (v.embedding <=> p_query_embedding) as similarity
  from public.verified_pairs v
  where v.org_id = p_org_id
    and v.embedding is not null
  order by v.embedding <=> p_query_embedding
  limit p_match_count;
$$;
