// Runs the full Milestone 1 ingestion path against one connector and prints the
// result. Usage:
//   npm run ingest -- --source=zendesk
//   npm run ingest -- --source=zendesk --limit=25     # pull only 25 this run
//   npm run ingest -- --source=imap --source-id=<uuid> --org-id=<uuid>
//
// --limit caps how many conversations are pulled, so you can verify the process
// on a small batch instead of sweeping a large backlog. Ingestion pulls
// NEWEST-FIRST and walks backwards in time; re-running continues further back,
// so repeated limited runs walk the history N at a time until it's exhausted.
//
// This script performs NO AI calls — it exercises ingestion only. It works with
// ANTHROPIC_API_KEY and OPENAI_API_KEY absent; if it fails without them, there
// is an undeclared AI dependency in the M1 path (a bug).

import '../src/lib/load-env.js';
import { ingestSource } from '../src/pipeline/ingest.js';
import { getServiceClient } from '../src/lib/supabase.js';
import { log } from '../src/lib/logger.js';

interface Args {
  source?: string;
  sourceId?: string;
  orgId?: string;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'source') args.source = v;
    if (k === 'source-id') args.sourceId = v;
    if (k === 'org-id') args.orgId = v;
    if (k === 'limit') {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--limit must be a positive integer');
      args.limit = n;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source && !args.sourceId) {
    throw new Error('Provide --source=zendesk|imap (uses seeded source) or --source-id=<uuid>');
  }

  const db = getServiceClient();
  let query = db.from('ingestion_sources').select('id, org_id, type, config').limit(1);
  if (args.sourceId) query = query.eq('id', args.sourceId);
  else if (args.source) query = query.eq('type', args.source);
  if (args.orgId) query = query.eq('org_id', args.orgId);

  const { data, error } = await query.single();
  if (error || !data) throw new Error(`No matching ingestion_sources row: ${error?.message ?? 'not found'}`);

  log.info('starting ingestion', { sourceId: data.id, type: data.type, limit: args.limit ?? null });
  const result = await ingestSource(
    {
      id: data.id as string,
      org_id: data.org_id as string,
      type: data.type as string,
      config: (data.config as Record<string, unknown>) ?? {},
    },
    { limit: args.limit },
  );
  log.info('ingestion finished', { ...result });
  // eslint-disable-next-line no-console
  console.log(
    `\nDone: ${result.inserted} staged, ${result.duplicatesSkipped} duplicates skipped.\n` +
      (result.backfillComplete
        ? 'Backfill complete — no older history left to pull.'
        : 'More history remains — re-run to pull the next (older) batch.'),
  );
}

main().catch((err) => {
  log.error('ingest script failed', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
