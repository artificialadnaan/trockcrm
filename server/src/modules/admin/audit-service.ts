import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface AuditLogFilter {
  tableName?: string;
  recordId?: string;
  changedBy?: string;
  action?: "insert" | "update" | "delete";
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

export interface AuditLogRow {
  id: number;
  tableName: string;
  recordId: string;
  action: string;
  changedBy: string | null;
  changedByName: string | null;
  changes: Record<string, unknown>;
  fullRow: Record<string, unknown> | null;
  createdAt: string;
}

export async function getAuditLog(
  tenantDb: TenantDb,
  filter: AuditLogFilter = {}
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;

  // Build dynamic WHERE clauses
  const conditions: string[] = ["1=1"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filter.tableName) {
    conditions.push(`al.table_name = $${paramIdx++}`);
    params.push(filter.tableName);
  }
  if (filter.recordId) {
    conditions.push(`al.record_id = $${paramIdx++}`);
    params.push(filter.recordId);
  }
  if (filter.changedBy) {
    conditions.push(`al.changed_by = $${paramIdx++}`);
    params.push(filter.changedBy);
  }
  if (filter.action) {
    conditions.push(`al.action = $${paramIdx++}`);
    params.push(filter.action);
  }
  if (filter.fromDate) {
    conditions.push(`al.created_at >= $${paramIdx++}::timestamptz`);
    params.push(filter.fromDate);
  }
  if (filter.toDate) {
    conditions.push(`al.created_at <= ($${paramIdx++}::date + INTERVAL '1 day')::timestamptz`);
    params.push(filter.toDate);
  }

  const where = conditions.join(" AND ");

  // Count query
  const countResult = await tenantDb.execute(
    sql.raw(`SELECT COUNT(*)::int AS total FROM audit_log al WHERE ${where}`)
  );
  const countRows = (countResult as any).rows ?? countResult;
  const total = Number(countRows[0]?.total ?? 0);

  // Data query -- join to public.users for changed_by display name
  const dataResult = await tenantDb.execute(
    sql.raw(`
      SELECT
        al.id,
        al.table_name,
        al.record_id,
        al.action,
        al.changed_by,
        u.display_name AS changed_by_name,
        al.changes,
        al.full_row,
        al.created_at
      FROM audit_log al
      LEFT JOIN public.users u ON u.id = al.changed_by
      WHERE ${where}
      ORDER BY al.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `)
  );

  const dataRows = (dataResult as any).rows ?? dataResult;

  return {
    rows: dataRows.map((r: any): AuditLogRow => ({
      id: Number(r.id),
      tableName: r.table_name,
      recordId: r.record_id,
      action: r.action,
      changedBy: r.changed_by,
      changedByName: r.changed_by_name ?? null,
      changes: r.changes ?? {},
      fullRow: r.full_row ?? null,
      createdAt: r.created_at,
    })),
    total,
  };
}

/** Get distinct table names for the filter dropdown. */
export async function getAuditLogTables(tenantDb: TenantDb): Promise<string[]> {
  const result = await tenantDb.execute(
    sql`SELECT DISTINCT table_name FROM audit_log ORDER BY table_name`
  );
  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => r.table_name as string);
}
