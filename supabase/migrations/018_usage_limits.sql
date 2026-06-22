-- Migration 018 — Per-org usage limits (vendor-set caps for cost control).
--
-- Nullable = unlimited. Tokens and ingestion are evaluated against the current
-- calendar month; storage is an absolute total of stored attachment bytes.
-- The vendor sets these in the Platform console; enforcement happens at the
-- entry points (pipeline run, reply agent, ingestion).

alter table organizations
  add column if not exists monthly_token_limit  bigint,  -- input+output tokens / month
  add column if not exists storage_limit_bytes  bigint,  -- total attachment bytes
  add column if not exists monthly_ingest_limit integer; -- threads ingested / month

-- Focused per-org aggregates for cheap limit checks on the hot path.
create or replace function org_token_usage(p_org uuid, p_since timestamptz)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(input_tokens + output_tokens), 0)::bigint
  from ai_usage where org_id = p_org and created_at >= p_since
$$;

create or replace function org_storage_bytes(p_org uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(size), 0)::bigint from attachments where org_id = p_org
$$;
