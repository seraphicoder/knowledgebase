import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Connector, FetchOptions, FetchPage, ImapConfig, RawConversation, RawMessage } from '../connector.js';
import { withRetry } from '../../lib/retry.js';
import { log } from '../../lib/logger.js';

// IMAP connector. Each email becomes one RawConversation here; grouping emails
// into multi-message threads happens later in thread-reconstructor.ts using the
// Message-ID / In-Reply-To headers we attach to each message.

export class ImapConnector implements Connector {
  readonly type = 'imap';

  constructor(private readonly config: ImapConfig) {}

  private newClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true, // always TLS — port 993 (kickoff confirmed)
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    });
  }

  async testConnection(): Promise<boolean> {
    const client = this.newClient();
    try {
      await client.connect();
      await client.logout();
      return true;
    } catch (err) {
      log.error('IMAP testConnection failed', {
        host: this.config.host,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async fetchConversations(cursor: string | null, options?: FetchOptions): Promise<FetchPage> {
    return withRetry(() => this.fetchOnce(cursor, options?.limit), {
      label: 'imap.fetch',
      maxAttempts: 3,
      baseDelayMs: 1000,
    });
  }

  // Newest-first by UID. The cursor is the lowest UID ingested so far; each run
  // takes the newest `limit` messages older than it and reports the next cursor
  // to continue further back. null cursor = start from the newest message.
  private async fetchOnce(cursor: string | null, limit?: number): Promise<FetchPage> {
    const client = this.newClient();
    const conversations: RawConversation[] = [];
    await client.connect();
    const lock = await client.getMailboxLock(this.config.mailbox ?? 'INBOX');
    let nextCursor: string | null = null;
    try {
      const allUids = (await client.search({ all: true }, { uid: true })) || [];
      const cursorUid = cursor ? Number(cursor) : Infinity;
      const candidates = allUids.filter((u) => u < cursorUid).sort((a, b) => b - a); // newest first
      const take = limit !== undefined ? candidates.slice(0, limit) : candidates;

      if (take.length > 0) {
        for await (const msg of client.fetch(take.join(','), { source: true, envelope: true }, { uid: true })) {
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const timestamp = parsed.date ?? msg.envelope?.date ?? new Date();
          const author = parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? 'unknown';

          const message: RawMessage = {
            author,
            body: (parsed.text ?? stripHtml(parsed.html || '')).trim(),
            timestamp,
            messageId: parsed.messageId,
            inReplyTo: firstInReplyTo(parsed.inReplyTo),
          };

          conversations.push({
            externalId: parsed.messageId ?? `${msg.uid}@${this.config.host}`,
            subject: parsed.subject ?? '(no subject)',
            participants: collectAddresses(parsed),
            messages: [message],
            metadata: {
              uid: msg.uid,
              references: parsed.references ?? null,
              inReplyTo: message.inReplyTo ?? null,
              autoResponseSuppress: parsed.headers.get('x-auto-response-suppress') ?? null,
            },
          });
        }
        // IMAP fetch may return in ascending order — enforce newest-first.
        conversations.sort((a, b) => b.messages[0]!.timestamp.getTime() - a.messages[0]!.timestamp.getTime());
        // More history remains only if we capped a larger candidate set.
        const lowestTaken = take[take.length - 1]!;
        nextCursor = candidates.length > take.length ? String(lowestTaken) : null;
      }
    } finally {
      lock.release();
      await client.logout();
    }
    log.info('IMAP fetch complete', { count: conversations.length, cursor, nextCursor });
    return { conversations, nextCursor };
  }
}

function collectAddresses(parsed: import('mailparser').ParsedMail): string[] {
  type AddressObject = import('mailparser').AddressObject;
  const out = new Set<string>();
  const add = (field: AddressObject | AddressObject[] | undefined) => {
    const list = Array.isArray(field) ? field : field ? [field] : [];
    for (const a of list) for (const v of a.value) if (v.address) out.add(v.address);
  };
  add(parsed.from);
  add(parsed.to);
  add(parsed.cc);
  return [...out];
}

function firstInReplyTo(inReplyTo: string | string[] | undefined): string | undefined {
  if (!inReplyTo) return undefined;
  return Array.isArray(inReplyTo) ? inReplyTo[0] : inReplyTo;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}
