-- Migration 009 — Per-article curated images.
--
-- A KB article carries its OWN set of images, chosen at review time — not just
-- "all of the source thread's images". This matters because one thread can yield
-- several drafts (multi-Q&A), each wanting a different image selection. An entry
-- points either at a source attachment's bytes (storage_path copied) or at a new
-- edited/cropped/annotated version uploaded to the same bucket.

create table kb_article_images (
  id                   uuid primary key default uuid_generate_v4(),
  org_id               uuid not null references organizations(id) on delete cascade,
  kb_article_id        uuid not null references kb_articles(id) on delete cascade,
  source_attachment_id uuid references attachments(id) on delete set null,
  storage_path         text not null,          -- original or edited object, in the 'attachments' bucket
  content_type         text,
  edited               boolean not null default false,
  position             int not null default 0, -- display order
  created_at           timestamptz not null default now()
);

create index on kb_article_images (org_id, kb_article_id);

-- RLS — same org-isolation pattern as the other data tables (see 003_rls.sql).
alter table kb_article_images enable row level security;
create policy kb_article_images_select on kb_article_images for select
  using (org_id = current_user_org());
create policy kb_article_images_insert on kb_article_images for insert
  with check (org_id = current_user_org());
create policy kb_article_images_update on kb_article_images for update
  using (org_id = current_user_org())
  with check (org_id = current_user_org());
create policy kb_article_images_delete on kb_article_images for delete
  using (org_id = current_user_org());
