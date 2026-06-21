-- Migration 012 — 'merged' extraction status.
--
-- When a draft is merged into an existing article (instead of published as its
-- own), it's marked 'merged' so it leaves the review queue with accurate history.

alter table extractions drop constraint extractions_status_check;
alter table extractions add constraint extractions_status_check
  check (status in ('pending_review', 'approved', 'rejected', 'published', 'merged'));
