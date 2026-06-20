-- Migration 003 — Row Level Security.
--
-- Every table is tenant-isolated by org_id, enforced at the DB layer.
-- The Node backend connects with the service role key, which BYPASSES RLS by
-- design — these policies protect against any client (anon/authed) connection,
-- e.g. the frontend talking to Supabase directly with the anon key.

-- ─── Helper functions ───────────────────────────────────────
-- SECURITY DEFINER so they can read `users` without tripping RLS on `users`
-- itself (a policy on `users` that selects from `users` would recurse forever).
-- search_path is pinned to prevent search-path hijacking on a definer function.

create or replace function public.current_user_org()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select org_id from public.users where id = auth.uid();
$$;

create or replace function public.current_user_role()
  returns text
  language sql
  stable
  security definer
  set search_path = public
as $$
  select role from public.users where id = auth.uid();
$$;

-- ─── Generic org-isolation pattern ──────────────────────────
-- Applied per table below. Note the per-operation clauses:
--   SELECT/DELETE -> USING
--   INSERT        -> WITH CHECK
--   UPDATE        -> USING (row visible) + WITH CHECK (new row stays in org)
-- A single FOR ALL policy with only USING would silently allow inserting rows
-- into another org, so we are explicit.

-- organizations: a user sees only their own org row.
alter table organizations enable row level security;
create policy org_select on organizations for select
  using (id = current_user_org());
create policy org_update on organizations for update
  using (id = current_user_org() and current_user_role() = 'admin')
  with check (id = current_user_org());

-- users: members see co-members in their org; admins manage them.
alter table users enable row level security;
create policy users_select on users for select
  using (org_id = current_user_org());
create policy users_insert on users for insert
  with check (org_id = current_user_org() and current_user_role() = 'admin');
create policy users_update on users for update
  using (org_id = current_user_org() and current_user_role() = 'admin')
  with check (org_id = current_user_org());
create policy users_delete on users for delete
  using (org_id = current_user_org() and current_user_role() = 'admin');

-- Reusable org-isolation policy set for standard data tables.
do $$
declare
  t text;
  data_tables text[] := array[
    'ingestion_sources',
    'email_threads',
    'extractions',
    'kb_articles',
    'ticket_suggestions',
    'sme_reviews',
    'verified_pairs'
  ];
begin
  foreach t in array data_tables loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy %I on %I for select using (org_id = current_user_org());',
      t || '_select', t);
    execute format(
      'create policy %I on %I for insert with check (org_id = current_user_org());',
      t || '_insert', t);
    execute format(
      'create policy %I on %I for update using (org_id = current_user_org()) with check (org_id = current_user_org());',
      t || '_update', t);
    execute format(
      'create policy %I on %I for delete using (org_id = current_user_org());',
      t || '_delete', t);
  end loop;
end $$;

-- ─── audit_log: append-only, admin-readable ─────────────────
-- INSERT allowed within the caller's org. SELECT allowed to admins only.
-- Deliberately NO update or delete policy: with RLS enabled and no permissive
-- policy for those commands, all UPDATE/DELETE from non-superuser roles are
-- denied — the log is immutable. (System writes go through the service role.)
alter table audit_log enable row level security;
create policy audit_insert on audit_log for insert
  with check (org_id = current_user_org());
create policy audit_admin_select on audit_log for select
  using (org_id = current_user_org() and current_user_role() = 'admin');
