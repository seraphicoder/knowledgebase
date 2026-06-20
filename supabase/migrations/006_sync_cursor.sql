-- Migration 006 — Resumable backfill cursor on ingestion_sources.
--
-- Connectors pull newest-first and walk backwards in time, in batches. The
-- cursor is an OPAQUE, connector-defined resume token (Zendesk: list-endpoint
-- after_cursor; IMAP: lowest UID ingested so far). NULL cursor = start from the
-- newest record. backfill_complete flips true when a connector reports no more
-- history to pull.

alter table ingestion_sources add column sync_cursor text;
alter table ingestion_sources add column backfill_complete boolean not null default false;
