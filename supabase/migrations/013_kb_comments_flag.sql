-- Migration 013 — KB article comments + "needs update" flag.
--
-- Users can discuss an article (comments) and flag it for revision. The flag
-- lives on the article so it can be shown in the list and cleared by a manager
-- (or when the article is next merged/edited).

alter table kb_articles add column needs_update boolean not null default false;
alter table kb_articles add column flag_reason text;
alter table kb_articles add column flagged_by uuid references users(id);
alter table kb_articles add column flagged_at timestamptz;

create table kb_article_comments (
  id            uuid primary key default uuid_generate_v4(),
  org_id        uuid not null references organizations(id) on delete cascade,
  kb_article_id uuid not null references kb_articles(id) on delete cascade,
  user_id       uuid references users(id),
  body          text not null,
  created_at    timestamptz not null default now()
);

create index on kb_article_comments (org_id, kb_article_id);

-- RLS — same org-isolation pattern as the other data tables (see 003_rls.sql).
alter table kb_article_comments enable row level security;
create policy kb_article_comments_select on kb_article_comments for select
  using (org_id = current_user_org());
create policy kb_article_comments_insert on kb_article_comments for insert
  with check (org_id = current_user_org());
create policy kb_article_comments_update on kb_article_comments for update
  using (org_id = current_user_org())
  with check (org_id = current_user_org());
create policy kb_article_comments_delete on kb_article_comments for delete
  using (org_id = current_user_org());
