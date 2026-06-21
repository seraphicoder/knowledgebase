-- Migration 014 — 'member' (regular user) role.
--
-- Adds a regular-user role and makes it the default for new users. For now every
-- role except 'admin' is treated the same (full content access) in the API; the
-- gates are centralized so differentiating later is a small change. 'viewer'
-- remains available as a read-only role for when that distinction is wanted.

alter table users drop constraint users_role_check;
alter table users add constraint users_role_check
  check (role in ('admin', 'reviewer', 'sme', 'member', 'viewer'));
alter table users alter column role set default 'member';
