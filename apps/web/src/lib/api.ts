import { supabase } from './supabase';

// Default to same-origin ('') when unset — the single-service deploy serves the
// SPA and API from the same host, so relative '/api/...' is correct. Set
// VITE_API_BASE_URL only when the API lives on a different origin.
const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export interface StagedThread {
  id: string;
  source_id: string;
  external_thread_id: string;
  subject: string | null;
  participants: string[];
  message_count: number;
  date_range_start: string | null;
  date_range_end: string | null;
  ingested_at: string;
}

export interface ThreadDetail {
  id: string;
  subject: string | null;
  participants: string[];
  message_count: number;
  raw_content: string | null;
  date_range_start: string | null;
  date_range_end: string | null;
  approval_status: string;
  source_id: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init?.headers ?? {}) };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface StagedFilters {
  sourceId?: string;
  from?: string;
  to?: string;
  q?: string;
}

export function listStaged(
  filters: StagedFilters = {},
): Promise<{ threads: StagedThread[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.sourceId) params.set('source_id', filters.sourceId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.q) params.set('q', filters.q);
  const qs = params.toString();
  return request(`/api/threads/staged${qs ? `?${qs}` : ''}`);
}

export function getThread(id: string): Promise<{ thread: ThreadDetail }> {
  return request(`/api/threads/${id}`);
}

export interface ApprovedThread extends StagedThread {
  approved_at: string | null;
  processing_status: string;
}

export function listApproved(): Promise<{ threads: ApprovedThread[]; total: number }> {
  return request('/api/threads/approved');
}

export function approveBatch(threadIds: string[]): Promise<{ approved: number }> {
  return request('/api/threads/approve-batch', {
    method: 'POST',
    body: JSON.stringify({ thread_ids: threadIds }),
  });
}

export function excludeThread(id: string): Promise<{ excluded: string }> {
  return request(`/api/threads/${id}/exclude`, { method: 'POST' });
}

// ─── Pipeline ───────────────────────────────────────────────

export interface PipelineStats {
  considered: number;
  embedded: number;
  skippedLowRelevance: number;
  skippedDuplicate: number;
  skippedNoKnowledge: number;
  extracted: number; // total draft entries created (a thread can yield several)
  errored: number;
}

export function runPipeline(): Promise<{ ok: boolean; stats: PipelineStats }> {
  return request('/api/pipeline/run', { method: 'POST' });
}

// ─── Review queue (extractions) ─────────────────────────────

export interface Extraction {
  id: string;
  thread_id: string | null;
  title: string | null;
  question: string | null;
  answer: string | null;
  category: string | null;
  tags: string[];
  confidence: number | null;
  caveats: string | null;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface ExtractionSourceThread {
  id: string;
  subject: string | null;
  participants: string[];
  raw_content: string | null;
}

export interface ExtractionEdit {
  title?: string;
  question?: string;
  answer?: string;
  category?: string | null;
  tags?: string[];
  caveats?: string | null;
}

export function listExtractions(
  status = 'pending_review',
): Promise<{ extractions: Extraction[]; total: number }> {
  return request(`/api/extractions?status=${encodeURIComponent(status)}`);
}

export function getExtraction(
  id: string,
): Promise<{ extraction: Extraction; thread: ExtractionSourceThread | null }> {
  return request(`/api/extractions/${id}`);
}

export function editExtraction(id: string, patch: ExtractionEdit): Promise<{ ok: boolean }> {
  return request(`/api/extractions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function approveExtraction(id: string): Promise<{ ok: boolean; status: string }> {
  return request(`/api/extractions/${id}/approve`, { method: 'POST' });
}

export function rejectExtraction(id: string): Promise<{ ok: boolean; status: string }> {
  return request(`/api/extractions/${id}/reject`, { method: 'POST' });
}

// ─── Domain facts (grounding rules) ─────────────────────────

export interface DomainFact {
  id: string;
  term: string | null;
  fact: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export function listFacts(): Promise<{ facts: DomainFact[] }> {
  return request('/api/facts');
}

export function createFact(input: { term: string | null; fact: string }): Promise<{ fact: DomainFact }> {
  return request('/api/facts', { method: 'POST', body: JSON.stringify(input) });
}

export function updateFact(
  id: string,
  patch: { term?: string | null; fact?: string; active?: boolean },
): Promise<{ ok: boolean }> {
  return request(`/api/facts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteFact(id: string): Promise<{ ok: boolean }> {
  return request(`/api/facts/${id}`, { method: 'DELETE' });
}

// ─── Knowledge base ─────────────────────────────────────────

export interface KbArticleSummary {
  id: string;
  title: string;
  category: string | null;
  tags: string[];
  published_at: string | null;
}

export interface KbArticleDetail extends KbArticleSummary {
  body: string;
  extraction_id: string | null;
}

export interface KbSearchResult {
  id: string;
  title: string;
  body: string;
  similarity: number | null;
}

export function listKb(): Promise<{ articles: KbArticleSummary[]; total: number }> {
  return request('/api/kb');
}

export function getKbArticle(
  id: string,
): Promise<{ article: KbArticleDetail; source: { id: string; subject: string | null } | null }> {
  return request(`/api/kb/${id}`);
}

export function searchKb(q: string): Promise<{ mode: 'semantic' | 'keyword'; results: KbSearchResult[] }> {
  return request('/api/kb/search', { method: 'POST', body: JSON.stringify({ q }) });
}
