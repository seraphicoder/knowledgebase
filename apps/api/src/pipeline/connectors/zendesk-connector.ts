import type { Connector, FetchOptions, FetchPage, RawAttachment, RawConversation, RawMessage, ZendeskConfig } from '../connector.js';
import { withRetry, isRetryableHttpStatus } from '../../lib/retry.js';
import { log } from '../../lib/logger.js';

// Zendesk connector (REST API v2). Uses the incremental export endpoint for
// polling, then fetches each ticket's comment thread. One ticket -> one
// RawConversation. Zendesk threads are already clean, so noise filtering
// downstream is light — but that decision lives in noise-filter.ts, not here.

interface ZendeskTicket {
  id: number;
  subject: string | null;
  status: string;
  tags: string[];
  priority: string | null;
  type: string | null;
  requester_id: number | null;
  assignee_id: number | null;
}

interface ZendeskComment {
  id: number;
  author_id: number;
  // Optional in practice: voice/system comments can omit the text bodies.
  plain_body?: string;
  body?: string;
  html_body?: string;
  created_at: string;
  attachments?: ZendeskAttachment[];
}

interface ZendeskAttachment {
  id: number;
  file_name: string;
  content_url: string;
  content_type: string;
  size: number;
  inline?: boolean;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // skip anything larger than 25 MB

interface TicketsCursorResponse {
  tickets: ZendeskTicket[];
  meta: { has_more: boolean; after_cursor: string | null; before_cursor: string | null };
  links: { next: string | null; prev: string | null };
}

const PAGE_MAX = 100; // Zendesk cursor-pagination max page[size]

const RATE_LIMIT_DELAY_MS = 120; // ~500 req/min, safely under the 700/min cap

export class ZendeskConnector implements Connector {
  readonly type = 'zendesk';
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly userEmailCache = new Map<number, string>();

  constructor(private readonly config: ZendeskConfig) {
    // Accept either the bare subdomain ("acme") or a pasted full host/URL
    // ("acme.zendesk.com", "https://acme.zendesk.com/") and normalize to the bare
    // subdomain so we don't build "acme.zendesk.com.zendesk.com".
    const sub = config.subdomain
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/\.zendesk\.com$/i, '');
    this.baseUrl = `https://${sub}.zendesk.com`;
    // HTTP Basic with "{email}/token:{api_token}".
    const creds = `${config.email}/token:${config.apiToken}`;
    this.authHeader = `Basic ${Buffer.from(creds).toString('base64')}`;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.get<{ user: { id: number } }>('/api/v2/users/me.json');
      return true;
    } catch (err) {
      log.error('Zendesk testConnection failed', {
        subdomain: this.config.subdomain,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async fetchConversations(cursor: string | null, options?: FetchOptions): Promise<FetchPage> {
    const limit = options?.limit;
    const { tickets, nextCursor } = await this.fetchTicketPages(cursor, limit);

    // Tickets already arrive newest-first. Fetch comments in that same order so
    // the resulting conversations stay newest-first.
    const conversations: RawConversation[] = [];
    for (const ticket of tickets) {
      const comments = await this.fetchComments(ticket.id);
      conversations.push(await this.toConversation(ticket, comments));
      await sleep(RATE_LIMIT_DELAY_MS);
    }
    log.info('Zendesk fetch complete', {
      tickets: conversations.length, limit: limit ?? null, nextCursor: nextCursor ?? null,
    });
    return { conversations, nextCursor };
  }

  // Cursor pagination on the tickets list endpoint, newest-first. We size each
  // page to the exact remaining need so the after_cursor always aligns to the
  // tickets we actually consumed — never skipping a partial page. Ordering uses
  // sort_by=created_at&sort_order=desc (verified against the live Tickets
  // endpoint, which rejects the `sort=-created_at` shorthand with a 400).
  private async fetchTicketPages(
    cursor: string | null,
    limit?: number,
  ): Promise<{ tickets: ZendeskTicket[]; nextCursor: string | null }> {
    const tickets: ZendeskTicket[] = [];
    let after = cursor;
    let hasMore = true;

    while (hasMore && (limit === undefined || tickets.length < limit)) {
      const size = limit === undefined ? PAGE_MAX : Math.min(limit - tickets.length, PAGE_MAX);
      const page = await this.get<TicketsCursorResponse>(this.ticketsPagePath(size, after));
      tickets.push(...page.tickets);
      after = page.meta.after_cursor;
      hasMore = page.meta.has_more;
      if (hasMore && (limit === undefined || tickets.length < limit)) await sleep(RATE_LIMIT_DELAY_MS);
    }

    // nextCursor is null only when Zendesk says there is no more history.
    return { tickets, nextCursor: hasMore ? after : null };
  }

  private ticketsPagePath(size: number, after: string | null): string {
    // Newest-first. The Tickets endpoint uses sort_by/sort_order — NOT the
    // `sort=-created_at` shorthand, which it rejects with a 400.
    const parts = [`page[size]=${size}`, 'sort_by=created_at', 'sort_order=desc'];
    if (after) parts.push(`page[after]=${encodeURIComponent(after)}`);
    return `/api/v2/tickets.json?${parts.join('&')}`;
  }

  // Download image attachments (bytes) for a comment. Non-images are ignored;
  // oversized files are skipped. Failures are logged, never fatal.
  private async downloadImages(atts: ZendeskAttachment[]): Promise<RawAttachment[]> {
    const out: RawAttachment[] = [];
    for (const a of atts) {
      if (!a.content_type?.startsWith('image/')) continue;
      if (a.size && a.size > MAX_ATTACHMENT_BYTES) continue;
      try {
        const res = await fetch(a.content_url, { headers: { Authorization: this.authHeader } });
        if (!res.ok) {
          log.info('Zendesk attachment download failed', { status: res.status, file: a.file_name });
          continue;
        }
        const data = Buffer.from(await res.arrayBuffer());
        out.push({
          filename: a.file_name,
          contentType: a.content_type,
          size: data.length,
          inline: Boolean(a.inline),
          data,
        });
        await sleep(RATE_LIMIT_DELAY_MS);
      } catch (err) {
        log.info('Zendesk attachment error', {
          file: a.file_name, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  private async fetchComments(ticketId: number): Promise<ZendeskComment[]> {
    const out: ZendeskComment[] = [];
    let url: string | null = `/api/v2/tickets/${ticketId}/comments.json`;
    while (url) {
      const page: { comments: ZendeskComment[]; next_page: string | null } =
        await this.get(url);
      out.push(...page.comments);
      url = pathOf(page.next_page);
      if (url) await sleep(RATE_LIMIT_DELAY_MS);
    }
    return out;
  }

  private async toConversation(
    ticket: ZendeskTicket,
    comments: ZendeskComment[],
  ): Promise<RawConversation> {
    const messages: RawMessage[] = [];
    for (const c of comments) {
      const images = c.attachments?.length ? await this.downloadImages(c.attachments) : [];
      messages.push({
        author: `user:${c.author_id}`, // resolved lazily below for participants
        // Prefer plain_body (never html_body). Some comments (voice/system) carry
        // no plain_body, so fall back to body, then empty string — never undefined.
        body: c.plain_body ?? c.body ?? '',
        timestamp: new Date(c.created_at),
        attachments: images.length ? images : undefined,
      });
    }

    const participants: string[] = [];
    for (const id of [ticket.requester_id, ticket.assignee_id]) {
      if (id == null) continue;
      const email = await this.resolveUserEmail(id);
      if (email) participants.push(email);
    }

    return {
      externalId: String(ticket.id),
      subject: ticket.subject ?? '(no subject)',
      participants,
      messages,
      metadata: {
        status: ticket.status,
        tags: ticket.tags,
        priority: ticket.priority,
        ticket_type: ticket.type,
      },
    };
  }

  private async resolveUserEmail(userId: number): Promise<string | null> {
    const cached = this.userEmailCache.get(userId);
    if (cached !== undefined) return cached;
    try {
      const res = await this.get<{ user: { email: string | null } }>(
        `/api/v2/users/${userId}.json`,
      );
      const email = res.user.email ?? '';
      this.userEmailCache.set(userId, email);
      await sleep(RATE_LIMIT_DELAY_MS);
      return email || null;
    } catch {
      return null;
    }
  }

  private async get<T>(path: string): Promise<T> {
    return withRetry(
      async () => {
        const res = await fetch(`${this.baseUrl}${path}`, {
          headers: { Authorization: this.authHeader, Accept: 'application/json' },
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') ?? '1');
          await sleep(retryAfter * 1000);
          throw new HttpError(res.status, `Zendesk rate limited on ${path}`);
        }
        if (!res.ok) {
          throw new HttpError(res.status, `Zendesk ${res.status} on ${path}`);
        }
        return (await res.json()) as T;
      },
      {
        label: `zendesk.get ${path}`,
        maxAttempts: 3,
        baseDelayMs: 1000,
        isRetryable: (err) => err instanceof HttpError && isRetryableHttpStatus(err.status),
      },
    );
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Zendesk next_page is a full URL; we re-issue against baseUrl using its path. */
function pathOf(nextPage: string | null): string | null {
  if (!nextPage) return null;
  try {
    const u = new URL(nextPage);
    return u.pathname + u.search;
  } catch {
    return nextPage;
  }
}
