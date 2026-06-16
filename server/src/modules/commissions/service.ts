import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  dealSignedCommissions,
  deals,
  userCommissionSettings,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { writeAuditLog } from "../../lib/audit-log.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type CommissionSourceValueKind = "awarded_amount" | "bid_estimate" | "dd_estimate";

export type CalculateCommissionStatus =
  | "created"
  | "skipped_existing"
  | "skipped_no_rep"
  | "skipped_no_value"
  | "skipped_no_rate";

export interface CalculateCommissionResult {
  status: CalculateCommissionStatus;
  commissionId?: string;
  amount?: string;
  appliedRate?: string;
  sourceValueAmount?: string;
  sourceValueKind?: CommissionSourceValueKind;
}

interface ResolvedSourceValue {
  amount: string;
  kind: CommissionSourceValueKind;
}

function resolveSourceValue(deal: {
  awardedAmount: string | null;
  bidEstimate: string | null;
  ddEstimate: string | null;
}): ResolvedSourceValue | null {
  // Preference order: awardedAmount → bidEstimate → ddEstimate. The first
  // non-null wins. This matches "the actual signed contract amount, with
  // the most recent estimate as a fallback if the awarded amount wasn't
  // recorded before contract signing."
  if (deal.awardedAmount != null) return { amount: deal.awardedAmount, kind: "awarded_amount" };
  if (deal.bidEstimate != null) return { amount: deal.bidEstimate, kind: "bid_estimate" };
  if (deal.ddEstimate != null) return { amount: deal.ddEstimate, kind: "dd_estimate" };
  return null;
}

function multiplyDecimalStrings(value: string, rate: string): string {
  // Source amount is NUMERIC(14,2); rate is NUMERIC(7,6). The product fits
  // a JS number well below the precision-loss threshold for relevant deal
  // sizes (a $100M deal × 1.0 rate = 1e8, well under 2^53). Rounding to
  // 2 decimal places matches the destination column scale.
  const product = Number(value) * Number(rate);
  return product.toFixed(2);
}

/**
 * Calculate the earned commission row for a deal that just had contract
 * signing recorded. During the stage-v2 transition the caller passes the date
 * portion used for deal_signed_commissions.contract_signed_date_at_signing.
 * Idempotent at the (deal_id, rep_user_id)
 * level — second call returns 'skipped_existing' without inserting.
 *
 * Returns a status discriminator instead of throwing for "skip" cases so
 * callers can keep the deal-update transaction green even when the deal
 * has no rep / no rate / no value yet. Hard errors (DB failure, invalid
 * input) propagate.
 *
 * MUST run inside the same transaction as the deal update so a failure
 * after the deal write can roll back both. Caller passes the tx-bound
 * tenantDb instance.
 */
export async function calculateCommissionForDeal(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    contractSignedDate: string;
    triggeredByUserId: string;
  }
): Promise<CalculateCommissionResult> {
  const [deal] = await tenantDb
    .select({
      id: deals.id,
      assignedRepId: deals.assignedRepId,
      awardedAmount: deals.awardedAmount,
      bidEstimate: deals.bidEstimate,
      ddEstimate: deals.ddEstimate,
    })
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1);

  if (!deal || !deal.assignedRepId) {
    return { status: "skipped_no_rep" };
  }

  const sourceValue = resolveSourceValue(deal);
  if (!sourceValue) {
    return { status: "skipped_no_value" };
  }

  const [settings] = await tenantDb
    .select({
      commissionRate: userCommissionSettings.commissionRate,
      isActive: userCommissionSettings.isActive,
    })
    .from(userCommissionSettings)
    .where(eq(userCommissionSettings.userId, deal.assignedRepId))
    .limit(1);

  if (!settings || !settings.isActive || Number(settings.commissionRate) <= 0) {
    return { status: "skipped_no_rate" };
  }

  // Idempotency guard. SELECT before INSERT and short-circuit on hit so a
  // retry doesn't trip the UNIQUE constraint and abort the surrounding
  // deal-update transaction.
  const [existing] = await tenantDb
    .select({ id: dealSignedCommissions.id })
    .from(dealSignedCommissions)
    .where(
      and(
        eq(dealSignedCommissions.dealId, input.dealId),
        eq(dealSignedCommissions.repUserId, deal.assignedRepId)
      )
    )
    .limit(1);

  if (existing) {
    console.warn(
      `[commissions] skipped duplicate insert for deal=${input.dealId} rep=${deal.assignedRepId}: existing commission row ${existing.id}`
    );
    return { status: "skipped_existing" };
  }

  const appliedRate = settings.commissionRate;
  const amount = multiplyDecimalStrings(sourceValue.amount, appliedRate);

  const [inserted] = await tenantDb
    .insert(dealSignedCommissions)
    .values({
      dealId: input.dealId,
      repUserId: deal.assignedRepId,
      sourceValueKind: sourceValue.kind,
      sourceValueAmount: sourceValue.amount,
      appliedRate,
      amount,
      contractSignedDateAtSigning: input.contractSignedDate,
      createdBy: input.triggeredByUserId,
    })
    .returning({ id: dealSignedCommissions.id });

  await writeAuditLog(tenantDb, {
    tableName: "deal_signed_commissions",
    recordId: inserted.id,
    action: "insert",
    changedBy: input.triggeredByUserId,
    changes: {
      amount: { from: null, to: amount },
      appliedRate: { from: null, to: appliedRate },
      sourceValueAmount: { from: null, to: sourceValue.amount },
      sourceValueKind: { from: null, to: sourceValue.kind },
      dealId: { from: null, to: input.dealId },
      repUserId: { from: null, to: deal.assignedRepId },
    },
  });

  return {
    status: "created",
    commissionId: inserted.id,
    amount,
    appliedRate,
    sourceValueAmount: sourceValue.amount,
    sourceValueKind: sourceValue.kind,
  };
}

/**
 * Delete every commission row for a deal (each audited), returning the count removed. Used by the
 * contract-date CLEAR (date → null) and when a change order is deleted — a voided CO must not leave an earned
 * commission behind (some earned-commission report queries join deals without an is_active filter, so a
 * soft-deleted CO's commission would otherwise linger). changedBy may be null for a system/cascade actor.
 */
export async function removeCommissionForDeal(
  tenantDb: TenantDb,
  dealId: string,
  triggeredByUserId: string | null
): Promise<number> {
  const removed = await tenantDb
    .delete(dealSignedCommissions)
    .where(eq(dealSignedCommissions.dealId, dealId))
    .returning({
      id: dealSignedCommissions.id,
      amount: dealSignedCommissions.amount,
      repUserId: dealSignedCommissions.repUserId,
    });
  for (const row of removed) {
    await writeAuditLog(tenantDb, {
      tableName: "deal_signed_commissions",
      recordId: row.id,
      action: "delete",
      changedBy: triggeredByUserId,
      changes: {
        amount: { from: row.amount, to: null },
        repUserId: { from: row.repUserId, to: null },
        dealId: { from: dealId, to: null },
      },
    });
  }
  return removed.length;
}

/**
 * Recompute a deal's commission from its CURRENT source value — ATTRIBUTION-PRESERVING and ALL-OR-NOTHING.
 *
 * Each existing commission row is updated IN PLACE, keyed on its own `rep_user_id`, so a date/amount
 * correction recomputes the AMOUNT against the booked rep — it NEVER re-attributes commission to a deal's
 * later reassigned owner (a date edit must not move earned commission, just as a reassignment doesn't).
 *
 * ALL-OR-NOTHING: if an existing row can no longer be validly recomputed (its booked rep has no active
 * commission rate, or the deal has no source value), that row is LEFT INTACT — a correction never deletes
 * earned commission down to $0. This is the deliberate fix for the delete-then-maybe-skip hazard, where a
 * blind delete + re-create would commit the delete while the re-create returned skipped_*.
 *
 * If the deal has NO existing commission row, this falls through to a fresh calculateCommissionForDeal for
 * the current assigned rep (e.g. correcting the date on a signed-but-never-calculated import deal). Runs
 * inside the caller's transaction, so the in-place updates are atomic with the deal edit. Used by the
 * contract-date edit path (setDealContractSignedDate) and the change-order amount/date edit.
 */
export async function recalculateCommissionForDeal(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    contractSignedDate: string;
    triggeredByUserId: string;
  }
): Promise<CalculateCommissionResult> {
  const existingRows = await tenantDb
    .select({
      id: dealSignedCommissions.id,
      repUserId: dealSignedCommissions.repUserId,
      amount: dealSignedCommissions.amount,
      sourceValueAmount: dealSignedCommissions.sourceValueAmount,
      appliedRate: dealSignedCommissions.appliedRate,
    })
    .from(dealSignedCommissions)
    .where(eq(dealSignedCommissions.dealId, input.dealId));

  // No prior commission → behave as a fresh calc for the deal's CURRENT assigned rep.
  if (existingRows.length === 0) {
    return calculateCommissionForDeal(tenantDb, input);
  }

  const [deal] = await tenantDb
    .select({
      awardedAmount: deals.awardedAmount,
      bidEstimate: deals.bidEstimate,
      ddEstimate: deals.ddEstimate,
    })
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1);
  const sourceValue = deal ? resolveSourceValue(deal) : null;

  let recomputed = 0;
  for (const row of existingRows) {
    // The rate is the BOOKED rep's current rate — attribution stays with row.repUserId, never the deal's
    // (possibly reassigned) current assignedRepId.
    const [settings] = await tenantDb
      .select({
        commissionRate: userCommissionSettings.commissionRate,
        isActive: userCommissionSettings.isActive,
      })
      .from(userCommissionSettings)
      .where(eq(userCommissionSettings.userId, row.repUserId))
      .limit(1);

    // ALL-OR-NOTHING: cannot validly recompute → LEAVE THE ROW INTACT (no delete, no zeroing).
    if (!sourceValue || !settings || !settings.isActive || Number(settings.commissionRate) <= 0) {
      continue;
    }

    const appliedRate = settings.commissionRate;
    const amount = multiplyDecimalStrings(sourceValue.amount, appliedRate);
    await tenantDb
      .update(dealSignedCommissions)
      .set({
        sourceValueKind: sourceValue.kind,
        sourceValueAmount: sourceValue.amount,
        appliedRate,
        amount,
        contractSignedDateAtSigning: input.contractSignedDate,
        calculatedAt: new Date(),
      })
      .where(eq(dealSignedCommissions.id, row.id));

    await writeAuditLog(tenantDb, {
      tableName: "deal_signed_commissions",
      recordId: row.id,
      action: "update",
      changedBy: input.triggeredByUserId,
      changes: {
        amount: { from: row.amount, to: amount },
        sourceValueAmount: { from: row.sourceValueAmount, to: sourceValue.amount },
        appliedRate: { from: row.appliedRate, to: appliedRate },
        contractSignedDateAtSigning: { from: null, to: input.contractSignedDate },
      },
    });
    recomputed += 1;
  }

  // No caller inspects this result today. "created" when ≥1 row was recomputed; otherwise every existing
  // row was PRESERVED intact (no active rate / no source value) — reported as skipped_no_rate.
  return recomputed > 0 ? { status: "created" } : { status: "skipped_no_rate" };
}
