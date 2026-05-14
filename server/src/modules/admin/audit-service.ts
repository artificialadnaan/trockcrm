import { sql, SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { redactAuditFieldChangesForRole, type FormattedAuditFieldChange } from "../audit/field-formatters.js";
import type { UserRole } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export interface AuditLogFilter {
  entityType?: string;
  actorQuery?: string;
  action?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

export interface AuditLogRow {
  id: number;
  actorLabel: string;
  actorType: "user" | "system";
  action: string;
  entityType: string;
  entityName: string;
  entitySecondaryId: string | null;
  occurredAt: string;
  summary: string | null;
  fieldChanges: FormattedAuditFieldChange[];
  visibilityScope: "internal" | "customer_safe" | "role_restricted";
}

export async function getAuditLog(
  tenantDb: TenantDb,
  userRole: UserRole,
  filter: AuditLogFilter = {}
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;
  const conditions: SQL[] = [sql`1=1`];

  if (filter.entityType) {
    conditions.push(sql`al.entity_type = ${filter.entityType}`);
  }
  if (filter.actorQuery) {
    const pattern = `%${filter.actorQuery.trim()}%`;
    conditions.push(sql`COALESCE(al.actor_name, u.display_name, '') ILIKE ${pattern}`);
  }
  if (filter.action) {
    conditions.push(sql`al.action = ${filter.action}`);
  }
  if (filter.fromDate) {
    conditions.push(sql`al.created_at >= ${filter.fromDate}::timestamptz`);
  }
  if (filter.toDate) {
    conditions.push(sql`al.created_at <= (${filter.toDate}::date + INTERVAL '1 day')::timestamptz`);
  }

  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
  const countResult = await tenantDb.execute(
    sql`SELECT COUNT(*)::int AS total
        FROM audit_log al
        LEFT JOIN public.users u ON u.id = al.changed_by
        WHERE ${where}`
  );
  const countRows = ((countResult as unknown) as { rows?: Array<{ total: number }> }).rows ?? [];
  const total = Number(countRows[0]?.total ?? 0);

  const dataResult = await tenantDb.execute(sql`
    SELECT
      al.id,
      al.action,
      COALESCE(al.entity_type, al.table_name) AS entity_type,
      COALESCE(al.entity_name_snapshot, al.table_name || ':' || al.record_id) AS entity_name,
      al.entity_secondary_id_snapshot,
      COALESCE(al.actor_name, u.display_name, CASE WHEN al.actor_system_process IS NOT NULL THEN al.actor_system_process ELSE 'System' END) AS actor_label,
      CASE WHEN al.actor_system_process IS NOT NULL THEN 'system' ELSE 'user' END AS actor_type,
      al.field_changes_jsonb,
      al.visibility_scope,
      al.created_at
    FROM audit_log al
    LEFT JOIN public.users u ON u.id = al.changed_by
    WHERE ${where}
    ORDER BY al.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const dataRows = ((dataResult as unknown) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  return {
    rows: dataRows.map((row) => ({
      id: Number(row.id),
      actorLabel: String(row.actor_label ?? "System"),
      actorType: row.actor_type === "system" ? "system" : "user",
      action: String(row.action ?? "update"),
      entityType: String(row.entity_type ?? "record"),
      entityName: String(row.entity_name ?? "Record"),
      entitySecondaryId: row.entity_secondary_id_snapshot == null ? null : String(row.entity_secondary_id_snapshot),
      occurredAt: String(row.created_at),
      summary: null,
      fieldChanges: redactAuditFieldChangesForRole(
        Array.isArray(row.field_changes_jsonb) ? (row.field_changes_jsonb as FormattedAuditFieldChange[]) : [],
        userRole
      ),
      visibilityScope: (row.visibility_scope as AuditLogRow["visibilityScope"]) ?? "internal",
    })),
    total,
  };
}

export async function getAuditLogEntityTypes(tenantDb: TenantDb): Promise<string[]> {
  const result = await tenantDb.execute(
    sql`SELECT DISTINCT COALESCE(entity_type, table_name) AS entity_type
        FROM audit_log
        ORDER BY COALESCE(entity_type, table_name)`
  );
  const rows = ((result as unknown) as { rows?: Array<{ entity_type: string }> }).rows ?? [];
  return rows.map((row) => row.entity_type).filter(Boolean);
}
