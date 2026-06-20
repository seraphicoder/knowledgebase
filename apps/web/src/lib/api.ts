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

export function approveBatch(threadIds: string[]): Promise<{ approved: number }> {
  return request('/api/threads/approve-batch', {
    method: 'POST',
    body: JSON.stringify({ thread_ids: threadIds }),
  });
}

export function excludeThread(id: string): Promise<{ excluded: string }> {
  return request(`/api/threads/${id}/exclude`, { method: 'POST' });
}
