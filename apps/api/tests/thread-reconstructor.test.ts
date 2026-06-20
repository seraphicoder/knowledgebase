import { describe, it, expect } from 'vitest';
import { reconstructThreads, normalizeSubject } from '../src/pipeline/thread-reconstructor.js';
import type { RawConversation } from '../src/pipeline/connector.js';

function email(id: string, subject: string, opts: { inReplyTo?: string; ts: string }): RawConversation {
  return {
    externalId: id,
    subject,
    participants: [`${id}@x.com`],
    messages: [
      {
        author: `${id}@x.com`,
        body: `body ${id}`,
        timestamp: new Date(opts.ts),
        messageId: id,
        inReplyTo: opts.inReplyTo,
      },
    ],
    metadata: {},
  };
}

describe('thread-reconstructor', () => {
  it('normalizeSubject strips Re/Fwd prefixes', () => {
    expect(normalizeSubject('Re: Fwd: Help me')).toBe('help me');
    expect(normalizeSubject('FW: RE: Login issue')).toBe('login issue');
  });

  it('groups IMAP emails into one thread via In-Reply-To headers', () => {
    const convos = [
      email('m1', 'Login issue', { ts: '2026-01-01T10:00:00Z' }),
      email('m2', 'Re: Login issue', { inReplyTo: 'm1', ts: '2026-01-01T11:00:00Z' }),
      email('m3', 'Re: Login issue', { inReplyTo: 'm2', ts: '2026-01-01T12:00:00Z' }),
    ];
    const threads = reconstructThreads(convos, 'imap');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages).toHaveLength(3);
    expect(threads[0]!.externalId).toBe('m1'); // earliest anchors the thread
  });

  it('falls back to subject grouping when headers are missing', () => {
    const convos = [
      email('a', 'Billing question', { ts: '2026-01-02T10:00:00Z' }),
      email('b', 'Re: Billing question', { ts: '2026-01-02T11:00:00Z' }),
    ];
    const threads = reconstructThreads(convos, 'imap');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages).toHaveLength(2);
  });

  it('keeps unrelated IMAP emails as separate threads', () => {
    const convos = [
      email('x', 'Topic A', { ts: '2026-01-03T10:00:00Z' }),
      email('y', 'Topic B', { ts: '2026-01-03T11:00:00Z' }),
    ];
    const threads = reconstructThreads(convos, 'imap');
    expect(threads).toHaveLength(2);
  });

  it('passes Zendesk conversations through as one thread each', () => {
    const convos: RawConversation[] = [
      {
        externalId: '1001',
        subject: 'Ticket',
        participants: ['r@x.com', 'a@y.com'],
        messages: [
          { author: 'r', body: 'q', timestamp: new Date('2026-01-04T10:00:00Z') },
          { author: 'a', body: 'a', timestamp: new Date('2026-01-04T10:30:00Z') },
        ],
        metadata: { status: 'solved' },
      },
    ];
    const threads = reconstructThreads(convos, 'zendesk');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages).toHaveLength(2);
    expect(threads[0]!.metadata.status).toBe('solved');
  });
});
