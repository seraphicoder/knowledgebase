-- Migration 008 — Image attachments.
--
-- Captures images from tickets/emails. The bytes live in a PRIVATE Supabase
-- Storage bucket; this table holds the metadata + storage path. The backend
-- (service role) uploads and hands the UI short-lived signed URLs, so access
-- stays org-scoped. Rows cascade-delete with their thread.

create table attachments (
  id           uuid primary key default uuid_generate_v4(),
  org_id       uuid not null references organizations(id) on delete cascade,
  thread_id    uuid not null references email_threads(id) on delete cascade,
  filename     text,
  content_type text,
  size         int,
  storage_path text not null,
  inline       boolean not null default false,
  created_at   timestamptz not null default now()
);

create index on attachments (org_id, thread_id);

-- RLS — same org-isolation pattern as the other data tables (see 003_rls.sql).
alter table attachments enable row level security;
create policy attachments_select on attachments for select
  using (org_id = current_user_org());
create policy attachments_insert on attachments for insert
  with check (org_id = current_user_org());
create policy attachments_update on attachments for update
  using (org_id = current_user_org())
  with check (org_id = current_user_org());
create policy attachments_delete on attachments for delete
  using (org_id = current_user_org());

-- Private storage bucket for the image bytes. Private = no public URLs; the
-- backend serves signed URLs. (Bucket cleanup on thread delete is handled in
-- app code / a later sweep — deleting a row here does not remove the object.)
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;
