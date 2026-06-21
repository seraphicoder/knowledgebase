# MailMind

AI-powered knowledge extraction from email — turning support threads into a living, queryable knowledge base.

> Full product spec: [PLANNING.md](PLANNING.md) · Build brief: [CLAUDE_CODE_KICKOFF.md](CLAUDE_CODE_KICKOFF.md)

This repo implements **Phase 1 (Milestones 1–4)** plus a domain-grounding layer: a pluggable connector framework (IMAP + Zendesk), thread reconstruction, noise filtering, a hard staging/approval gate, the post-approval AI extraction pipeline (Claude Haiku + Sonnet, OpenAI embeddings, pgvector dedup) with **multi-Q&A extraction**, a **human review queue**, a **searchable knowledge base** (semantic + keyword), and org-authored **domain facts** that ground the AI. See [Status](#status) for the exact built/not-built breakdown.

## The one rule that matters most

**Ingestion never triggers AI.** Pulling threads from any source lands them at `approval_status = 'staged'`. No embedding, scoring, or extraction happens until a human approves a thread. The pipeline runner's first query is hard-filtered to `approval_status = 'approved'` — this is enforced in code and covered by a dedicated test ([`tests/pipeline-runner.test.ts`](apps/api/tests/pipeline-runner.test.ts)), not just a UI convention.

## Layout

```
apps/
  api/                 # Hono + TypeScript backend
    src/
      pipeline/        # connectors, reconstructor, noise filter, store, attachment-store, AI stages, domain-facts, kb-publish, ticket-agent, runner
      routes/          # staging.ts, pipeline.ts, review.ts, facts.ts, kb.ts, tickets.ts (reply agent)
      lib/             # env, supabase, auth, audit, crypto, ai, retry, logger
    scripts/           # test-ingest.ts, set-source-credentials.ts
    tests/             # Vitest
  web/                 # React + Vite + Tailwind
    src/pages/         # Login, Staging, Approved, Review, KB, Replies, Facts
    src/components/    # ImageGallery, ThreadImages/ArticleImages, ImageEditorModal (lazy)
supabase/migrations/   # 001 extensions · 002 tables · 003 RLS · 004 indexes · 005 match RPCs · 006 sync cursor · 007 domain facts · 008 attachments · 009 article images · 010 thread/pair match RPCs · 011 ad-hoc suggestions · 012 merged status · 013 comments + flag · 014 member role · 015 thread search_text
```

## Setup

```bash
npm install                      # installs all workspaces
cp .env.example .env             # fill in Supabase + (for M2) AI keys
openssl rand -base64 32          # -> CONFIG_ENCRYPTION_KEY
```

Run the migrations in `supabase/migrations/` in order against your Supabase project (SQL editor or `supabase db push`), then `supabase/seed.sql` for a dev org + sources. pgvector is enabled by migration 001.

## Develop

```bash
npm run dev:api                  # backend on :3000
npm run dev:web                  # frontend on :5173
npm test                         # API unit tests
npm run typecheck                # all workspaces
```

### Ingesting data (no AI keys required)

First, store encrypted credentials on a seeded source (reads them from `.env`,
encrypts the secrets, writes them to `ingestion_sources.config`, and verifies the
connection):

```bash
npm run set-creds -- --source=zendesk
npm run set-creds -- --source=imap
```

Then pull conversations. Ingestion runs **newest-first and walks backwards in
time**, so the most recent threads land first. Use `--limit` to verify on a small
batch; re-running continues further back through the history until it's exhausted:

```bash
npm run ingest -- --source=zendesk --limit=25   # newest 25
npm run ingest -- --source=zendesk --limit=25   # next 25 (older) ...
npm run ingest -- --source=zendesk              # pull the rest
```

A per-source resume cursor (`ingestion_sources.sync_cursor`) is persisted between
runs; `backfill_complete` flips true when there's no older history left. Boundary
overlap between batches is absorbed by dedup on `(org_id, source_id, external_thread_id)`.

> Zendesk pulls newest-first via cursor pagination on the tickets list endpoint
> with `sort_by=created_at&sort_order=desc` (the Tickets endpoint rejects the
> `sort=-created_at` shorthand with a 400 — verified against a live account).

## Architecture guarantees (SOC 2 oriented)

- **Tenant isolation** — RLS on every table, org-scoped via `SECURITY DEFINER` helper functions ([`003_rls.sql`](supabase/migrations/003_rls.sql)). The backend uses the service role and still scopes every query by `org_id`.
- **Append-only audit log** — every create/update/delete/export writes to `audit_log`; no UPDATE/DELETE policy exists, so rows are immutable. Admins can read their org's log; the backend reads via the service role.
- **Encrypted credentials** — source secrets stored in `ingestion_sources.config` are AES-256-GCM encrypted at the app layer ([`lib/crypto.ts`](apps/api/src/lib/crypto.ts)).
- **No secrets in source** — everything via `.env` (git-ignored); `.env.example` documents every variable.

## Deployment — single Railway service

The whole app deploys as **one Railway service**: the Hono API serves the built
React SPA same-origin (no CORS, one deploy, one bill). The API is a long-running
container, so the AI pipeline and live IMAP fetches aren't constrained by
serverless time limits.

| Part | Host |
|---|---|
| `apps/web` (React/Vite SPA) + `apps/api` (Hono server + pipeline) | **Railway** (one service) |
| Postgres + pgvector + Auth + Storage | **Supabase** (managed) |

[`railway.toml`](railway.toml) builds from the monorepo root (no dashboard "Root
Directory" change needed):

1. `npm run build --workspace apps/web` → Vite build at `apps/web/dist`
2. `npm run build --workspace apps/api` → `tsc -p tsconfig.build.json` emits
   `dist/index.js` (server only — no tests/scripts), and its `postbuild` copies
   `apps/web/dist` into `apps/api/public`
3. Start: `node dist/index.js`. Hono serves `/api/*`, `/health`, and the SPA
   (with client-side-routing fallback to `index.html`) from `./public`.

Health check is `GET /health`. Node is pinned ≥20.12 ([`.nvmrc`](.nvmrc) /
`engines`) since the env loader uses `process.loadEnvFile`.

**Railway service variables** (Railway injects `PORT` automatically):
- Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `CONFIG_ENCRYPTION_KEY`
- Frontend build: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_BASE_URL=` **(empty — same-origin)**
- Milestone 2 only: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- Not needed: `WEB_ORIGIN` (same-origin needs no CORS allowlist)

> **Splitting later:** nothing locks you into one service. To move the frontend to
> a CDN (Vercel, Cloudflare Pages) later, host `apps/web` there with
> `VITE_API_BASE_URL` pointing at the Railway URL, and set `WEB_ORIGIN` on Railway
> to re-enable the CORS allowlist.

> **Pipeline runs off-request:** `POST /api/pipeline/run` returns `202` and processes
> in the background (in-memory per-org guard prevents overlap); the UI polls
> `GET /api/pipeline/status` for completion. A run in flight during a redeploy is
> lost (no job queue yet) — fine for manual triggering. The server also handles
> SIGTERM gracefully (drains in-flight requests, exits 0).

## Status

Built: Milestone 1 (ingestion + staging), Milestone 2 (AI extraction pipeline —
multi-Q&A: one thread can yield several drafts, one per distinct resolved issue),
Milestone 3 review queue (humans qualify AI-drafted extractions, then **Approve &
Publish**), and Milestone 4 KB output. At review time, a draft is checked for **near-duplicate
published articles** (flagged in the queue and inside the draft, with links); a
reviewer can **AI-merge** the draft into an existing article (Claude unifies the
text, the reviewer curates the combined image set — the article's images plus the
ticket's — then approves; the article re-versions and the draft is marked `merged`)
instead of creating a duplicate. Published articles support **comments** and a **"needs update" flag** (flagged
articles are badged in the list and on the article; managers clear the flag, and
merging/editing auto-clears it). They're **searchable in plain
language** (pgvector semantic search + keyword fallback) and **editable**
(an article's **Edit** moves it back to draft in Review, where text + images are
updated and it's re-published). A "Process Approved Threads" button on `/staging`
triggers the pipeline.

The data-heavy lists (Staging, Queued, Review, Knowledge Base) use **infinite
scroll** — pages load as you scroll (50 at a time); client-side sort/search
operate on the loaded rows. Smaller lists (Reply Agent, Users) load in one batch.

UI tabs: `/staging` (sortable + searchable staged threads), `/approved`
(read-only view of approved threads + pipeline status + original source),
`/review` (qualify drafts; the source thread is shown via the
`extractions.thread_id` FK), `/kb` (search + read published articles, download
.md, traced to source), `/facts` (domain grounding facts).

Domain Facts (`/facts`): org-authored authoritative facts/rules injected into the
extraction prompt so the AI uses the customer's truth instead of its assumptions
(e.g. "Model XYZ is roll-to-roll, not flatbed"). Term-triggered facts apply when
the term appears in a thread; termless facts are global rules.

Image attachments: images on Zendesk tickets and emails are captured during
ingestion and stored in a private Supabase Storage bucket (migration 008), shown
as thumbnails via short-lived signed URLs. In **Review**, each draft's images
can be **included/excluded** and **edited** (crop + text/shapes/freehand, via a
lazy-loaded canvas editor); on Approve & Publish only the chosen/edited images
attach to the article (`kb_article_images`, migration 009). **Re-editing a
published article keeps its curated/edited images** (snapshotted onto the draft on
unpublish; storage objects are not deleted), with a **"Reset to original images"**
option to go back to the source attachments. Images only for now (no AI vision yet).

Reply Agent (`/replies`, Milestone 5): **paste a ticket that just came in** (or
pick an existing one) → a KB-grounded **suggested reply** is drafted (Sonnet over retrieved KB articles + similar past threads +
verified pairs) with a **composite confidence score** and cited sources. Edit /
accept / discard / copy — it **never sends**. SME scoring (correct / partial /
wrong + corrections) feeds **verified Q&A pairs** that get priority retrieval on
future tickets — the feedback loop that improves accuracy over time.

Not yet built: KB export to Notion/Confluence (M4 stretch), an analytics/deflection
dashboard, AI vision on images, similarity clustering, and all of Phase 2
(Microsoft Graph, PST/MBOX upload, scheduled ingestion, offboarding). See PLANNING.md.
