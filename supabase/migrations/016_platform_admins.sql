-- Migration 016 — Multi-tenant onboarding: vendor super-admins + org suspension.
--
-- Orgs are vendor-provisioned: a platform_admin creates each organization and its
-- first admin. platform_admins is org-independent (a vendor account need not belong
-- to any org). Only the service-role backend reads/writes it, so RLS is enabled
-- with no policies (locked to anon/auth clients; service role bypasses RLS).

create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table platform_admins enable row level security;

-- Suspending an org blocks all of its users at the auth layer (see requireAuth).
alter table organizations
  add column if not exists suspended boolean not null default false;
