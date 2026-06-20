-- Migration 007 — Domain facts / grounding rules.
--
-- Org-authored facts injected into the extraction prompt so the LLM treats the
-- customer's truth as ground truth instead of guessing (e.g. "Model XYZ is a
-- roll-to-roll UV printer, NOT a flatbed").
--   term IS NULL  -> global rule, always injected
--   term present  -> injected only when the term appears in the thread content

create table domain_facts (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null references organizations(id) on delete cascade,
  term       text,                       -- null = global rule
  fact       text not null,
  active     boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on domain_facts (org_id, active);

-- RLS — same org-isolation pattern as the other data tables (see 003_rls.sql).
alter table domain_facts enable row level security;
create policy domain_facts_select on domain_facts for select
  using (org_id = current_user_org());
create policy domain_facts_insert on domain_facts for insert
  with check (org_id = current_user_org());
create policy domain_facts_update on domain_facts for update
  using (org_id = current_user_org())
  with check (org_id = current_user_org());
create policy domain_facts_delete on domain_facts for delete
  using (org_id = current_user_org());
