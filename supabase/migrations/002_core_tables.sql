-- Migration 002 — Core tables (Phase 1).
--
-- Embedding columns are vector(1536) to match OpenAI text-embedding-3-small.
-- NOTE: switching embedding providers later (e.g. voyage-3, different dims) is a
-- deliberate decision that requires an ALTER on every embedding column AND
-- re-embedding all stored content. Do not change this in passing.

-- ─── Organizations ──────────────────────────────────────────
create table organizations (
  id                         uuid primary key default uuid_generate_v4(),
  name                       text not null,
  plan                       text not null default 'starter'
                               check (plan in ('starter', 'pro', 'enterprise')),
  data_retention_days        int,          -- null = indefinite
  soc2_direct_access_enabled boolean not null default false,
  created_at                 timestamptz not null default now()
);

-- ─── Users (extends Supabase auth.users) ────────────────────
create table users (
  id         uuid primary key references auth.users(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  email      text not null,
  role       text not null default 'viewer'
               check (role in ('admin', 'reviewer', 'sme', 'viewer')),
  created_at timestamptz not null default now()
);

-- ─── Ingestion sources ──────────────────────────────────────
create table ingestion_sources (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references organizations(id) on delete cascade,
  type           text not null
                   check (type in ('imap', 'zendesk', 'graph_api', 'pst_upload', 'mbox_upload', 'eml_upload')),
  label          text not null,
  config         jsonb not null default '{}',  -- encrypted credentials stored here
  last_synced_at timestamptz,
  status         text not null default 'active'
                   check (status in ('active', 'paused', 'error')),
  created_at     timestamptz not null default now()
);

-- ─── Email threads (conversations from ANY connector) ───────
create table email_threads (
  id                 uuid primary key default uuid_generate_v4(),
  org_id             uuid not null references organizations(id) on delete cascade,
  source_id          uuid not null references ingestion_sources(id) on delete cascade,
  external_thread_id text not null,
  subject            text,
  participants       jsonb not null default '[]',
  message_count      int not null default 1,
  raw_content        text,                      -- purged after retention window
  date_range_start   timestamptz,
  date_range_end     timestamptz,
  approval_status    text not null default 'staged'
                       check (approval_status in ('staged', 'approved', 'excluded')),
  approved_by        uuid references users(id),
  approved_at        timestamptz,
  processing_status  text not null default 'not_started'
                       check (processing_status in
                         ('not_started', 'pending', 'processing', 'extracted', 'skipped', 'error')),
  relevance_score    float,                     -- 0.0–1.0 from Haiku filter
  embedding          vector(1536),              -- stays null until approved + embedded
  metadata           jsonb not null default '{}',
  ingested_at        timestamptz not null default now(),
  unique (org_id, source_id, external_thread_id)
);
-- IMPORTANT: rows are inserted with approval_status = 'staged' and
-- processing_status = 'not_started'. No pipeline stage may touch a row where
-- approval_status != 'approved'. This is the staging/approval gate.

-- ─── Extractions ────────────────────────────────────────────
create table extractions (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null references organizations(id) on delete cascade,
  thread_id   uuid not null references email_threads(id) on delete cascade,
  question    text,
  answer      text,
  title       text,
  category    text,
  tags        text[] not null default '{}',
  confidence  float,                            -- 0.0–1.0 from Sonnet
  caveats     text,
  embedding   vector(1536),
  status      text not null default 'pending_review'
                check (status in ('pending_review', 'approved', 'rejected', 'published')),
  metadata    jsonb not null default '{}',
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- ─── KB articles ────────────────────────────────────────────
create table kb_articles (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references organizations(id) on delete cascade,
  extraction_id  uuid references extractions(id),
  title          text not null,
  body           text not null,                 -- markdown
  category       text,
  tags           text[] not null default '{}',
  embedding      vector(1536),
  published_at   timestamptz,
  export_targets jsonb not null default '{}',
  version        int not null default 1,
  created_at     timestamptz not null default now()
);

-- ─── Ticket suggestions (incoming ticket agent) ─────────────
create table ticket_suggestions (
  id                    uuid primary key default uuid_generate_v4(),
  org_id                uuid not null references organizations(id) on delete cascade,
  source_thread_id      uuid not null references email_threads(id) on delete cascade,
  suggested_reply       text,
  confidence_score      int check (confidence_score between 0 and 100),
  retrieved_article_ids uuid[] not null default '{}',
  retrieved_thread_ids  uuid[] not null default '{}',
  status                text not null default 'pending_review'
                          check (status in ('pending_review', 'accepted', 'edited', 'discarded')),
  final_reply           text,
  created_at            timestamptz not null default now()
);

-- ─── SME reviews ────────────────────────────────────────────
create table sme_reviews (
  id                 uuid primary key default uuid_generate_v4(),
  org_id             uuid not null references organizations(id) on delete cascade,
  suggestion_id      uuid not null references ticket_suggestions(id) on delete cascade,
  reviewer_id        uuid not null references users(id),
  accuracy_score     int check (accuracy_score between 0 and 100),
  completeness_score int check (completeness_score between 0 and 100),
  verdict            text not null check (verdict in ('correct', 'partial', 'wrong')),
  corrected_answer   text,
  notes              text,
  reviewed_at        timestamptz not null default now()
);

-- ─── Verified Q&A pairs (ground-truth layer) ────────────────
create table verified_pairs (
  id                uuid primary key default uuid_generate_v4(),
  org_id            uuid not null references organizations(id) on delete cascade,
  question          text not null,
  answer            text not null,
  source_review_id  uuid references sme_reviews(id),
  source_article_id uuid references kb_articles(id),
  embedding         vector(1536),
  accuracy_score    int,
  use_count         int not null default 0,
  created_at        timestamptz not null default now()
);

-- ─── Audit log (append-only) ────────────────────────────────
create table audit_log (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null,
  user_id     uuid,                             -- null for system actions
  action      text not null,
  resource    text not null,
  resource_id uuid not null,
  metadata    jsonb,
  ip_address  inet,
  created_at  timestamptz not null default now()
);
