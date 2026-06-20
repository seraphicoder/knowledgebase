import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fake-supabase.js';

const fake = new FakeSupabase();
vi.mock('../src/lib/supabase.js', () => ({ getServiceClient: () => fake }));

const { storeThreads } = await import('../src/pipeline/thread-store.js');
import type { CleanThread } from '../src/pipeline/noise-filter.js';

function clean(id: string): CleanThread {
  return {
    externalId: id,
    subject: `Subject ${id}`,
    participants: [`${id}@x.com`],
    messages: [{ author: `${id}@x.com`, body: 'b', timestamp: new Date('2026-01-01T00:00:00Z') }],
    dateRange: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-01T01:00:00Z') },
    metadata: {},
    cleanedContent: `clean ${id}`,
  };
}

describe('thread-store', () => {
  beforeEach(() => {
    fake.seed('email_threads', []);
    fake.seed('audit_log', []);
  });

  it('always inserts rows as staged / not_started — never approved', async () => {
    const res = await storeThreads([clean('a'), clean('b')], { orgId: 'org1', sourceId: 'src1' });
    expect(res.inserted).toBe(2);

    const rows = fake.rows('email_threads');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.approval_status).toBe('staged');
      expect(r.processing_status).toBe('not_started');
      expect(r.embedding).toBeUndefined(); // no embedding at ingestion time
    }
  });

  it('writes a thread.staged audit entry per inserted thread', async () => {
    await storeThreads([clean('a'), clean('b')], { orgId: 'org1', sourceId: 'src1' });
    const audits = fake.rows('audit_log');
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.action === 'thread.staged')).toBe(true);
  });

  it('skips duplicates by (org_id, source_id, external_thread_id)', async () => {
    await storeThreads([clean('a')], { orgId: 'org1', sourceId: 'src1' });
    const res = await storeThreads([clean('a'), clean('c')], { orgId: 'org1', sourceId: 'src1' });
    expect(res.duplicatesSkipped).toBe(1);
    expect(res.inserted).toBe(1);
    expect(fake.rows('email_threads')).toHaveLength(2);
  });
});
