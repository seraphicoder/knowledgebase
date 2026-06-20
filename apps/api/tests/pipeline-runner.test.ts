import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fake-supabase.js';

// THE CRITICAL GATE TEST.
// Seed the DB with staged AND approved threads, run the pipeline, and assert
// that ONLY approved threads were touched — staged threads keep
// processing_status='not_started', get no embedding, and produce no extraction.

const fake = new FakeSupabase();
vi.mock('../src/lib/supabase.js', () => ({ getServiceClient: () => fake }));

// Mock every AI module so the test is deterministic and offline. (Their being
// mockable here also proves they're only reached via the runner.)
vi.mock('../src/pipeline/embedder.js', () => ({
  embedText: vi.fn(async () => Array(1536).fill(0.01)),
  embedTexts: vi.fn(async (xs: string[]) => xs.map(() => Array(1536).fill(0.01))),
}));
vi.mock('../src/pipeline/relevance-scorer.js', () => ({
  RELEVANCE_THRESHOLD: 0.4,
  scoreRelevance: vi.fn(async () => ({ score: 0.9, skipReason: null })),
}));
vi.mock('../src/pipeline/dedup-checker.js', () => ({
  DUPLICATE_THRESHOLD: 0.92,
  MERGE_THRESHOLD: 0.85,
  checkDuplicate: vi.fn(async () => ({ verdict: 'novel', topSimilarity: 0.1, similarExtractionIds: [] })),
}));
vi.mock('../src/pipeline/extractor.js', () => ({
  ExtractionParseError: class extends Error {},
  extractKnowledge: vi.fn(async () => ({
    question: 'q', answer: 'a', title: 't', category: 'c', tags: [], confidence: 0.8, caveats: null,
  })),
}));

const { runPipeline } = await import('../src/pipeline/pipeline-runner.js');
const embedder = await import('../src/pipeline/embedder.js');

describe('pipeline-runner approval gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.seed('email_threads', [
      { id: 'staged-1', org_id: 'org1', approval_status: 'staged', processing_status: 'not_started', raw_content: 'x' },
      { id: 'staged-2', org_id: 'org1', approval_status: 'staged', processing_status: 'not_started', raw_content: 'y' },
      { id: 'approved-1', org_id: 'org1', approval_status: 'approved', processing_status: 'not_started', raw_content: 'z' },
      // Another org's approved thread must also never be touched.
      { id: 'other-org', org_id: 'org2', approval_status: 'approved', processing_status: 'not_started', raw_content: 'w' },
    ]);
    fake.seed('extractions', []);
    fake.seed('audit_log', []);
  });

  it('only processes approved threads for the requested org', async () => {
    const stats = await runPipeline('org1');

    expect(stats.considered).toBe(1);
    expect(stats.extracted).toBe(1);

    const rows = fake.rows('email_threads');
    const byId = (id: string) => rows.find((r) => r.id === id)!;

    // Approved thread advanced and got an embedding.
    expect(byId('approved-1').processing_status).toBe('extracted');
    expect(byId('approved-1').embedding).toBeDefined();

    // Staged threads untouched.
    expect(byId('staged-1').processing_status).toBe('not_started');
    expect(byId('staged-2').processing_status).toBe('not_started');
    expect(byId('staged-1').embedding).toBeUndefined();
    expect(byId('staged-2').embedding).toBeUndefined();

    // Other org untouched.
    expect(byId('other-org').processing_status).toBe('not_started');

    // Exactly one extraction, for the approved thread.
    const extractions = fake.rows('extractions');
    expect(extractions).toHaveLength(1);
    expect(extractions[0]!.thread_id).toBe('approved-1');
  });

  it('never calls the embedder for staged threads', async () => {
    await runPipeline('org1');
    // 2 embed calls for the single approved thread (thread + extraction text),
    // and zero for staged/other-org threads.
    const calls = (embedder.embedText as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBe(2);
  });
});
