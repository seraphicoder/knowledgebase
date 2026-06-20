import { Hono } from 'hono';
import { requireAuth, type AuthVars } from '../lib/auth.js';
import { runPipeline } from '../pipeline/pipeline-runner.js';
import { log } from '../lib/logger.js';

// Manual pipeline trigger ("Process Approved Threads"). Consistent with the
// human-in-the-loop model — Phase 1 has no automatic cron. Only the org's own
// approved threads are ever processed (runPipeline filters by org_id + the gate).

export const pipeline = new Hono<{ Variables: AuthVars }>();
pipeline.use('*', requireAuth);

pipeline.post('/pipeline/run', async (c) => {
  const { orgId, role } = c.get('auth');
  if (role !== 'admin' && role !== 'reviewer') {
    return c.json({ error: 'Only admins or reviewers can run the pipeline' }, 403);
  }
  try {
    const stats = await runPipeline(orgId);
    return c.json({ ok: true, stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('pipeline run failed', { orgId, error: message });
    return c.json({ error: message }, 500);
  }
});
