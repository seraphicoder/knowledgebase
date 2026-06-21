-- Migration 017 — AI token usage tracking + analytics aggregation helpers.
--
-- Every model call records token counts here (no dollar conversion — raw tokens).
-- org_id is nullable so an unattributed call still lands (counts toward platform
-- totals). Only the service-role backend writes/reads, so RLS is on with no policy.

create table if not exists ai_usage (
  id            uuid primary key default uuid_generate_v4(),
  org_id        uuid references organizations(id) on delete cascade,
  provider      text not null,             -- 'anthropic' | 'openai'
  model         text not null,
  operation     text,                      -- 'relevance'|'extraction'|'merge'|'reply'|'embedding'|'search'
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  created_at    timestamptz not null default now()
);

alter table ai_usage enable row level security;

create index if not exists idx_ai_usage_org_created on ai_usage (org_id, created_at);
create index if not exists idx_ai_usage_created on ai_usage (created_at);

-- ─── Aggregation helpers for the vendor analytics console ────
-- SECURITY DEFINER + locked search_path; only ever invoked by the service role.

create or replace function ai_usage_summary(p_since timestamptz default '-infinity')
returns table (org_id uuid, provider text, model text, input_tokens bigint, output_tokens bigint, calls bigint)
language sql stable security definer set search_path = public as $$
  select org_id, provider, model,
         sum(input_tokens)::bigint, sum(output_tokens)::bigint, count(*)::bigint
  from ai_usage
  where created_at >= p_since
  group by org_id, provider, model
$$;

create or replace function storage_by_org()
returns table (org_id uuid, bytes bigint, files bigint)
language sql stable security definer set search_path = public as $$
  select org_id, coalesce(sum(size), 0)::bigint, count(*)::bigint
  from attachments
  group by org_id
$$;

create or replace function ingestion_by_org(p_since timestamptz default '-infinity')
returns table (org_id uuid, threads bigint, messages bigint)
language sql stable security definer set search_path = public as $$
  select org_id, count(*)::bigint, coalesce(sum(message_count), 0)::bigint
  from email_threads
  where ingested_at >= p_since
  group by org_id
$$;
