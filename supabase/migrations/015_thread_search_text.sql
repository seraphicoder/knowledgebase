-- Migration 015 — Server-side search for thread lists (Staging / Queued).
-- Adds a generated `search_text` column over the fields users actually search
-- (subject + participant emails) and a trigram index so substring `ilike`
-- queries stay fast across the whole dataset, not just the rows already loaded
-- into the infinite-scroll list. Sorting is handled in the route via ORDER BY.

create extension if not exists pg_trgm;

-- `participants` is jsonb (e.g. ["a@x.com","b@y.com"]); cast to text so the raw
-- JSON (emails included) is substring-searchable. Brackets/quotes in the text are
-- harmless for `ilike` matching.
alter table email_threads
  add column if not exists search_text text
  generated always as (
    coalesce(subject, '') || ' ' || coalesce(participants::text, '')
  ) stored;

create index if not exists idx_email_threads_search_trgm
  on email_threads using gin (search_text gin_trgm_ops);
