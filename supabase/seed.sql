-- Seed data for local development.
-- Creates one org and one ingestion source so the ingest script + staging UI
-- have something to attach threads to. Users are created via Supabase Auth
-- (auth.users) and linked in `public.users` separately.

insert into organizations (id, name, plan)
values ('00000000-0000-0000-0000-000000000001', 'Acme Support', 'pro')
on conflict (id) do nothing;

insert into ingestion_sources (id, org_id, type, label)
values
  ('00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-000000000001',
   'imap', 'Support Intake Mailbox'),
  ('00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-000000000001',
   'zendesk', 'Zendesk Tickets')
on conflict (id) do nothing;
