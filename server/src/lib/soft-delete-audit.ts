import type { Request } from "express";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type { AuditLogEntry } from "./audit-log.js";
import { writeAuditLog } from "./audit-log.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface SoftDeleteAuditInput {
  actorUserId: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function requestAuditContext(req: Request) {
  const userAgentHeader = req.headers["user-agent"];
  return {
    ipAddress: req.ip ?? null,
    userAgent: Array.isArray(userAgentHeader) ? userAgentHeader.join(", ") : userAgentHeader ?? null,
  };
}

export function buildSoftDeleteAuditEntry(input: SoftDeleteAuditInput): AuditLogEntry {
  return {
    tableName: input.entityType,
    recordId: input.entityId,
    action: "soft_delete",
    changedBy: input.actorUserId,
    changes: {
      deleted: { from: false, to: true },
    },
    fullRow: input.reason ? { reason: input.reason } : null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  };
}

export async function writeSoftDeleteAuditLog(
  tenantDb: TenantDb,
  input: SoftDeleteAuditInput
): Promise<void> {
  await writeAuditLog(tenantDb, buildSoftDeleteAuditEntry(input));
}
