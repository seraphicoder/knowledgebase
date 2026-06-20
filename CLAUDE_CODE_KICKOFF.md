# MailMind — Claude Code Kickoff Prompt
> Paste this entire document into Claude Code at the start of a new session.

---

## Who You Are & What We're Building

You are the lead engineer on **MailMind** — a SaaS product that extracts institutional knowledge from email threads and turns it into a living, queryable knowledge base. This is a commercial product intended for sale to businesses. It must be built with production quality, security, and SOC 2 compliance in mind from day one.

The full product specification lives in `PLANNING.md` (included in this repo). Read it before writing any code. This kickoff prompt covers Phase 1 only.

---

## The Problem We're Solving

Organizations accumulate enormous institutional knowledge inside support email — answers to recurring questions, workarounds, policy clarifications. That knowledge is invisible, unsearchable, and walks out the door when employees leave. MailMind ingests email threads, uses AI to extract Q&A knowledge, and drafts knowledge base articles for human review before publishing.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite + Tailwind CSS |
| Backend | Node.js with Hono (lightweight, fast, TypeScript-first) |
| Database | Supabase (Postgres + pgvector + Auth + Storage) |
| AI — Relevance scoring | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) |
| AI — Extraction & drafting | Anthropic Claude Sonnet (`claude-sonnet-4-6`) |
| AI — Embeddings | OpenAI `text-embedding-3-small` (1536 dimensions) |
| Email ingestion (Phase 1) | `imapflow` npm package |
| Zendesk ingestion (Phase 1) | Zendesk REST API v2 (API token auth) |
| Language | TypeScript throughout |
| Package manager | npm |

Do not deviate from this stack without asking first.

---

## Project Structure

Scaffold the project with this structure:

```
mailmind/
├── apps/
│   ├── web/                  # React + Vite frontend
│   │   ├── src/
│   │   │   ├── components/
│   │   │   ├── pages/
│   │   │   ├── hooks/
│   │   │   └── lib/
│   │   └── package.json
│   └── api/                  # Hono backend
│       ├── src/
│       │   ├── routes/
│       │   ├── services/
│       │   ├── pipeline/     # Processing pipeline modules
│       │   ├── lib/
│       │   └── index.ts
│       └── package.json
├── supabase/
│   ├── migrations/           # All SQL migrations here
│   └── seed.sql
├── PLANNING.md
└── package.json              # Root workspace
```

Use npm workspaces for the monorepo.

---

## Non-Negotiable Architecture Rules

These must be followed in every file, every query, every route. They are required for SOC 2 compliance and cannot be skipped or deferred.

### 1. Row Level Security on every Supabase table
Every table must have RLS enabled and an `org_id` isolation policy. No exceptions. The policy must be enforced at the database layer, not just in application code.

```sql
-- Pattern to follow for every table
alter table {table_name} enable row level security;

create policy "org_isolation" on {table_name}
  using (org_id = (select org_id from users where id = auth.uid()));
```

### 2. Every action writes to the audit log
Any time data is created, updated, deleted, or exported — write a record to `audit_log`. The audit log is append-only: no UPDATE or DELETE policies on that table, ever.

### 3. No credentials in source code
All secrets go in `.env` files. `.env` is in `.gitignore`. Provide a `.env.example` with placeholder values for every required variable.

### 4. Every API route validates org_id
The authenticated user's `org_id` must be verified on every request. A user from org A must never be able to access, modify, or trigger processing on org B's data — even if they guess a valid UUID.

### 5. TypeScript strict mode
`tsconfig.json` must have `"strict": true`. No `any` types without an explicit comment explaining why.

### 6. All ingestion goes through the Connector interface
Every source — IMAP, Zendesk, future connectors — implements the same `Connector` interface and normalizes its data into a `RawConversation` before handing off to the thread reconstructor. Never write source-specific logic anywhere downstream of ingestion (noise filter, embedder, extractor must be source-agnostic).

Ingestion pulls **newest-first, walking backwards in time**, using an opaque per-connector resume cursor so large histories can be ingested in batches (see Architecture Rule #8).

```typescript
interface Connector {
  type: string;                          // 'imap' | 'zendesk'
  // Pulls a page of conversations newest-first. `cursor` is the opaque token
  // from the previous call (null to start from the newest record).
  fetchConversations(cursor: string | null, options?: { limit?: number }): Promise<FetchPage>;
  testConnection(): Promise<boolean>;
}

interface FetchPage {
  conversations: RawConversation[];      // newest-first
  nextCursor: string | null;             // opaque resume token; null = no older history left
}

interface RawConversation {
  externalId: string;
  subject: string;
  participants: string[];
  messages: { author: string; body: string; timestamp: Date }[];
  metadata: Record<string, unknown>;     // source-specific extras (ticket status, tags, etc.)
}
```

### 7. Ingestion and AI processing are separated by a mandatory approval gate
**This is a hard product requirement, not a style preference. Treat it with the same priority as RLS.**

Pulling data from a source (IMAP, Zendesk, any connector) into MailMind must NEVER automatically trigger any AI API call — not Haiku, not Sonnet, not even an embedding call. Ingested threads land with `approval_status = 'staged'` and stop there. A human must explicitly approve a thread (individually, by batch, by date range, or by source) before it advances to `approval_status = 'approved'`.

The pipeline runner (Milestone 2) must only ever query threads where `approval_status = 'approved'`. Do not write a code path anywhere that calls an AI API on a thread that hasn't been approved, even for "preview" or "test" purposes — if you need a preview feature later, that's a deliberate product decision to be discussed, not something to default into.

Concretely:
- `thread-store.ts` (Milestone 1) inserts rows with `approval_status = 'staged'` and `processing_status = 'not_started'`. It does nothing else.
- The embedder, relevance scorer, dedup checker, and extractor (Milestone 2) are never called from the ingestion path. They are only ever invoked by the pipeline runner, and the pipeline runner's very first query must filter `where approval_status = 'approved'`.
- Build a staging UI in Milestone 1 (see below) so the person using the app can see what's been pulled in before deciding whether to process it.

### 8. Ingestion pulls newest-first with a resumable backwards backfill

Connectors pull the **most recent conversations first and walk backwards in time**, so current, relevant threads land in staging immediately instead of after grinding through years of archives. Each connector returns a page plus an **opaque resume cursor** (`FetchPage.nextCursor`); the cursor is persisted per source (`ingestion_sources.sync_cursor`) so a large history can be ingested in batches via the `limit` option, and `backfill_complete` flips true when no older history remains.

- Cursors are connector-defined and opaque to callers — Zendesk uses the list endpoint's `after_cursor` (cursor pagination, `sort_by=created_at&sort_order=desc`); IMAP uses the lowest UID ingested so far.
- Batch boundaries are idempotent: overlap is absorbed by dedup on `(org_id, source_id, external_thread_id)`, so cursors need not be exact.
- The Zendesk **incremental-export** endpoint (`/api/v2/incremental/tickets.json`) is forward-only and is **not** used for this newest-first backfill. It remains available for a *future* ongoing forward-sync mode (catching new/updated tickets after backfill) — a separate, additive concern.
- The staging list orders by conversation recency (`date_range_end desc`) so newest threads appear at the top regardless of which batch ingested them.

---

## Database Schema — Phase 1

Create these as numbered Supabase migration files (`supabase/migrations/`). Run them in order.

### Migration 001 — Enable extensions
```sql
create extension if not exists "uuid-ossp";
create extension if not exists vector;
```

### Migration 002 — Core tables

```sql
-- Organizations
create table organizations (
  id                        uuid primary key default uuid_generate_v4(),
  name                      text not null,
  plan                      text not null default 'starter'
                              check (plan in ('starter', 'pro', 'enterprise')),
  data_retention_days       int,         -- null = indefinite
  soc2_direct_access_enabled boolean not null default false,
  created_at                timestamptz not null default now()
);

-- Users (extends Supabase auth.users)
create table users (
  id       uuid primary key references auth.users(id) on delete cascade,
  org_id   uuid not null references organizations(id) on delete cascade,
  email    text not null,
  role     text not null default 'viewer'
             check (role in ('admin', 'reviewer', 'sme', 'viewer')),
  created_at timestamptz not null default now()
);

-- Ingestion sources
create table ingestion_sources (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references organizations(id) on delete cascade,
  type           text not null
                   check (type in ('imap', 'zendesk', 'graph_api', 'pst_upload', 'mbox_upload', 'eml_upload')),
  label          text not null,
  config         jsonb not null default '{}',  -- secrets AES-256-GCM encrypted under config.credentials
  last_synced_at timestamptz,
  sync_cursor    text,                          -- opaque newest-first backfill resume token (see Rule #8)
  backfill_complete boolean not null default false,
  status         text not null default 'active'
                   check (status in ('active', 'paused', 'error')),
  created_at     timestamptz not null default now()
);

-- Email threads (stores conversations from any connector — IMAP, Zendesk, etc.)
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
                       check (approval_status in ('staged','approved','excluded')),
  approved_by        uuid references users(id),
  approved_at        timestamptz,
  processing_status  text not null default 'not_started'
                       check (processing_status in
                         ('not_started','pending','processing','extracted','skipped','error')),
  relevance_score    float,                     -- 0.0–1.0 from Haiku filter
  embedding          vector(1536),              -- from text-embedding-3-small — stays null until approved
  ingested_at        timestamptz not null default now(),
  unique(org_id, source_id, external_thread_id)
);
-- IMPORTANT: rows are inserted with approval_status = 'staged' and processing_status = 'not_started'.
-- No pipeline stage may touch a row where approval_status != 'approved'.

-- Extractions
create table extractions (
  id           uuid primary key default uuid_generate_v4(),
  org_id       uuid not null references organizations(id) on delete cascade,
  thread_id    uuid not null references email_threads(id) on delete cascade,
  question     text,
  answer       text,
  title        text,
  category     text,
  tags         text[] not null default '{}',
  confidence   float,                           -- 0.0–1.0 from Sonnet
  caveats      text,
  embedding    vector(1536),
  status       text not null default 'pending_review'
                 check (status in
                   ('pending_review','approved','rejected','published')),
  reviewed_by  uuid references users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- KB articles
create table kb_articles (
  id            uuid primary key default uuid_generate_v4(),
  org_id        uuid not null references organizations(id) on delete cascade,
  extraction_id uuid references extractions(id),
  title         text not null,
  body          text not null,                  -- markdown
  category      text,
  tags          text[] not null default '{}',
  embedding     vector(1536),
  published_at  timestamptz,
  export_targets jsonb not null default '{}',
  version       int not null default 1,
  created_at    timestamptz not null default now()
);

-- Ticket suggestions (incoming ticket agent)
create table ticket_suggestions (
  id                  uuid primary key default uuid_generate_v4(),
  org_id              uuid not null references organizations(id) on delete cascade,
  source_thread_id    uuid not null references email_threads(id) on delete cascade,
  suggested_reply     text,
  confidence_score    int check (confidence_score between 0 and 100),
  retrieved_article_ids uuid[] not null default '{}',
  retrieved_thread_ids  uuid[] not null default '{}',
  status              text not null default 'pending_review'
                        check (status in
                          ('pending_review','accepted','edited','discarded')),
  final_reply         text,
  created_at          timestamptz not null default now()
);

-- SME reviews
create table sme_reviews (
  id               uuid primary key default uuid_generate_v4(),
  org_id           uuid not null references organizations(id) on delete cascade,
  suggestion_id    uuid not null references ticket_suggestions(id) on delete cascade,
  reviewer_id      uuid not null references users(id),
  accuracy_score   int check (accuracy_score between 0 and 100),
  completeness_score int check (completeness_score between 0 and 100),
  verdict          text not null
                     check (verdict in ('correct','partial','wrong')),
  corrected_answer text,
  notes            text,
  reviewed_at      timestamptz not null default now()
);

-- Verified Q&A pairs (ground truth layer)
create table verified_pairs (
  id               uuid primary key default uuid_generate_v4(),
  org_id           uuid not null references organizations(id) on delete cascade,
  question         text not null,
  answer           text not null,
  source_review_id uuid references sme_reviews(id),
  source_article_id uuid references kb_articles(id),
  embedding        vector(1536),
  accuracy_score   int,
  use_count        int not null default 0,
  created_at       timestamptz not null default now()
);

-- Audit log (append-only — no update/delete policies)
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
```

### Migration 003 — RLS policies

Enable RLS and add org isolation policies on every table. Follow the pattern shown in the architecture rules above. Also add the insert-only policy on `audit_log`:

```sql
alter table audit_log enable row level security;
create policy "insert_only" on audit_log for insert with check (true);
-- Deliberately no SELECT, UPDATE, or DELETE policies for non-admin roles
```

### Migration 004 — Indexes

```sql
-- Vector similarity search indexes (HNSW for fast ANN search)
create index on email_threads  using hnsw (embedding vector_cosine_ops);
create index on extractions    using hnsw (embedding vector_cosine_ops);
create index on kb_articles    using hnsw (embedding vector_cosine_ops);
create index on verified_pairs using hnsw (embedding vector_cosine_ops);

-- Standard indexes
create index on email_threads (org_id, processing_status);
create index on email_threads (org_id, approval_status);   -- staging list + pipeline gate
create index on extractions   (org_id, status);
create index on kb_articles   (org_id, published_at);
create index on audit_log     (org_id, created_at);
```

### Migration 005 — Vector match RPCs

`SECURITY INVOKER` functions for pgvector cosine similarity, scoped by `org_id`:
- `match_extractions(p_org_id, p_query_embedding, p_match_count)` — powers dedup / merge suggestions (Milestone 2 `dedup-checker.ts`)
- `match_kb_articles(p_org_id, p_query_embedding, p_match_count)` — powers KB semantic search / RAG (later layers)

### Migration 006 — Resumable backfill cursor

Adds `ingestion_sources.sync_cursor` (text) and `ingestion_sources.backfill_complete` (boolean) to support the newest-first backwards backfill (Architecture Rule #8). *(Shown inline in the `ingestion_sources` create table above for readability; in the repo these land as an additive migration.)*

### RLS helper functions (note)

The org-isolation policies reference `SECURITY DEFINER` helper functions (`current_user_org()`, `current_user_role()`) so a policy on `users` can read `users` without infinite recursion. Use per-operation clauses — `with check` for INSERT/UPDATE, `using` for SELECT/DELETE — not a single `for all ... using` policy.

---

## Phase 1 — What To Build First (Milestones 1 & 2)

Build in this exact order. Do not jump ahead.

### Milestone 1 — Ingestion Foundation

**Goal:** A running service with a pluggable connector framework, two working connectors (IMAP and Zendesk), thread reconstruction, noise filtering, and storage in Supabase.

Build these modules in `apps/api/src/pipeline/`:

#### `connector.ts`
- Define the `Connector` interface and `RawConversation` type (see Architecture Rule #6 above)
- Define a `ConnectorFactory` that instantiates the right connector based on `ingestion_sources.type` and decrypts `ingestion_sources.config` to get credentials
- This file has no source-specific logic — it's the contract every connector implements

#### `connectors/imap-connector.ts`
- Implements `Connector` for IMAP mailboxes using `imapflow`
- Connect to the mailbox and fetch messages **newest-first by UID**, walking backwards from the resume cursor (the lowest UID ingested so far); honor the `limit` option and return the next cursor
- Fetch full message bodies including HTML and plain text, plus `Message-ID` / `In-Reply-To` headers
- Normalize each email or email thread into a `RawConversation`
- Handle connection errors with exponential backoff retry
- `testConnection()` performs a lightweight IMAP login/logout to verify credentials without fetching mail

#### `connectors/zendesk-connector.ts`
- Implements `Connector` for Zendesk using the REST API v2
- Auth: HTTP Basic with `{email}/token:{api_token}` — read the email and token from `ingestion_sources.config`
- Fetch tickets **newest-first** via `GET /api/v2/tickets.json` using **cursor pagination** (`page[size]`, `page[after]`) with `sort_by=created_at&sort_order=desc`, walking backwards in time. Size each page to the remaining `limit` so the returned `after_cursor` aligns exactly to the tickets consumed (no skipped partial pages). Return `nextCursor = after_cursor` while `meta.has_more`, else `null`. (Verified against a live account: the Tickets endpoint rejects the `sort=-created_at` shorthand with a 400. The forward-only `/api/v2/incremental/tickets.json` endpoint is intentionally NOT used here; reserve it for a future ongoing forward-sync mode.)
- For each ticket, fetch its full comment thread via `GET /api/v2/tickets/{id}/comments.json`
- Normalize each ticket into a `RawConversation`:
  - `externalId` = ticket ID
  - `subject` = ticket subject
  - `participants` = requester + assigned agent emails
  - `messages` = each comment mapped to `{ author, body (use `plain_body`, not `html_body`), timestamp }`
  - `metadata` = `{ status, tags, priority, ticket_type }` — store these, they're useful for future filtering (e.g. only ingest `status: solved` tickets)
- Respect Zendesk rate limits (700 requests/min on most plans) — implement a simple token bucket or just a delay between paginated requests
- Comment threads themselves paginate with the legacy `next_page` URL — follow it until null
- `testConnection()` calls `GET /api/v2/users/me.json` to verify the token works

#### `thread-reconstructor.ts`
- For IMAP sources: group individual messages into threads using `Message-ID` and `In-Reply-To` headers, falling back to subject-line grouping if headers are missing
- For Zendesk sources: a `RawConversation` already represents one complete ticket thread — this step is largely a pass-through, but still normalize into the same internal `Thread` object: `{ id, subject, messages[], participants[], dateRange }`
- Keep this function source-aware only at the entry point — everything after it operates on the unified `Thread` type

#### `noise-filter.ts`
- Strip email signatures (detect `--` separator and common signature patterns)
- Remove legal disclaimers and confidentiality footers
- Filter out OOO / auto-reply messages (detect `X-Auto-Response-Suppress` header and common OOO subject patterns) — IMAP source only, Zendesk tickets don't usually contain these
- Remove excessive quoted reply chains — keep only the most recent exchange
- Output clean plain text suitable for AI processing
- Note: Zendesk threads need much lighter filtering than raw email — comments are already clean, but still strip agent signature blocks if present

#### `thread-store.ts`
- Write cleaned threads to `email_threads` table in Supabase (the table name stays `email_threads` for now — it stores conversations from any connector, not just email; consider this naming debt for a later cleanup pass, do not rename mid-milestone)
- Insert with `approval_status = 'staged'` and `processing_status = 'not_started'` — always. This module never sets `approval_status = 'approved'` under any circumstance.
- Check for duplicates using `(org_id, source_id, external_thread_id)` before inserting
- Write an `audit_log` entry for each ingested thread (action: `thread.staged`)
- Handle batch inserts efficiently

#### `routes/staging.ts` (API routes, not pipeline)
- `GET /api/threads/staged` — list staged threads for the org, filterable by source, date range, search term, ordered newest-first by conversation recency (`date_range_end desc`). Returns subject, source, participants, date, message count — NOT an AI summary, since none exists yet at this point
- `POST /api/threads/:id/approve` — set `approval_status = 'approved'`, `approved_by`, `approved_at`. Write audit log entry (`thread.approved`). This is the only code path allowed to flip a thread to `approved`.
- `POST /api/threads/approve-batch` — accepts a list of thread IDs, or a filter (source_id + date range), approves all matching staged threads in one transaction. Same audit logging per thread.
- `POST /api/threads/:id/exclude` — set `approval_status = 'excluded'`. Excluded threads are never processed and can optionally be purged per the data retention policy.

#### Frontend — Staging Review Page (`apps/web/src/pages/Staging.tsx`)
- Table/list view of staged threads: subject, source (with connector icon), participant, date, message count
- Multi-select with checkboxes, "Approve Selected" and "Exclude Selected" bulk actions
- Filter by source and date range
- Click into a thread to preview the cleaned raw content before deciding
- This page must work before Milestone 2 exists — approving a thread when there's no pipeline runner yet just leaves it sitting at `approval_status = 'approved'`, `processing_status = 'not_started'`, which is correct and expected

**Milestone 1 is complete when:**
1. A test IMAP mailbox with 20+ forwarded support threads can be fully ingested, cleaned, and stored in Supabase as `staged` — with correct deduplication
2. A real Zendesk account's tickets can be ingested newest-first via cursor pagination, cleaned, and stored in Supabase as `staged` — with correct deduplication; a limited run pulls the newest batch and re-running walks further back via the persisted `sync_cursor`
3. Both connectors produce `Thread` objects that flow through the exact same `noise-filter.ts` and `thread-store.ts` code paths — no source-specific branching downstream of `thread-reconstructor.ts`
4. The Staging Review Page shows pulled threads from both connectors, and approving a thread is the only way its `approval_status` changes
5. **Verify no AI API call of any kind (Anthropic or OpenAI) fires anywhere in the Milestone 1 code path.** Ingestion must work completely with both API keys absent from `.env` — if it doesn't, something in Milestone 1 has an undeclared AI dependency and that's a bug.

---

### Milestone 2 — AI Extraction Pipeline

**Goal:** Process stored threads through the AI pipeline to produce extraction drafts ready for human review.

Build these modules in `apps/api/src/pipeline/`:

#### `embedder.ts`
- Call OpenAI `text-embedding-3-small` on cleaned thread content
- Update `email_threads.embedding` column
- Batch calls efficiently (OpenAI supports up to 2048 inputs per request)
- Handle rate limits with retry logic

#### `relevance-scorer.ts`
- Call Claude Haiku with a focused prompt to score thread relevance
- Prompt must determine: does this thread contain a question and an authoritative answer?
- Output a `relevance_score` (0.0–1.0) and a `skip_reason` if below threshold
- Threads below 0.40 relevance are marked `skipped` — do not proceed to Sonnet
- This gate exists to save cost — Haiku is ~20x cheaper than Sonnet

#### `dedup-checker.ts`
- Before calling Sonnet, query pgvector for the 5 most similar existing extractions for this org
- If cosine similarity > 0.92 with an existing extraction: mark as `skipped` with reason `duplicate`
- If similarity is 0.85–0.92: mark as `potential_merge` and include similar extraction IDs in metadata
- Only threads that pass this gate proceed to Sonnet

#### `extractor.ts`
- Call Claude Sonnet with the cleaned thread content
- System prompt must instruct Sonnet to return ONLY valid JSON — no markdown, no preamble
- A thread can cover **multiple distinct issues**, so return an **array** of entries — one per distinct issue with a documented, reusable resolution (empty array if none). Skip unresolved/clarifying-only/one-off exchanges.

```typescript
interface ExtractionResult {
  question: string;
  answer: string;
  title: string;
  category: string;
  tags: string[];
  confidence: number;      // 0.0–1.0
  caveats: string | null;
}
// extractKnowledge(content): Promise<ExtractionResult[]>
// Model returns { "extractions": ExtractionResult[] }
```

- Parse the JSON response safely — wrap in try/catch, fall back to error status if parse fails. An empty array is valid (no reusable knowledge), not an error.
- Write **each** entry as its own row in `extractions` (status `pending_review`), each with its own embedding in `extractions.embedding`
- A thread producing zero entries is marked `skipped` (reason `no_reusable_knowledge`)
- Write an `audit_log` entry per created extraction

#### `pipeline-runner.ts`
- **First query, no exceptions:** `select * from email_threads where org_id = $1 and approval_status = 'approved' and processing_status = 'not_started'`. This is the enforcement point for the approval gate — do not query on `processing_status` alone, `approval_status = 'approved'` must always be in the where clause.
- Orchestrates the full pipeline in sequence on that approved set:
  1. Set `processing_status = 'pending'` on the fetched threads
  2. Run embedder
  3. Run relevance scorer — skip below threshold
  4. Run dedup checker — skip duplicates
  5. Run extractor on passing threads
  6. Update `processing_status` at each stage
- This is typically triggered by a "Process Approved Threads" button in the UI (manual trigger), not an automatic cron — that's consistent with the human-in-the-loop approval model. A scheduled/automatic version can be added later as an opt-in setting, but manual trigger is the Phase 1 default.
- Process in batches of 10 to avoid overwhelming the DB or AI APIs
- Log pipeline run start/end/stats to audit log

---

## Environment Variables

Provide a `.env.example` with all of these:

```
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# OpenAI (embeddings)
OPENAI_API_KEY=

# IMAP (for dev/test — in production this comes from ingestion_sources.config)
IMAP_HOST=
IMAP_PORT=993
IMAP_USER=
IMAP_PASSWORD=
IMAP_POLL_INTERVAL_MS=300000

# Zendesk (for dev/test — in production this comes from ingestion_sources.config)
ZENDESK_SUBDOMAIN=
ZENDESK_EMAIL=
ZENDESK_API_TOKEN=
ZENDESK_POLL_INTERVAL_MS=300000

# App
PORT=3000
NODE_ENV=development
```

---

## Error Handling Standards

- Every async function must have try/catch with structured error logging
- Pipeline errors must update the relevant row's status to `error` and store the error message in a `metadata` jsonb field — never silently swallow errors
- All AI API calls must implement exponential backoff retry (max 3 attempts) for rate limit errors (429) and server errors (5xx)
- Never let a single thread failure crash the entire pipeline run — catch per-thread, log, continue

---

## Testing

Write tests for these before moving to Milestone 3:

- `noise-filter.ts` — unit tests with real email sample fixtures (create `tests/fixtures/` with 5+ sample raw emails)
- `thread-reconstructor.ts` — unit tests for header-based and subject-based threading
- `connectors/zendesk-connector.ts` — unit test with a mocked Zendesk API response (fixture JSON for ticket + comments) to verify correct `RawConversation` normalization, plus a test for pagination cursor handling
- `thread-store.ts` — test that inserted rows always have `approval_status = 'staged'`, never anything else
- `pipeline-runner.ts` — **critical test:** seed the DB with threads in both `staged` and `approved` states, run the pipeline, assert that only `approved` threads were touched (check `processing_status` changed only on those rows, and that no embedding/extraction was written for `staged` rows)
- `dedup-checker.ts` — integration test against Supabase with known similar/dissimilar embeddings
- `extractor.ts` — unit test with a mocked Anthropic API response to verify JSON parsing and fallback behavior

Use Vitest.

---

## What NOT To Build Yet

Do not build any of the following in Phase 1 — they are Phase 2:

- Microsoft Graph API integration
- GCC High / Azure Government support
- PST / MBOX / EML file upload parsing
- Scheduled/cron ingestion (polling is fine for now)
- Offboarding workflow
- Any export integrations (Confluence, Notion, Zendesk Guide — note this is publishing TO Zendesk's help center, unrelated to the Zendesk ticket connector being built in Milestone 1)

---

## First Steps — Do This In Order

1. Read `PLANNING.md` in full before writing any code
2. Scaffold the monorepo structure
3. Create `.env.example` and `.gitignore`
4. Write and run all 6 Supabase migrations (001 extensions, 002 tables, 003 RLS, 004 indexes, 005 vector-match RPCs, 006 sync cursor)
5. Verify RLS policies are active on all tables
6. Build the `Connector` interface, `RawConversation`, and `FetchPage` types first
7. Build the Zendesk connector — it's the faster path to real test data since there's an existing Zendesk account available
8. Build the IMAP connector
9. Build the shared thread-reconstructor / noise-filter / thread-store pipeline
10. Build a credential helper (`scripts/set-source-credentials.ts`) that encrypts source secrets from `.env` into `ingestion_sources.config` and verifies the connection
11. Write `scripts/test-ingest.ts` that can run the full Milestone 1 pipeline against either connector (`--source=zendesk` or `--source=imap`), with a `--limit=N` flag to pull one newest-first batch at a time for verification
12. Only after Milestone 1 is verified end-to-end on both connectors: begin Milestone 2

---

## Questions To Ask Before Starting

If anything is ambiguous, ask before writing code. Specifically confirm:

- Supabase project URL and whether pgvector extension needs to be manually enabled in the dashboard
- Whether `imapflow` should use TLS (yes, always — port 993)
- Zendesk subdomain and whether the API token should be scoped to a specific agent or an admin account
- Preferred error notification mechanism (console log is fine for Phase 1)

---

*Kickoff prompt version: 1.3 — Ingestion pulls newest-first with a resumable backwards backfill (cursor-based connector contract, `sync_cursor`/`backfill_complete`); replaces the forward incremental-export approach. Adds credential helper + `--limit` batching.*
