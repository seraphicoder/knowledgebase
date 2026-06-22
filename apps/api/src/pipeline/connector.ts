// The connector contract. Every source — IMAP, Zendesk, and any future
// connector — implements `Connector` and normalizes its data into
// `RawConversation` before anything downstream touches it. NOTHING downstream of
// ingestion (reconstructor, noise filter, embedder, extractor) may contain
// source-specific logic. (Architecture Rule #6.)

export interface RawConversation {
  externalId: string;
  subject: string;
  participants: string[];
  messages: RawMessage[];
  metadata: Record<string, unknown>; // source-specific extras (ticket status, tags, headers, ...)
}

export interface RawMessage {
  author: string;
  body: string;
  timestamp: Date;
  /** Optional threading headers (IMAP). Connectors omit when not applicable. */
  messageId?: string;
  inReplyTo?: string;
  /** Image attachments captured with their bytes; stored after the thread is. */
  attachments?: RawAttachment[];
}

export interface RawAttachment {
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  data: Buffer; // raw bytes — uploaded to Supabase Storage by the attachment step
}

export interface FetchOptions {
  /**
   * Cap the number of conversations pulled in this run. Used to walk a large
   * backlog in batches instead of one sweep. Connectors must stop fetching once
   * the cap is reached, not fetch everything and truncate.
   */
  limit?: number;
}

export interface FetchPage {
  conversations: RawConversation[];
  /**
   * Forward high-water mark to persist (ingestion_sources.sync_cursor) and pass
   * back on the next run to fetch records created AFTER this point. It always
   * advances forward — at the end of history it points just past the last record,
   * so a later call returns only genuinely-new records. null only when the source
   * has no records at all.
   */
  nextCursor: string | null;
  /** True if more records remain beyond this page right now (the `limit` cap was
   * hit with more available). False once the current end of history is reached. */
  hasMore: boolean;
}

export interface Connector {
  type: string; // 'imap' | 'zendesk' | ...
  /**
   * Forward sync: pulls conversations created AFTER `cursor`, oldest-of-the-new
   * first, up to `options.limit`. `cursor` is the opaque token from the previous
   * call (null to start from the beginning of history). Returns the records plus
   * an advanced `nextCursor` and whether more remain right now (`hasMore`).
   *
   * Run repeatedly: it walks forward through all history, then parks at the end —
   * subsequent calls fetch only records newer than everything seen so far.
   */
  fetchConversations(cursor: string | null, options?: FetchOptions): Promise<FetchPage>;
  testConnection(): Promise<boolean>;
}

// ─── Per-source credential shapes (decrypted from ingestion_sources.config) ──

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Mailbox/folder to poll. Defaults to INBOX. */
  mailbox?: string;
}

export interface ZendeskConfig {
  subdomain: string;
  email: string;
  apiToken: string;
}

export type SourceType = 'imap' | 'zendesk' | 'graph_api' | 'pst_upload' | 'mbox_upload' | 'eml_upload';

export interface SourceConfigMap {
  imap: ImapConfig;
  zendesk: ZendeskConfig;
}
