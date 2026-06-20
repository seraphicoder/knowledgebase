import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZendeskConnector } from '../src/pipeline/connectors/zendesk-connector.js';
import fixture from './fixtures/zendesk-ticket.json' assert { type: 'json' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function ticket(id: number) {
  return {
    id, subject: `T${id}`, status: 'open', tags: [], priority: null, type: null, requester_id: null, assignee_id: null,
  };
}

function cursorPage(tickets: Record<string, unknown>[], after: string | null, hasMore: boolean) {
  return { tickets, meta: { has_more: hasMore, after_cursor: after, before_cursor: null }, links: { next: null, prev: null } };
}

const connector = () => new ZendeskConnector({ subdomain: 'acme', email: 'me@acme.example', apiToken: 'tok' });

describe('zendesk-connector', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('normalizes a ticket into a RawConversation using plain_body and resolved emails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/v2/tickets.json')) {
        return jsonResponse(cursorPage([fixture.incremental.tickets[0]!], null, false));
      }
      if (url.includes('/comments.json')) return jsonResponse(fixture.comments);
      if (url.includes('/users/501.json')) return jsonResponse(fixture.users['501']);
      if (url.includes('/users/777.json')) return jsonResponse(fixture.users['777']);
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { conversations } = await connector().fetchConversations(null);

    expect(conversations).toHaveLength(1);
    const c = conversations[0]!;
    expect(c.externalId).toBe('1001');
    expect(c.subject).toBe('Cannot log in after password reset');
    expect(c.messages).toHaveLength(2);
    expect(c.messages[0]!.body).toBe("I reset my password but still can't log in. Help!"); // plain_body
    expect(c.messages.some((m) => m.body.includes('<p>'))).toBe(false);
    expect(c.participants).toContain('requester@customer.example');
    expect(c.participants).toContain('agent@acme.example');
    expect(c.metadata.status).toBe('solved');
    expect(c.metadata.tags).toEqual(['login', 'auth']);
  });

  it('requests newest-first (sort=-created_at)', async () => {
    let sawSort = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/v2/tickets.json')) {
        if (url.includes('sort=-created_at')) sawSort = true;
        return jsonResponse(cursorPage([ticket(1)], null, false));
      }
      if (url.includes('/comments.json')) return jsonResponse({ comments: [], next_page: null });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await connector().fetchConversations(null);
    expect(sawSort).toBe(true);
  });

  it('follows the after_cursor across pages until has_more is false', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/v2/tickets.json')) {
        calls++;
        return calls === 1
          ? jsonResponse(cursorPage([ticket(10)], 'CUR1', true))
          : jsonResponse(cursorPage([ticket(9)], 'CUR2', false));
      }
      if (url.includes('/comments.json')) return jsonResponse({ comments: [], next_page: null });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { conversations, nextCursor } = await connector().fetchConversations(null);
    expect(conversations.map((c) => c.externalId)).toEqual(['10', '9']);
    expect(nextCursor).toBeNull(); // has_more was false on the last page
    expect(calls).toBe(2);
  });

  it('caps results at the limit and returns a resume cursor for the next batch', async () => {
    const sizes: number[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/v2/tickets.json')) {
        const size = Number(new URL(url).searchParams.get('page[size]'));
        sizes.push(size);
        // Return exactly the requested page size; more history remains.
        return jsonResponse(cursorPage([ticket(100)].concat(size > 1 ? [ticket(99), ticket(98)] : []).slice(0, size), 'NEXT', true));
      }
      if (url.includes('/comments.json')) return jsonResponse({ comments: [], next_page: null });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { conversations, nextCursor } = await connector().fetchConversations(null, { limit: 3 });
    expect(conversations).toHaveLength(3);
    expect(sizes).toEqual([3]); // single page sized exactly to the limit — no over-fetch
    expect(nextCursor).toBe('NEXT'); // resume token for the next (older) batch
  });

  it('passes the cursor through as page[after] to resume further back', async () => {
    let sawAfter: string | null = null;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/v2/tickets.json')) {
        sawAfter = new URL(url).searchParams.get('page[after]');
        return jsonResponse(cursorPage([ticket(5)], null, false));
      }
      if (url.includes('/comments.json')) return jsonResponse({ comments: [], next_page: null });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await connector().fetchConversations('RESUME_TOKEN');
    expect(sawAfter).toBe('RESUME_TOKEN');
  });
});
