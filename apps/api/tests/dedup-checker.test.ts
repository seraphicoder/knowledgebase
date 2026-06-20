import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fake-supabase.js';

// NOTE: spec calls for an integration test against Supabase with real pgvector
// similarities. Without a live DB in CI this unit-tests the threshold logic by
// stubbing the match_extractions RPC. Promote to integration once a test
// Supabase instance is wired up.

const fake = new FakeSupabase();
vi.mock('../src/lib/supabase.js', () => ({ getServiceClient: () => fake }));

const { checkDuplicate } = await import('../src/pipeline/dedup-checker.js');

const embedding = Array(1536).fill(0.02);

describe('dedup-checker thresholds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flags a duplicate above 0.92 similarity', async () => {
    fake.registerRpc('match_extractions', () => ({
      data: [{ id: 'e1', title: 't', confidence: 0.9, similarity: 0.95 }], error: null,
    }));
    const res = await checkDuplicate('org1', embedding);
    expect(res.verdict).toBe('duplicate');
    expect(res.similarExtractionIds).toContain('e1');
  });

  it('flags a potential merge in the 0.85–0.92 band', async () => {
    fake.registerRpc('match_extractions', () => ({
      data: [{ id: 'e2', title: 't', confidence: 0.9, similarity: 0.88 }], error: null,
    }));
    const res = await checkDuplicate('org1', embedding);
    expect(res.verdict).toBe('potential_merge');
    expect(res.similarExtractionIds).toEqual(['e2']);
  });

  it('treats low similarity as novel', async () => {
    fake.registerRpc('match_extractions', () => ({
      data: [{ id: 'e3', title: 't', confidence: 0.9, similarity: 0.4 }], error: null,
    }));
    const res = await checkDuplicate('org1', embedding);
    expect(res.verdict).toBe('novel');
    expect(res.similarExtractionIds).toEqual([]);
  });

  it('treats an empty match set as novel', async () => {
    fake.registerRpc('match_extractions', () => ({ data: [], error: null }));
    const res = await checkDuplicate('org1', embedding);
    expect(res.verdict).toBe('novel');
    expect(res.topSimilarity).toBe(0);
  });
});
