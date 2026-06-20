# MailMind — Planning Document
> AI-powered knowledge extraction from email, turning support threads into a living knowledge base.

---

## Product Vision

Organizations accumulate enormous institutional knowledge inside email — support answers, troubleshooting steps, policy clarifications, workarounds. That knowledge is invisible, unsearchable, and walks out the door when an employee leaves.

MailMind ingests email threads and uses AI to extract, draft, and publish knowledge base articles. It starts with zero IT friction (forward an email) and scales up to full mailbox access for power users and offboarding workflows.

---

## Core Use Cases

### UC-1: Ongoing Support KB Building
A support team is answering the same questions over and over. Senior staff are tied up. MailMind watches a shared intake mailbox, extracts Q&A patterns from forwarded threads, and drafts KB articles for human review before publishing.

### UC-2: Employee Offboarding / Knowledge Capture
An employee gives notice or is terminated. IT exports their mailbox as a PST or grants MailMind direct access. MailMind sweeps the sent mail and threads, extracts institutional knowledge, and produces a structured knowledge transfer document.

### UC-3: Retroactive KB Seeding
A company has no KB at all. They upload a PST export or connect a shared mailbox and run a one-time sweep to generate an initial KB from years of accumulated email history.

---

## Ingestion Strategy — Connector Framework

MailMind ingests from multiple source types through a unified **connector framework**. Every connector — whether it's an email mailbox or a ticketing platform API — implements the same interface and feeds the same processing pipeline downstream. The source is abstracted away from extraction onward.

```typescript
interface Connector {
  type: string;                          // 'imap' | 'zendesk' | 'graph_api' | ...
  // Pulls a page of conversations newest-first, walking backwards in time.
  // `cursor` is the opaque token from the previous call (null = start at newest).
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

Every connector normalizes its source data into a `RawConversation` before handing off to the thread reconstructor / noise filter / extraction pipeline. This means adding a new connector later (Intercom, Freshdesk, HelpScout, Gmail) is additive — it never touches the pipeline itself.

Connectors are ranked by trust/friction tier, not strictly by phase — a customer can mix and match based on what they're comfortable granting access to.

---

### Tier 1 — Low Friction (Launch Connectors)

#### Forward-to-Intake (Email)
- Customer creates a dedicated intake mailbox (e.g. `kb-intake@company.com`)
- Staff forward support threads to that address manually, or set Outlook rules to auto-forward from specific folders
- MailMind polls that mailbox via IMAP and processes new arrivals
- **Why low friction:** Zero IT involvement. No permissions to grant. Customer feels safe. Easy to demo and sell.

#### Zendesk Connector
- Customer generates a Zendesk **API token** (Admin Center → Apps and Integrations → APIs → Zendesk API → add token) — this is a copy-paste credential, not an OAuth admin-consent flow
- MailMind pulls tickets via the Zendesk REST API (`/api/v2/tickets.json` + `/api/v2/tickets/{id}/comments.json`) using **cursor pagination sorted newest-first** (`sort_by=created_at&sort_order=desc`), walking backwards in time so the most recent tickets are ingested first. A per-source resume cursor lets large histories be pulled in batches (see [Ingestion Direction & Resumable Backfill](#ingestion-direction--resumable-backfill))
- Each ticket's comment thread maps directly to a `RawConversation` — Zendesk already has clean thread structure, requester/agent roles, and timestamps, so noise filtering is much lighter than raw email
- Ticket status, tags, and custom fields come through as metadata — useful later for filtering ("only ingest tickets tagged `resolved`")
- **Why this fits Tier 1:** A scoped API token is a far smaller trust ask than mailbox access. The customer can revoke it instantly, and read-only ticket-comment scope is easy to reason about. This is genuinely *less* invasive than Mail.Read, not more.
- **Why it's valuable:** If a customer already runs support through Zendesk, this captures 100% of their ticket history automatically — no one has to remember to forward anything. Strictly better data completeness than the forwarding approach, with comparable trust cost.

### Tier 2 — Higher Trust (Post-Trust Connectors)

#### Microsoft Graph API (Direct Mailbox Access)
- Customer's IT admin registers MailMind in their Azure tenant and grants `Mail.Read` application permission
- MailMind can sweep any mailbox, run scheduled ingestion, and support the offboarding workflow
- **Why higher trust:** Broad mailbox-level access, requires admin consent, harder for the customer to scope or revoke selectively

#### File Upload (PST / MBOX / EML)
- One-time or periodic upload of exported mail files
- No live connection or ongoing permission needed at all — but requires the customer to manually export, which is the friction tradeoff
- Primarily for the offboarding and retroactive-seeding use cases (UC-2, UC-3)

---

### Connector Priority Order

1. **Forward-to-Intake** — simplest possible demo, zero setup
2. **Zendesk** — high-value, low-friction, strong data completeness — build this right after the core pipeline is proven on email
3. **Microsoft Graph API** — unlocks offboarding, needs SOC 2 trust first
4. **PST/MBOX/EML upload** — supports offboarding without needing live API access
5. **Future connectors** (Intercom, Freshdesk, HelpScout, Gmail) — added opportunistically based on customer demand, same framework

---

### Ingestion Direction & Resumable Backfill

Ingestion pulls **newest-first and walks backwards in time**, not oldest-first. Rationale: support mailboxes and ticket systems can hold years of history, and the most recent threads are the most relevant to verify and act on. Pulling newest-first means useful, current knowledge appears at the top of staging immediately, rather than after grinding through old archives.

Every connector implements a uniform cursor contract:

```typescript
interface FetchPage {
  conversations: RawConversation[];   // newest-first
  nextCursor: string | null;          // opaque resume token; null = no older history left
}

interface Connector {
  // cursor = token from the previous call (null to start from the newest record)
  fetchConversations(cursor: string | null, options?: { limit?: number }): Promise<FetchPage>;
  testConnection(): Promise<boolean>;
}
```

- **The cursor is opaque and connector-defined.** Zendesk uses the list endpoint's `after_cursor` (cursor pagination, `sort_by=created_at&sort_order=desc`); IMAP uses the lowest UID ingested so far. Callers never interpret it.
- **Resumable batches.** A per-source cursor is persisted (`ingestion_sources.sync_cursor`). With a `limit`, each run pulls the next batch further back in time; `backfill_complete` flips true when a connector reports no older history. This lets a large account be ingested and verified `N` records at a time.
- **Idempotent boundaries.** Overlap between batches is absorbed by dedup on `(org_id, source_id, external_thread_id)`, so cursors never need to be exact.
- **Why not the Zendesk incremental-export endpoint?** That endpoint (`/api/v2/incremental/tickets.json?start_time=…`) is forward-only (oldest→newest) and cannot serve newest-first ingestion. It remains the right tool for a *future ongoing forward-sync mode* (catching new/updated tickets after the initial backfill), which is a separate, additive concern.

> **Verified:** the Tickets endpoint requires `sort_by=created_at&sort_order=desc` for newest-first ordering; it rejects the `sort=-created_at` shorthand with a 400.

---

## Processing Pipeline

```
[Source]                    ← IMAP, Zendesk, Graph API, PST/file upload
     │
     ▼
[Ingestion Adapter]         ← Connector pulls raw conversations
     │
     ▼
[Thread Reconstructor]      ← Group by conversation ID / subject chain
     │
     ▼
[Noise Filter]              ← Strip signatures, footers, OOO replies, CC noise
     │
     ▼
[STAGING — awaiting approval]   ← Threads sit here, visible in the app, untouched by AI
     │
     │   ◄── Human reviews staged threads, selects which to process
     │       (individually, by date range, by source, or "approve all")
     ▼
[Relevance Scorer]          ← Identify Q&A patterns, flag low-signal threads
     │
     ▼
[AI Extraction Layer]       ← Claude API: extract question, answer, category, confidence
     │
     ▼
[Deduplication Engine]      ← Cluster similar extractions, merge near-duplicates
     │
     ▼
[Review Queue]              ← Human reviews drafted articles before publishing
     │
     ▼
[KB Publisher]              ← Internal KB, export to Confluence/Notion/Markdown
```

**The staging gate is the key boundary.** Ingestion (pulling data from a source into MailMind) and AI processing (sending data to Claude/embedding APIs) are two separate, explicitly distinct steps — not one continuous pipeline. A thread can sit in staging indefinitely with zero AI involvement. Nothing crosses from staging into the Relevance Scorer without an explicit human action.

This applies uniformly across every connector — IMAP, Zendesk, Graph API, file upload. None of them are exceptions. It's not a Zendesk-specific restriction; it's how MailMind treats all ingestion by design, which also happens to be a strong trust/compliance story for customers ("we don't AI-process your data until you tell us to").

## Vector Storage Strategy

MailMind uses **two complementary storage layers** — both live inside Supabase, so no separate vector database is needed.

### Regular Postgres
Handles all structured data: org records, ingestion sources, thread metadata, extraction status, user roles, KB articles. Standard relational queries, foreign keys, status filtering, pagination.

### pgvector (Postgres extension)
Handles semantic similarity. Embeddings are stored as extra columns on the `email_threads` and `extractions` tables — same database, no additional infrastructure.

```sql
-- Enable the extension (once per Supabase project)
create extension if not exists vector;

-- Embeddings live alongside regular columns
alter table email_threads add column embedding vector(1536);
alter table extractions   add column embedding vector(1536);
alter table kb_articles   add column embedding vector(1536);
```

### Where vectors are used

| Job | How |
|---|---|
| **Deduplication** | Before extracting a thread, check cosine similarity against existing extractions. If score > 0.92, flag as likely duplicate and skip or merge. |
| **Similarity clustering** | Group threads about the same topic before sending to Claude, producing one high-quality article instead of many redundant drafts. |
| **KB semantic search** | Users search the published KB with natural language — results ranked by vector similarity, not just keyword match. |
| **Suggested merges** | When a new extraction is similar (0.85–0.92) to an existing article, surface a "merge suggestion" in the review queue. |

### Embedding model
- **Primary:** `text-embedding-3-small` (OpenAI) — 1536 dimensions, cheap, fast, widely supported
- **Alternative:** `voyage-3` (Voyage AI) — tends to outperform on technical/support content, worth benchmarking
- Embeddings are generated after noise filtering, before the Sonnet extraction pass

### Similarity query example
```sql
-- Find the 5 most similar existing extractions to a new thread
select id, title, confidence,
       1 - (embedding <=> $1::vector) as similarity
from extractions
where org_id = $2
  and status != 'rejected'
order by embedding <=> $1::vector
limit 5;
```

---

## AI Extraction Layer (Claude API)

A single support thread often covers **multiple distinct issues** (e.g. a printer ticket discussing banding, tray drainage, and a printhead swap in one conversation). So each processed thread is sent to Claude and yields an **array of entries — one per distinct issue that has a documented, reusable resolution** (possibly empty if none). Unresolved issues, clarifying-question-only exchanges, and one-off miscommunications are skipped.

```json
{
  "extractions": [
    {
      "question": "What is the core question being asked?",
      "answer": "What is the authoritative answer given?",
      "category": "Suggested KB category",
      "title": "Suggested article title",
      "tags": ["tag1", "tag2"],
      "confidence": 0.0-1.0,
      "caveats": "Any nuance, exceptions, or version-specific notes"
    }
  ]
}
```

Each returned entry becomes its own `extractions` row (with its own embedding) for independent review. A thread that yields zero entries is marked `skipped` (reason `no_reusable_knowledge`).

**Model strategy:**
- `claude-haiku` — relevance scoring and noise filtering (high volume, low cost)
- `claude-sonnet` — full extraction and article drafting (quality matters here)

---

## Data Model (Supabase)

### `organizations`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| name | text | |
| plan | enum | `starter`, `pro`, `enterprise` |
| created_at | timestamp | |

### `ingestion_sources`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK → organizations |
| type | enum | `imap`, `zendesk`, `graph_api`, `pst_upload`, `mbox_upload`, `eml_upload` |
| label | text | e.g. "Support Intake Mailbox" |
| config | jsonb | non-secret fields (subdomain, host, port) in plaintext; secrets AES-256-GCM encrypted under `config.credentials` |
| last_synced_at | timestamp | timestamp of the last ingestion run |
| sync_cursor | text | opaque, connector-defined resume token for the newest-first backfill (null = start from newest) |
| backfill_complete | boolean | true once the connector reports no older history left to pull |
| status | enum | `active`, `paused`, `error` |

### `email_threads`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK |
| source_id | uuid | FK → ingestion_sources |
| external_thread_id | text | original message/conversation ID |
| subject | text | |
| participants | jsonb | array of email addresses |
| message_count | int | |
| raw_content | text | cleaned, noise-filtered thread text |
| date_range_start | timestamp | |
| date_range_end | timestamp | |
| approval_status | enum | `staged`, `approved`, `excluded` — gate controlling whether this thread may enter AI processing at all |
| approved_by | uuid | FK → users — who approved it for processing, null while staged |
| approved_at | timestamp | null while staged |
| processing_status | enum | `not_started`, `pending`, `processing`, `extracted`, `skipped`, `error` — only advances past `not_started` once `approval_status = 'approved'` |
| relevance_score | float | 0.0–1.0 from haiku filter pass |
| embedding | vector(1536) | semantic embedding for dedup + clustering — only generated after approval |
| ingested_at | timestamp | when it was pulled from the source into staging |

**Important:** `embedding` is null for staged/excluded threads. No AI API call of any kind — not even an embedding call — happens before `approval_status = 'approved'`. This is the literal enforcement of the staging gate, not just a UI convention.

### `extractions`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK |
| thread_id | uuid | FK → email_threads |
| question | text | |
| answer | text | |
| title | text | AI-suggested article title |
| category | text | |
| tags | text[] | |
| confidence | float | |
| caveats | text | |
| embedding | vector(1536) | semantic embedding for merge suggestions |
| status | enum | `pending_review`, `approved`, `rejected`, `published` |
| reviewed_by | uuid | FK → users |
| reviewed_at | timestamp | |
| created_at | timestamp | |

### `kb_articles`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK |
| extraction_id | uuid | FK → extractions |
| title | text | |
| body | text | markdown |
| category | text | |
| tags | text[] | |
| embedding | vector(1536) | semantic embedding for KB search |
| published_at | timestamp | |
| export_targets | jsonb | where it's been published to |
| version | int | for future edit history |

### `users`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK |
| email | text | |
| role | enum | `admin`, `reviewer`, `sme`, `viewer` |

### `domain_facts`
Org-authored grounding facts/rules injected into the extraction prompt so the AI uses the customer's truth instead of its assumptions (see [AI Extraction Layer](#ai-extraction-layer-claude-api)).
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK |
| term | text | trigger keyword; injected only when it appears in a thread. `null` = global rule (always injected) |
| fact | text | the authoritative fact/instruction |
| active | boolean | toggled off without deleting |
| created_by | uuid | FK → users |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

## KB Usage Layer — Search, Agent & Feedback Loop

Once knowledge is extracted and published, MailMind becomes an active intelligence layer — not just a static document store. There are three tiers of usage that build on each other.

---

### Layer 1 — KB Search & Q&A

Staff ask the KB questions in plain language using RAG (Retrieval Augmented Generation):

```
User types question
       ↓
Convert question to embedding
       ↓
pgvector similarity search → top N relevant KB articles
       ↓
Articles injected into Claude prompt as context
       ↓
Claude answers citing specific articles
       ↓
Response shown with source article references
```

- Semantic search means "how do I reset the admin password" matches "Account Recovery Steps" without keyword overlap
- Source citations let staff verify and trust the answer
- Falls back gracefully: if no relevant articles exist, Claude says so rather than hallucinating

---

### Layer 2 — Incoming Ticket Agent

When a new support email arrives, the agent proactively drafts a suggested reply before a human looks at it:

```
New support email arrives
       ↓
Convert ticket body to embedding
       ↓
Parallel retrieval:
  ├── Top N similar KB articles (pgvector)
  └── Top N similar past resolved threads (pgvector)
       ↓
All context fed to Claude Sonnet:
  "Here is a new ticket. Here are the most relevant KB
   articles and similar resolved threads. Draft a suggested
   reply and provide a confidence score 0-100."
       ↓
Suggested reply + confidence score surfaced to support agent
       ↓
Agent accepts / edits / discards the suggestion
```

**Confidence score is composite:**
- Claude self-assessed confidence
- Average similarity score of retrieved context
- Verified pair bonus — SME-verified answers boost score
- If best match similarity < 0.60, score is capped low regardless

The agent never sends automatically — a human is always in the loop.

---

### Layer 3 — SME Scoring & Feedback Loop

The mechanism that makes MailMind smarter over time without fine-tuning any model:

```
Agent drafts suggested reply + confidence score
       ↓
SME reviews the draft
       ↓
SME scores the suggestion:
  ✅ Correct (80-100)
  ⚠️  Partially correct (40-79)  →  SME edits the answer
  ❌  Wrong (0-39)               →  SME writes correct answer
       ↓
Correction stored as a verified Q&A pair
       ↓
Verified pairs get is_verified = true + higher retrieval weight
       ↓
Used as priority context in future similar tickets
       ↓
KB articles that keep getting corrected flagged for revision
```

This is RLHF-lite — human feedback improving retrieval quality rather than model weights. The model stays the same; the context it retrieves gets progressively more accurate and domain-specific.

---

### The Flywheel

```
More tickets arrive → Agent suggests answers → SMEs review and score
       ↑                                                    ↓
Novel questions become new KB articles         Verified pairs accumulate
       ↑                                                    ↓
SMEs only handle genuinely novel questions     Retrieval context improves
       ↑                                                    ↓
Fewer tickets need SME review          ←       Confidence scores rise
```

The longer a customer uses MailMind, the more accurate it becomes for their specific domain. A competitor can copy the feature set but not the accumulated verified knowledge.

---

### New Tables for KB Usage Layer

#### `ticket_suggestions`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK |
| source_thread_id | uuid | FK → email_threads (the incoming ticket) |
| suggested_reply | text | Claude drafted response |
| confidence_score | int | 0–100 composite score |
| retrieved_article_ids | uuid[] | KB articles used as context |
| retrieved_thread_ids | uuid[] | Past threads used as context |
| status | enum | `pending_review`, `accepted`, `edited`, `discarded` |
| final_reply | text | What was actually sent |
| created_at | timestamptz | |

#### `sme_reviews`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK |
| suggestion_id | uuid | FK → ticket_suggestions |
| reviewer_id | uuid | FK → users |
| accuracy_score | int | 0–100 |
| completeness_score | int | 0–100 |
| verdict | enum | `correct`, `partial`, `wrong` |
| corrected_answer | text | null if verdict = correct |
| notes | text | optional reviewer notes |
| reviewed_at | timestamptz | |

#### `verified_pairs`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| org_id | uuid | FK |
| question | text | |
| answer | text | SME-verified answer |
| source_review_id | uuid | FK → sme_reviews |
| source_article_id | uuid | FK → kb_articles |
| embedding | vector(1536) | priority retrieval |
| accuracy_score | int | inherited from sme_review |
| use_count | int | times retrieved as context |
| created_at | timestamptz | |

---

### Updated `users` Roles
| role | can do |
|---|---|
| `admin` | everything — org settings, sources, user management |
| `reviewer` | approve / reject KB article drafts |
| `sme` | score suggestions, write verified answers, review extractions |
| `viewer` | search and read KB only |

---

### KB Analytics Dashboard

| Metric | What it shows |
|---|---|
| Avg confidence score over time | Is retrieval improving? |
| % suggestions accepted without edit | How accurate is the agent? |
| SME correction rate by category | Which KB areas need more coverage? |
| Tickets deflected (agent answer used) | ROI — hours saved for senior staff |
| Verified pairs accumulated | How much ground truth has been built |

---



## Phase 1 Build Plan

> **Status (current):** Milestones 1–3 built and deployed (single Railway service + Supabase). Plus, beyond the original plan: ingestion is **newest-first / resumable backfill**, the extractor is **multi-Q&A** (one thread → many drafts), and a **Domain Facts** grounding layer feeds the extraction prompt. Not yet built: similarity clustering, and Milestones 4–5.

### Milestone 1 — Ingestion Foundation ✅
- [x] Connector interface / abstraction layer (`Connector`, `RawConversation`)
- [x] IMAP polling adapter (connect to intake mailbox)
- [x] Zendesk connector (REST API, ticket + comments polling)
- [x] Email thread reconstructor
- [x] Noise filter (signatures, footers, OOO detection, HTML entities/tags)
- [x] Store cleaned threads in Supabase with `approval_status = 'staged'` — ingestion stops here, no AI calls
- [x] Staging view in the app — list pulled threads (subject, source, participant, date); sortable + searchable
- [x] Approval actions — approve individual / by batch / exclude

### Milestone 2 — AI Extraction Pipeline ✅ (clustering deferred)
- [x] Pipeline runner only ever queries threads where `approval_status = 'approved'` — the literal gate enforcement, covered by a test
- [x] Embedding generation after noise filter (OpenAI `text-embedding-3-small`) — only fires post-approval
- [x] Relevance scorer (Haiku) — skip low-signal threads (scores high if ≥1 issue has a reusable resolution)
- [x] Deduplication check via pgvector cosine similarity before Sonnet pass
- [x] Full extraction prompt (Sonnet) — **multi-Q&A**: structured JSON array, one entry per distinct resolved issue
- [ ] Similarity clustering — group related threads before extraction *(deferred)*
- [x] Store extractions + embeddings in Supabase

### Milestone 3 — Review UI ✅
- [x] Review queue — list of pending extractions (`/review`)
- [x] Article editor — edit AI draft before approving; source thread shown via `extractions.thread_id` FK
- [x] Approve / reject actions
- [x] Basic category and tag management (editable per draft)
- [x] *(added)* Approved-threads tab (`/approved`) — view approved threads + pipeline status + original source

### Beyond plan — Domain Facts ✅
- [x] `domain_facts` table + RLS, CRUD API, management UI (`/facts`)
- [x] Term-triggered + global facts injected into the extraction prompt as authoritative context

### Milestone 4 — KB Output
- [ ] Internal KB viewer — semantic search powered by pgvector
- [ ] Keyword search fallback (Postgres full-text search)
- [ ] Markdown export
- [ ] Webhook / export to Notion or Confluence (basic)

### Milestone 5 — KB Usage & Ticket Agent
- [ ] KB semantic Q&A interface (RAG search)
- [ ] Incoming ticket agent — auto-draft suggested reply with confidence score
- [ ] SME review interface — score suggestions, write corrections
- [ ] Verified pairs storage and retrieval weighting
- [ ] KB analytics dashboard — deflection rate, confidence trends, correction rate

---

## Phase 2 Build Plan (Post-Launch)

- [ ] Microsoft Graph API adapter (commercial M365)
- [ ] GCC High variant (`.us` endpoints)
- [ ] PST file upload + `pypff` parser
- [ ] MBOX / EML file upload
- [ ] Scheduled auto-ingestion (cron)
- [ ] Offboarding workflow UI — sweep a specific user's mailbox
- [ ] Zendesk Guide export
- [ ] SharePoint / Confluence deeper integration
- [ ] Multi-user review with approval workflows
- [ ] Confidence threshold auto-publish (bypass review for high-confidence extractions)

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React + Vite + Tailwind | Consistent with existing projects |
| Backend | Node.js (Express or Hono) | Lightweight API layer |
| Database | Supabase (Postgres + pgvector) | Auth, storage, relational data, and vector search in one |
| AI — Scoring | Claude Haiku | Relevance scoring and noise filtering |
| AI — Extraction | Claude Sonnet | Full extraction and article drafting |
| AI — Embeddings | OpenAI `text-embedding-3-small` | 1536-dim vectors for dedup, clustering, search |
| Email (Phase 1) | IMAP via `imapflow` | Connect to intake mailbox |
| Ticketing (Phase 1) | Zendesk REST API | API token auth, polling-based |
| Email (Phase 2) | Microsoft Graph API | Direct mailbox access |
| PST Parsing | Python `pypff` / `libratom` | Sidecar Python service or CLI |
| File Storage | Supabase Storage | PST/MBOX uploads |
| Deployment | Railway or Render (MVP) | Move to Azure Gov if selling to GCC High orgs |

---

## Go-to-Market

### Pricing Tiers (suggested)
| Tier | Price | Limits | Target |
|---|---|---|---|
| Starter | $49/mo | 1 mailbox, 500 threads/mo | SMB, solo IT |
| Pro | $149/mo | 5 mailboxes, 5k threads/mo | Growing support teams |
| Enterprise | Custom | Unlimited + Graph API + offboarding | Mid-market, govcon |

### Initial Sales Motion
1. **Forward-first demo** — show value in under 10 minutes with zero IT involvement
2. **Land and expand** — once they trust the output, upsell to direct access + offboarding
3. **Huntsville / govcon angle** — GCC High support is a natural Phase 2 differentiator in the local market

---

## Security & SOC 2 Compliance

SOC 2 is the trust signal that unlocks direct mailbox access. No organization will grant `Mail.Read` permissions to a vendor without it. Security must be built into the architecture from day one — it is far cheaper to add these controls early than to retrofit them later.

---

### SOC 2 Roadmap

| Milestone | Type | Timeline | Unlocks |
|---|---|---|---|
| Launch | — | Day 1 | Forward-to-intake (low risk, no audit needed) |
| SOC 2 Type I | Point-in-time snapshot — controls exist | ~3 months after launch | Mid-market direct mailbox access sales |
| SOC 2 Type II | 6-12 month continuous audit — controls work | ~12-18 months in | Enterprise + govcon deals |

**Recommended tooling:** Vanta, Drata, or Secureframe (~$10-15k/yr) — these automate evidence collection and cut audit prep time significantly by integrating with your infra, GitHub, and cloud providers.

---

### Architecture Requirements for SOC 2 (Build From Day One)

#### 1. Tenant Isolation
Every single database query must be scoped to `org_id`. No exceptions.
- Enable **Row Level Security (RLS)** in Supabase on every table — enforced at the database layer, not just the application layer
- No cross-tenant queries ever — org A can never see org B's data, embeddings, or articles
- Separate Supabase storage buckets per org for file uploads (PST, MBOX)

```sql
-- Example RLS policy on email_threads
alter table email_threads enable row level security;

create policy "org isolation"
on email_threads
using (org_id = (select org_id from users where id = auth.uid()));
```

#### 2. Immutable Audit Log
Every action in the system writes to an append-only audit log. This is non-negotiable for SOC 2.

```sql
create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  user_id     uuid,                        -- null for system actions
  action      text not null,               -- 'thread.ingested', 'article.published', etc.
  resource    text not null,               -- table name
  resource_id uuid not null,               -- row affected
  metadata    jsonb,                       -- extra context
  ip_address  inet,
  created_at  timestamptz default now()
);

-- No updates or deletes allowed on audit_log — ever
alter table audit_log enable row level security;
create policy "insert only" on audit_log for insert using (true);
-- No update or delete policy = nobody can modify records
```

Actions to log: thread ingested, thread skipped, extraction created, article approved, article rejected, article published, article deleted, source connected, source disconnected, user invited, user role changed, data export, data deletion request.

#### 3. Encryption
- **At rest:** Supabase encrypts at rest by default (AES-256) — verify this is enabled on your project
- **In transit:** TLS 1.2+ enforced on all endpoints — no HTTP
- **Credentials:** OAuth tokens and IMAP passwords stored in `ingestion_sources.config` must be encrypted at the application level before storage — use a KMS key (AWS KMS or Supabase Vault), not a hardcoded secret
- **PST/MBOX uploads:** Encrypted in transit via TLS, encrypted at rest in Supabase Storage, deleted from storage after processing completes (configurable retention)

#### 4. Access Control
- **MFA required** for all MailMind user accounts — enforce via Supabase Auth
- **Role-based access control (RBAC):** `admin`, `reviewer`, `viewer` — enforced at both API and DB layer
- **Least privilege:** Service accounts (the Node backend) only have the permissions they need — no superuser DB connections in production
- **API keys:** Rotate on a schedule, never hardcoded in source, stored in environment secrets only

#### 5. Data Retention & Deletion
- **Configurable raw content retention:** Customers choose how long raw email thread content is stored (30 / 90 / 180 days / indefinitely). After retention window, raw content is purged — only the extracted KB article remains.
- **Right to deletion:** Customers can trigger a full org data purge — all threads, extractions, articles, embeddings, and audit logs (except the deletion event itself) removed within 30 days
- **PST/MBOX files:** Deleted from Supabase Storage immediately after processing pipeline completes

#### 6. No Cross-Customer AI Contamination
- Embeddings are stored per org — no shared vector space across customers
- Claude API calls never include data from multiple orgs in the same prompt
- No customer data is used for model training — include this explicitly in your Terms of Service and DPA

#### 7. Infrastructure Security
- **Dependency scanning:** Run `npm audit` / `pip audit` in CI on every commit
- **Secrets scanning:** GitHub secret scanning enabled, no credentials in source control ever
- **Penetration testing:** Annual pen test required for SOC 2 Type II
- **Uptime monitoring:** Required for Availability criteria — use UptimeRobot, Better Uptime, or Checkly
- **Backups:** Supabase automatic daily backups enabled, tested quarterly

---

### Additional Compliance Tables

#### `audit_log` (new table — see above)

#### Updated `organizations` table
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| name | text | |
| plan | enum | `starter`, `pro`, `enterprise` |
| data_retention_days | int | null = indefinite, otherwise purge raw content after N days |
| soc2_direct_access_enabled | boolean | gated feature — only after customer signs DPA |
| created_at | timestamp | |

---

### Trust & Sales Materials to Prepare

Before pitching direct mailbox access to any customer:
- **Security page** on marketing site — encryption, SOC 2 status, data handling
- **Data Processing Agreement (DPA)** — standard template, customer signs before enabling Phase 2
- **Privacy Policy** — explicit about what is stored, for how long, and what it's used for
- **Sub-processor list** — Anthropic (Claude API), OpenAI (embeddings), Supabase — customers will ask

---

## Open Questions for Later
- PII handling — do we redact sender/recipient names from extracted articles?
- On-premise / private cloud option for customers who won't send email content to a third-party SaaS?
- White-label / MSP reseller tier?
- HIPAA considerations if healthcare customers want to use this (separate BAA required)
- GDPR / CCPA — data residency requirements for EU or California customers

---

*Document version: 0.8 — Reflects shipped state: Milestones 1–3 built (ingestion + staging, multi-Q&A extraction pipeline, review queue), newest-first resumable backfill, and a Domain Facts grounding layer. Phase-1 build plan marked up to current status.*
