-- Migration 004 — Indexes.

-- Vector similarity (HNSW for fast approximate nearest-neighbour search).
create index on email_threads  using hnsw (embedding vector_cosine_ops);
create index on extractions    using hnsw (embedding vector_cosine_ops);
create index on kb_articles    using hnsw (embedding vector_cosine_ops);
create index on verified_pairs using hnsw (embedding vector_cosine_ops);

-- Standard lookup indexes.
create index on email_threads (org_id, processing_status);
create index on email_threads (org_id, approval_status);   -- staging-list + pipeline gate
create index on extractions   (org_id, status);
create index on kb_articles   (org_id, published_at);
create index on audit_log     (org_id, created_at);
