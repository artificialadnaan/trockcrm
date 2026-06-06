import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealChangeOrders, deals, pipelineStageConfig } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { isGenuineWonDealStageSlug } from "@trock-crm/shared/types";
import { createChangeOrderChildDeal } from "./change-order-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface LegacyChangeOrderMigrationResult {
  totalRows: number;
  /** Rows whose parent is eligible — these WOULD migrate (dry-run) / DID migrate (execute). */
  eligibleCount: number;
  eligibleAmount: string;
  /** Rows whose parent is ineligible (soft-deleted / not Won-or-BBO / itself a CO) — skipped + reported. */
  skippedCount: number;
  skippedAmount: string;
  /** Execute-only: rows actually converted to child deals + their legacy row deleted. */
  migrated: number;
  /** Execute-only: eligible rows that threw during conversion (transaction rolled back, legacy row kept). */
  failedCount: number;
  failedIds: string[];
}

/** Add two non-negative money strings as integer cents via BigInt — exact at any magnitude. */
export function addMoney(acc: string, amount: string | null): string {
  const toCents = (s: string): bigint => {
    const [intPart, frac = ""] = (s || "0").split(".");
    return BigInt(intPart || "0") * 100n + BigInt((frac + "00").slice(0, 2) || "0");
  };
  const cents = toCents(acc) + toCents(amount ?? "0");
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * One-time migration: convert legacy `deal_change_orders` rows into real CO CHILD deals (the #657 model),
 * deleting each legacy row as its child is created. Reuses createChangeOrderChildDeal so a migrated CO is
 * byte-identical to a freshly-created one, WITHOUT firing commission (historical COs do not retroactively
 * earn commission — only the live add path does).
 *
 * Per-row transaction: createChild + delete-legacy-row are atomic (no transient double-count where both a
 * child AND the legacy row exist), and one bad row never aborts the rest.
 *
 * GOAL = FIX FORWARD: leave ZERO legacy deal_change_orders rows. Eligibility mirrors
 * loadParentForChildCreate (parent ACTIVE, not itself a CO, Bid-Board-owned or in a genuine Won stage).
 * Ineligible rows (e.g. a soft-deleted parent) are reported as BLOCKERS — not silently left — so they get
 * resolved (reactivate the parent, or handle the orphan) before the table is considered empty. In practice
 * COs live on active Won/BBO deals, so blockers are expected to be ZERO; the dry-run proves it per office.
 *
 * dryRun: classify-only, NO writes — returns the N child deals + $ that WOULD migrate, plus any blockers,
 * for sign-off. A clean fix-forward = eligibleCount == totalRows (skippedCount 0) on every office.
 *
 * WINDOWLESS: run --execute against prod while the #650 fold is STILL live. Each CO is counted exactly once
 * throughout — a remaining legacy row (via the fold) OR a child deal (via canonical Won), never both, since
 * the row is deleted in the same transaction that creates the child. Deploy the fold-removal AFTER execute
 * completes; it is then a no-op on the emptied table. No double-count or vanish window.
 */
export async function migrateLegacyChangeOrders(
  tenantDb: TenantDb,
  opts: { dryRun: boolean }
): Promise<LegacyChangeOrderMigrationResult> {
  const rows = await tenantDb
    .select({
      id: dealChangeOrders.id,
      dealId: dealChangeOrders.dealId,
      signedDate: dealChangeOrders.signedDate,
      amount: dealChangeOrders.amount,
      description: dealChangeOrders.description,
      createdBy: dealChangeOrders.createdBy,
      parentActive: deals.isActive,
      parentIsChangeOrder: deals.isChangeOrder,
      parentBidBoardOwned: deals.isBidBoardOwned,
      parentRoute: deals.workflowRoute,
      parentStageSlug: pipelineStageConfig.slug,
    })
    .from(dealChangeOrders)
    .leftJoin(deals, eq(deals.id, dealChangeOrders.dealId))
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId));

  type Row = (typeof rows)[number];
  const eligible = (r: Row): boolean =>
    r.parentActive === true &&
    r.parentIsChangeOrder === false &&
    (r.parentBidBoardOwned === true ||
      isGenuineWonDealStageSlug(r.parentStageSlug, r.parentRoute ?? null));

  const result: LegacyChangeOrderMigrationResult = {
    totalRows: rows.length,
    eligibleCount: 0,
    eligibleAmount: "0.00",
    skippedCount: 0,
    skippedAmount: "0.00",
    migrated: 0,
    failedCount: 0,
    failedIds: [],
  };
  for (const r of rows) {
    if (eligible(r)) {
      result.eligibleCount++;
      result.eligibleAmount = addMoney(result.eligibleAmount, r.amount);
    } else {
      result.skippedCount++;
      result.skippedAmount = addMoney(result.skippedAmount, r.amount);
    }
  }

  if (opts.dryRun) return result;

  for (const r of rows) {
    if (!eligible(r)) continue;
    try {
      await tenantDb.transaction(async (tx) => {
        await createChangeOrderChildDeal(tx as unknown as TenantDb, {
          parentDealId: r.dealId as string,
          signedDate: r.signedDate,
          amount: r.amount,
          description: r.description,
          // Preserve the original author; null (system) when the legacy row had none. NOT a fake UUID
          // (deals.created_by_user_id is FK-constrained), and no commission is fired by this path.
          createdBy: r.createdBy ?? null,
        });
        await tx.delete(dealChangeOrders).where(eq(dealChangeOrders.id, r.id));
      });
      result.migrated++;
    } catch (err) {
      result.failedCount++;
      result.failedIds.push(r.id);
      console.error(`[co-migration] failed to migrate legacy change order ${r.id} (parent ${r.dealId}):`, err);
    }
  }

  return result;
}
