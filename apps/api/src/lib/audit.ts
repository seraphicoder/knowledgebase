import { getServiceClient } from './supabase.js';
import { log } from './logger.js';

// Append-only audit logging. Every create/update/delete/export writes here.
// The audit_log table has no UPDATE/DELETE policy, so these rows are immutable.

export interface AuditEntry {
  orgId: string;
  userId?: string | null; // null = system action
  action: string; // e.g. 'thread.staged', 'thread.approved', 'extraction.created'
  resource: string; // table name
  resourceId: string; // affected row id
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  const { error } = await getServiceClient().from('audit_log').insert({
    org_id: entry.orgId,
    user_id: entry.userId ?? null,
    action: entry.action,
    resource: entry.resource,
    resource_id: entry.resourceId,
    metadata: entry.metadata ?? null,
    ip_address: entry.ipAddress ?? null,
  });
  // Audit failures must be visible but must not crash the caller's operation.
  if (error) log.error('audit write failed', { action: entry.action, error: error.message });
}

export async function writeAuditBatch(entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((e) => ({
    org_id: e.orgId,
    user_id: e.userId ?? null,
    action: e.action,
    resource: e.resource,
    resource_id: e.resourceId,
    metadata: e.metadata ?? null,
    ip_address: e.ipAddress ?? null,
  }));
  const { error } = await getServiceClient().from('audit_log').insert(rows);
  if (error) log.error('audit batch write failed', { count: rows.length, error: error.message });
}
