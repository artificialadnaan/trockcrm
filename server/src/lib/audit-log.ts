import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditLog } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { AuditAction } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export interface AuditLogEntry {
  tableName: string;
  recordId: string;
  action: AuditAction;
  changedBy: string | null;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  fullRow?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Insert one row into the per-tenant audit_log table.
 *
 * Use for any field-level change you want a forensic record of —
 * commission-bearing fields (contract_signed_date), role changes,
 * financial milestones, anything where "who set this and when" matters
 * later. Cheap (single insert), idempotent at the caller's discretion
 * (caller decides whether a no-op transition warrants a row).
 */
export async function writeAuditLog(tenantDb: TenantDb, entry: AuditLogEntry): Promise<void> {
  await tenantDb.insert(auditLog).values({
    tableName: entry.tableName,
    recordId: entry.recordId,
    action: entry.action,
    changedBy: entry.changedBy,
    changes: entry.changes ?? null,
    fullRow: entry.fullRow ?? null,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  });
}
