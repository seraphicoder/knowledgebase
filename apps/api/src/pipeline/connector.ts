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
   * Cap the number of conversations pulled in this run. Used to verify the
   * pipeline on a small batch instead of sweeping a large backlog at once.
   * Connectors must stop fetching early once the cap is reached, not fetch
   * everything and truncate.
   */
  limit?: number;
}

export interface FetchPage {
  /** Newest-first: the most recent conversations are at the front. */
  conversations: RawConversation[];
  /**
   * Opaque, connector-defined token to resume the backfill on the next run,
   * continuing FURTHER BACK in time. null means there is no older history left
   * (backfill complete).
   */
  nextCursor: string | null;
}

export interface Connector {
  type: string; // 'imap' | 'zendesk' | ...
  /**
   * Pulls a page of conversations newest-first, walking backwards in time.
   * `cursor` is the opaque token returned by the previous call (null to start
   * from the newest record). Connectors return conversations ordered newest →
   * oldest plus the cursor to continue further back.
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
