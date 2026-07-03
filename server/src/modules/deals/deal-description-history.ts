import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealHistory, deals, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { DealDescriptionHistoryEntry } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

const DESCRIPTION_FIELD = "description";

/**
 * The deal's CURRENT deals.description, read under a row lock, for use as the BEFORE value of a history row.
 *
 * The description-history panel lives on the deal-detail overview, and getDealDetail renders the raw
 * deals.description column (it resolves bid_due_date from the source lead but NOT description) — so THAT
 * mirror is the value the panel shows for every deal, source-lead-backed or not. The log therefore tracks
 * deals.description uniformly. Reading it under FOR UPDATE before the write serializes concurrent same-deal
 * edits so a recorded old->new can't capture a stale intermediate (A->C instead of B->C). Call this BEFORE
 * the update, in the same transaction. Falls back to an unlocked read when the driver has no `.for` (test
 * mocks), which is harmless.
 */
export async function lockCurrentDealDescription(tenantDb: TenantDb, dealId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = tenantDb.select({ description: deals.description }).from(deals).where(eq(deals.id, dealId)).limit(1) as any;
  const rows = typeof q.for === "function" ? await q.for("update") : await q;
  return rows[0]?.description ?? null;
}

/**
 * The deal_history row to record for a description edit, or null when nothing actually changed. Pure so
 * updateDeal writes a change-log row ONLY on a real change (null and undefined normalize to the same empty),
 * and the decision is unit-testable without a DB. `source` marks the origin for the display ("deal_edit"
 * for the deal form, "scope_summary" for the scoping workspace's scope-summary write).
 */
export function buildDescriptionHistoryEntry(
  oldDescription: string | null | undefined,
  newDescription: string | null | undefined,
  changedBy: string,
  source = "deal_edit",
): { fieldName: string; oldValue: string | null; newValue: string | null; changedBy: string; source: string } | null {
  const oldValue = oldDescription ?? null;
  const newValue = newDescription ?? null;
  if (oldValue === newValue) return null;
  return { fieldName: DESCRIPTION_FIELD, oldValue, newValue, changedBy, source };
}

/**
 * Record a description change-log row if (and only if) the description actually changed — the single seam
 * every write path (updateDeal, scoping workspace, resolved-fields, change orders) funnels through, so the
 * build + skip-null + insert logic lives in ONE place. Runs in the caller's per-request transaction, so it
 * is atomic with the deal update (an audit-row failure rolls back the edit — deliberately all-or-nothing,
 * same as the sibling project_type history write). When `changedAt` is omitted the row is stamped with
 * clock_timestamp() (wall-clock at the INSERT statement) — NOT now()/transaction_timestamp(), which is the
 * transaction START time and would mis-order a request that began early then waited on the FOR UPDATE lock.
 * Since callers hold that lock until commit, the second committer's insert runs later and gets a strictly
 * later clock_timestamp(), so the newest-first panel can't render a stale intermediate ahead of the value
 * that superseded it.
 */
export async function recordDescriptionHistoryChange(
  tenantDb: TenantDb,
  args: {
    dealId: string;
    oldDescription: string | null | undefined;
    newDescription: string | null | undefined;
    changedBy: string;
    source?: string;
    changedAt?: Date;
  },
): Promise<void> {
  const entry = buildDescriptionHistoryEntry(args.oldDescription, args.newDescription, args.changedBy, args.source);
  if (!entry) return;
  await tenantDb.insert(dealHistory).values({
    dealId: args.dealId,
    ...entry,
    // Default to clock_timestamp() (statement wall-clock, post-lock) rather than now() (transaction start).
    changedAt: args.changedAt ?? sql`clock_timestamp()`,
  });
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
