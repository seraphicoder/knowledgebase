# MailMind

AI-powered knowledge extraction from email — turning support threads into a living, queryable knowledge base.

> Full product spec: [PLANNING.md](PLANNING.md) · Build brief: [CLAUDE_CODE_KICKOFF.md](CLAUDE_CODE_KICKOFF.md)

This repo contains **Phase 1, Milestones 1 & 2**: a pluggable connector framework (IMAP + Zendesk), thread reconstruction, noise filtering, a hard staging/approval gate, and the post-approval AI extraction pipeline (Claude Haiku + Sonnet, OpenAI embeddings, pgvector dedup).

## The one rule that matters most

**Ingestion never triggers AI.** Pulling threads from any source lands them at `approval_status = 'staged'`. No embedding, scoring, or extraction happens until a human approves a thread. The pipeline runner's first query is hard-filtered to `approval_status = 'approved'` — this is enforced in code and covered by a dedicated test ([`tests/pipeline-runner.test.ts`](apps/api/tests/pipeline-runner.test.ts)), not just a UI convention.

## Layout

```
apps/
  api/                 # Hono + TypeScript backend
    src/
      pipeline/        # connectors, reconstructor, noise filter, store, AI stages, runner
      routes/          # staging.ts (approval gate API), pipeline.ts (manual trigger)
      lib/             # env, supabase, auth, audit, crypto, ai, retry, logger
    scripts/test-ingest.ts
    tests/             # Vitest
  web/                 # React + Vite + Tailwind (Staging review UI)
supabase/migrations/   # 001 extensions, 002 tables, 003 RLS, 004 indexes, 005 match RPCs
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
> sorted `-created_at`. Validate that sort param against your account — some
> Zendesk list endpoints expect `sort_by`/`sort_order` (see the note in
> [zendesk-connector.ts](apps/api/src/pipeline/connectors/zendesk-connector.ts)).

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

> **Follow-up:** `POST /api/pipeline/run` runs the whole batch synchronously within
> the request. On a long backlog this can outlast HTTP proxy timeouts — before
> heavy use, move it to a background job (return `202` and run off-request).

## Status / not yet built

Phase 2 (Microsoft Graph, PST/MBOX upload, scheduled ingestion, offboarding, KB export, the review UI for extractions, and the Layer 1–3 KB usage features) is out of scope here — see PLANNING.md.
