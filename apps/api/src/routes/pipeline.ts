import { Hono } from 'hono';
import { requireAuth, type AuthVars } from '../lib/auth.js';
import { getServiceClient } from '../lib/supabase.js';
import { runPipeline } from '../pipeline/pipeline-runner.js';
import { limitBlock } from '../lib/limits.js';
import { log } from '../lib/logger.js';

// Manual pipeline trigger ("Process Queued Threads"). Consistent with the
// human-in-the-loop model — Phase 1 has no automatic cron. Only the org's own
// queued threads are ever processed (runPipeline filters by org_id + the gate).
//
// The run executes OFF-REQUEST (returns 202 immediately) so a large batch can't
// outlast the HTTP proxy timeout. Progress is polled via /pipeline/status.

export const pipeline = new Hono<{ Variables: AuthVars }>();
pipeline.use('*', requireAuth);

const RUN_ROLES = new Set(['admin', 'reviewer', 'sme', 'member']);

// In-memory per-org guard so two runs don't overlap. Single-instance only — a
// run in flight during a redeploy is lost (acceptable without a job queue).
const running = new Set<string>();

pipeline.post('/pipeline/run', async (c) => {
  const { orgId, role } = c.get('auth');
  if (!RUN_ROLES.has(role)) return c.json({ error: 'Not permitted' }, 403);
  if (running.has(orgId)) return c.json({ ok: true, started: false, alreadyRunning: true });

  // Extraction is the heaviest AI consumer — gate on the monthly token cap.
  const blocked = await limitBlock(orgId, ['tokens']);
  if (blocked) return c.json({ error: blocked }, 403);

  running.add(orgId);
  // Fire-and-forget: respond now, process in the background.
  void runPipeline(orgId)
    .catch((err) => log.error('pipeline run failed', { orgId, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => running.delete(orgId));

  return c.json({ ok: true, started: true }, 202);
});

// Poll target: is a run in progress, and what were the last finished stats?
pipeline.get('/pipeline/status', async (c) => {
  const { orgId } = c.get('auth');
  const { data } = await getServiceClient()
    .from('audit_log')
    .select('action, metadata, created_at')
    .eq('org_id', orgId)
    .in('action', ['pipeline.run_started', 'pipeline.run_finished'])
    .order('created_at', { ascending: false })
    .limit(1);

  const last = data?.[0];
  const lastFinished =
    last && last.action === 'pipeline.run_finished'
      ? { stats: last.metadata, at: last.created_at }
      : null;
  return c.json({ running: running.has(orgId), lastFinished });
});
