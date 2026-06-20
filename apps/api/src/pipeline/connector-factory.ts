import type { Connector, ImapConfig, ZendeskConfig } from './connector.js';
import { ImapConnector } from './connectors/imap-connector.js';
import { ZendeskConnector } from './connectors/zendesk-connector.js';
import { decryptConfig } from '../lib/crypto.js';

// Instantiates the right Connector for an ingestion_sources row and decrypts its
// stored credentials. Kept separate from connector.ts (which holds the pure
// contract) to avoid a contract<->implementation import cycle.

export interface IngestionSourceRow {
  id: string;
  org_id: string;
  type: string;
  /** jsonb. Credentials inside are encrypted at the app layer (see crypto.ts). */
  config: Record<string, unknown>;
}

/** Phase 1 supports imap + zendesk. Other source types are Phase 2. */
export function createConnector(source: IngestionSourceRow): Connector {
  const config = decryptSourceConfig(source.config);
  switch (source.type) {
    case 'imap':
      return new ImapConnector(asImapConfig(config));
    case 'zendesk':
      return new ZendeskConnector(asZendeskConfig(config));
    default:
      throw new Error(`Unsupported connector type for Phase 1: ${source.type}`);
  }
}

// config.credentials holds the AES-GCM ciphertext; everything else is plaintext
// (host, port, subdomain, etc.). This keeps non-secret fields queryable while
// secrets stay encrypted at rest.
function decryptSourceConfig(config: Record<string, unknown>): Record<string, unknown> {
  const enc = config.credentials;
  if (typeof enc !== 'string') return config; // already plaintext (dev/seed)
  const decrypted = JSON.parse(decryptConfig(enc)) as Record<string, unknown>;
  const { credentials: _omit, ...rest } = config;
  return { ...rest, ...decrypted };
}

function asImapConfig(c: Record<string, unknown>): ImapConfig {
  return {
    host: str(c, 'host'),
    port: Number(c.port ?? 993),
    user: str(c, 'user'),
    password: str(c, 'password'),
    mailbox: typeof c.mailbox === 'string' ? c.mailbox : undefined,
  };
}

function asZendeskConfig(c: Record<string, unknown>): ZendeskConfig {
  return {
    subdomain: str(c, 'subdomain'),
    email: str(c, 'email'),
    apiToken: str(c, 'apiToken'),
  };
}

function str(c: Record<string, unknown>, key: string): string {
  const v = c[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Connector config missing required field: ${key}`);
  }
  return v;
}
