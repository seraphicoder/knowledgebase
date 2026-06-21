import { Hono } from 'hono';
import { z } from 'zod';
import { getServiceClient } from '../lib/supabase.js';
import { writeAudit } from '../lib/audit.js';
import { requirePlatformAdmin } from '../lib/auth.js';
import { provisionUser } from '../lib/provision.js';

// Vendor (super-admin) console — cross-org. Orgs are vendor-provisioned here:
// create an org + its first admin, list orgs with usage, and suspend/reactivate.
// Gated by requirePlatformAdmin (independent of org membership).

export const platform = new Hono<{ Variables: { platformUserId: string } }>();
// IMPORTANT: scope to /platform/* — all routers mount at /api, so a `use('*')`
// here registers as /api/* and would leak onto sibling routes (e.g. analytics),
// blocking non-platform admins. Scoping keeps the guard on platform paths only.
platform.use('/platform/*', requirePlatformAdmin);

const PLANS = ['starter', 'pro', 'enterprise'] as const;

// ─── GET /api/platform/orgs — list orgs + usage counts ──────
platform.get('/platform/orgs', async (c) => {
  const db = getServiceClient();
  const { data: orgs, error } = await db
    .from('organizations')
    .select('id, name, plan, suspended, created_at')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);

  // Per-org counts. Small org counts make N head-queries acceptable; revisit with
  // a single grouped RPC if the org list grows large.
  const withCounts = await Promise.all(
    (orgs ?? []).map(async (o) => {
      const id = o.id as string;
      const [users, threads, articles] = await Promise.all([
        db.from('users').select('id', { count: 'exact', head: true }).eq('org_id', id),
        db.from('email_threads').select('id', { count: 'exact', head: true }).eq('org_id', id),
        db.from('kb_articles').select('id', { count: 'exact', head: true }).eq('org_id', id),
      ]);
      return {
        ...o,
        user_count: users.count ?? 0,
        thread_count: threads.count ?? 0,
        article_count: articles.count ?? 0,
      };
    }),
  );
  return c.json({ orgs: withCounts });
});

// ─── POST /api/platform/orgs — create org + first admin ─────
const createSchema = z.object({
  name: z.string().trim().min(1, 'Org name is required'),
  adminEmail: z.string().email(),
  plan: z.enum(PLANS).default('starter'),
});

platform.post('/platform/orgs', async (c) => {
  const platformUserId = c.get('platformUserId');
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
  const db = getServiceClient();

  const { data: org, error: orgErr } = await db
    .from('organizations')
    .insert({ name: parsed.data.name, plan: parsed.data.plan })
    .select('id, name, plan, suspended, created_at')
    .single();
  if (orgErr || !org) return c.json({ error: orgErr?.message ?? 'Failed to create org' }, 500);

  const orgId = org.id as string;
  try {
    const { userId: adminId, tempPassword } = await provisionUser(db, {
      email: parsed.data.adminEmail,
      orgId,
      role: 'admin',
    });
    await writeAudit({
      orgId, userId: platformUserId, action: 'org.created', resource: 'organizations', resourceId: orgId,
      metadata: { name: parsed.data.name, adminEmail: parsed.data.adminEmail.toLowerCase() },
    });
    return c.json({ org: { ...org, user_count: 1, thread_count: 0, article_count: 0 }, adminEmail: parsed.data.adminEmail.toLowerCase(), tempPassword });
  } catch (e) {
    // Provisioning the admin failed — remove the empty org we just created.
    await db.from('organizations').delete().eq('id', orgId);
    return c.json({ error: e instanceof Error ? e.message : 'Failed to create admin' }, 400);
  }
});

// ─── GET /api/platform/analytics — cross-org cost/usage ─────
// Raw token counts (no $ conversion), storage proxy (summed attachment bytes),
// and ingestion, both last-30-days and all-time, with a per-org breakdown.
interface UsageRow {
  org_id: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

function summarize(rows: UsageRow[]) {
  const byModel = new Map<string, { provider: string; model: string; input: number; output: number; calls: number }>();
  let totalInput = 0, totalOutput = 0, totalCalls = 0;
  for (const r of rows) {
    const i = Number(r.input_tokens), o = Number(r.output_tokens), n = Number(r.calls);
    totalInput += i; totalOutput += o; totalCalls += n;
    const key = `${r.provider}:${r.model}`;
    const e = byModel.get(key) ?? { provider: r.provider, model: r.model, input: 0, output: 0, calls: 0 };
    e.input += i; e.output += o; e.calls += n;
    byModel.set(key, e);
  }
  return {
    totalInput, totalOutput, totalCalls,
    byModel: [...byModel.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
  };
}

function perOrgUsage(rows: UsageRow[]): Map<string, { input: number; output: number; calls: number }> {
  const m = new Map<string, { input: number; output: number; calls: number }>();
  for (const r of rows) {
    if (!r.org_id) continue;
    const e = m.get(r.org_id) ?? { input: 0, output: 0, calls: 0 };
    e.input += Number(r.input_tokens); e.output += Number(r.output_tokens); e.calls += Number(r.calls);
    m.set(r.org_id, e);
  }
  return m;
}

platform.get('/platform/analytics', async (c) => {
  const db = getServiceClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [orgsRes, u30, uAll, storage, i30, iAll] = await Promise.all([
    db.from('organizations').select('id, name'),
    db.rpc('ai_usage_summary', { p_since: since }),
    db.rpc('ai_usage_summary', {}),
    db.rpc('storage_by_org', {}),
    db.rpc('ingestion_by_org', { p_since: since }),
    db.rpc('ingestion_by_org', {}),
  ]);

  const rows30 = (u30.data ?? []) as UsageRow[];
  const rowsAll = (uAll.data ?? []) as UsageRow[];
  const usage30 = perOrgUsage(rows30);
  const usageAll = perOrgUsage(rowsAll);
  const storageMap = new Map<string, { bytes: number; files: number }>(
    ((storage.data ?? []) as { org_id: string; bytes: number; files: number }[]).map(
      (s) => [s.org_id, { bytes: Number(s.bytes), files: Number(s.files) }] as [string, { bytes: number; files: number }],
    ),
  );
  const ing30 = new Map<string, number>(
    ((i30.data ?? []) as { org_id: string; threads: number }[]).map((r) => [r.org_id, Number(r.threads)] as [string, number]),
  );
  const ingAll = new Map<string, number>(
    ((iAll.data ?? []) as { org_id: string; threads: number }[]).map((r) => [r.org_id, Number(r.threads)] as [string, number]),
  );

  const byOrg = ((orgsRes.data ?? []) as { id: string; name: string }[]).map((o) => {
    const u30o = usage30.get(o.id) ?? { input: 0, output: 0, calls: 0 };
    const uAllo = usageAll.get(o.id) ?? { input: 0, output: 0, calls: 0 };
    const s = storageMap.get(o.id);
    return {
      id: o.id,
      name: o.name,
      input30: u30o.input, output30: u30o.output, calls30: u30o.calls,
      inputAll: uAllo.input, outputAll: uAllo.output, callsAll: uAllo.calls,
      storageBytes: Number(s?.bytes ?? 0),
      files: Number(s?.files ?? 0),
      threads30: ing30.get(o.id) ?? 0,
      threadsAll: ingAll.get(o.id) ?? 0,
    };
  });

  const storageTotalBytes = byOrg.reduce((a, o) => a + o.storageBytes, 0);
  const storageTotalFiles = byOrg.reduce((a, o) => a + o.files, 0);
  const threads30Total = byOrg.reduce((a, o) => a + o.threads30, 0);
  const threadsAllTotal = byOrg.reduce((a, o) => a + o.threadsAll, 0);

  return c.json({
    last30: summarize(rows30),
    allTime: summarize(rowsAll),
    storageTotalBytes,
    storageTotalFiles,
    threads30Total,
    threadsAllTotal,
    byOrg: byOrg.sort((a, b) => b.inputAll + b.outputAll - (a.inputAll + a.outputAll)),
  });
});

// ─── PATCH /api/platform/orgs/:id — suspend / reactivate ────
const patchSchema = z.object({ suspended: z.boolean() });

platform.patch('/platform/orgs/:id', async (c) => {
  const platformUserId = c.get('platformUserId');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing org id' }, 400);
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400);
  const db = getServiceClient();

  const { data, error } = await db
    .from('organizations')
    .update({ suspended: parsed.data.suspended })
    .eq('id', id)
    .select('id')
    .single();
  if (error || !data) return c.json({ error: error?.message ?? 'Org not found' }, 404);

  await writeAudit({
    orgId: id, userId: platformUserId,
    action: parsed.data.suspended ? 'org.suspended' : 'org.reactivated',
    resource: 'organizations', resourceId: id,
  });
  return c.json({ ok: true, suspended: parsed.data.suspended });
});
