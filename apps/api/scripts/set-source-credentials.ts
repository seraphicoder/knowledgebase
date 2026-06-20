import '../src/lib/load-env.js';
import { getServiceClient } from '../src/lib/supabase.js';
import { encryptConfig } from '../src/lib/crypto.js';
import { createConnector } from '../src/pipeline/connector-factory.js';
import { log } from '../src/lib/logger.js';

// Encrypts a source's credentials (from .env) and writes them to
// ingestion_sources.config, then verifies the connection. Run once per source
// before `npm run ingest`. Usage:
//   npm run set-creds -- --source=zendesk
//   npm run set-creds -- --source=imap
//   npm run set-creds -- --source-id=<uuid>     # target an exact row
//
// Non-secret fields (subdomain, host, port) are stored as plaintext jsonb so
// they stay queryable; only the actual secrets are AES-256-GCM encrypted into
// config.credentials. Requires CONFIG_ENCRYPTION_KEY to be set.

interface Args {
  source?: string;
  sourceId?: string;
  orgId?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'source') args.source = v;
    if (k === 'source-id') args.sourceId = v;
    if (k === 'org-id') args.orgId = v;
  }
  return args;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env — needed to set credentials for this source`);
  return v;
}

/** Returns { plaintext config fields, secret fields to encrypt }. */
function buildConfig(type: string): { plaintext: Record<string, unknown>; secrets: Record<string, unknown> } {
  switch (type) {
    case 'zendesk':
      return {
        plaintext: { subdomain: req('ZENDESK_SUBDOMAIN') },
        secrets: { email: req('ZENDESK_EMAIL'), apiToken: req('ZENDESK_API_TOKEN') },
      };
    case 'imap':
      return {
        plaintext: {
          host: req('IMAP_HOST'),
          port: Number(process.env.IMAP_PORT ?? 993),
          ...(process.env.IMAP_MAILBOX ? { mailbox: process.env.IMAP_MAILBOX } : {}),
        },
        secrets: { user: req('IMAP_USER'), password: req('IMAP_PASSWORD') },
      };
    default:
      throw new Error(`Unsupported source type for credential setup: ${type}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source && !args.sourceId) {
    throw new Error('Provide --source=zendesk|imap or --source-id=<uuid>');
  }

  const db = getServiceClient();
  let lookup = db.from('ingestion_sources').select('id, org_id, type').limit(1);
  if (args.sourceId) lookup = lookup.eq('id', args.sourceId);
  else if (args.source) lookup = lookup.eq('type', args.source);
  if (args.orgId) lookup = lookup.eq('org_id', args.orgId);

  const { data: src, error } = await lookup.single();
  if (error || !src) throw new Error(`No matching ingestion_sources row: ${error?.message ?? 'not found'}`);

  const type = src.type as string;
  const { plaintext, secrets } = buildConfig(type);
  const config = { ...plaintext, credentials: encryptConfig(JSON.stringify(secrets)) };

  const { error: upErr } = await db
    .from('ingestion_sources')
    .update({ config, status: 'active' })
    .eq('id', src.id);
  if (upErr) throw new Error(`Failed to write config: ${upErr.message}`);

  log.info('credentials written', { sourceId: src.id, type });

  // Verify the round-trip + live connection.
  const connector = createConnector({
    id: src.id as string,
    org_id: src.org_id as string,
    type,
    config,
  });
  const ok = await connector.testConnection();
  // eslint-disable-next-line no-console
  console.log(
    ok
      ? `\n✓ Credentials saved and ${type} connection verified for source ${src.id}.`
      : `\n⚠ Credentials saved for source ${src.id}, but the ${type} connection test FAILED — check the values in .env.`,
  );
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  log.error('set-creds failed', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
