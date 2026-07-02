import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealHistory, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { DealDescriptionHistoryEntry } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

const DESCRIPTION_FIELD = "description";

/**
 * The deal_history row to record for a description edit, or null when nothing actually changed. Pure so
 * updateDeal writes a change-log row ONLY on a real change (null and undefined normalize to the same empty),
 * and the decision is unit-testable without a DB. `source: "deal_edit"` marks the origin for the display.
 */
export function buildDescriptionHistoryEntry(
  oldDescription: string | null | undefined,
  newDescription: string | null | undefined,
  changedBy: string,
): { fieldName: string; oldValue: string | null; newValue: string | null; changedBy: string; source: string } | null {
  const oldValue = oldDescription ?? null;
  const newValue = newDescription ?? null;
  if (oldValue === newValue) return null;
  return { fieldName: DESCRIPTION_FIELD, oldValue, newValue, changedBy, source: "deal_edit" };
}

/**
 * A deal's DESCRIPTION change-log, newest first, with the editor's display name resolved from the users
 * table (null when the user row is gone). Reads only field_name = "description" rows from the per-tenant
 * deal_history table, so unrelated field-change rows (project_type, etc.) never leak into the log.
 */
export async function listDealDescriptionHistory(
  tenantDb: TenantDb,
  dealId: string,
): Promise<DealDescriptionHistoryEntry[]> {
  const rows = await tenantDb
    .select({
      id: dealHistory.id,
      oldValue: dealHistory.oldValue,
      newValue: dealHistory.newValue,
      changedBy: dealHistory.changedBy,
      changedByName: users.displayName,
      source: dealHistory.source,
      changedAt: dealHistory.changedAt,
    })
    .from(dealHistory)
    .leftJoin(users, eq(users.id, dealHistory.changedBy))
    .where(and(eq(dealHistory.dealId, dealId), eq(dealHistory.fieldName, DESCRIPTION_FIELD)))
    .orderBy(desc(dealHistory.changedAt));

  return rows.map((row) => ({
    id: row.id,
    oldValue: row.oldValue ?? null,
    newValue: row.newValue ?? null,
    changedBy: row.changedBy ?? null,
    changedByName: row.changedByName ?? null,
    source: row.source ?? null,
    changedAt: row.changedAt instanceof Date ? row.changedAt.toISOString() : String(row.changedAt),
  }));
}
