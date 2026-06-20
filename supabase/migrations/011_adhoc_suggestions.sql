-- Migration 011 — Ad-hoc reply suggestions.
--
-- The reply agent should also work on a ticket pasted in directly (one that
-- just came in and isn't an ingested thread). So source_thread_id becomes
-- optional, and we store the ticket text on the suggestion itself (also handy
-- for thread-based ones, so the suggestion is self-contained for review).

alter table ticket_suggestions alter column source_thread_id drop not null;
alter table ticket_suggestions add column ticket_text text;
