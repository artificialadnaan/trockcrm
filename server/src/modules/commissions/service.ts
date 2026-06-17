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
  | "skipped_no_rate"
  // Only the estimator-mint path returns this (a change order is base-deal-only: it never mints an
  // estimator row). Added to the shared union so estimator helpers type-check against the same result.
  | "skipped_change_order";

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

/** True when an error (or any error in its `cause` chain) is a Postgres unique_violation (23505).
 *  node-postgres surfaces the code on the error itself; drizzle/PGlite wrap it under `.cause`. */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (typeof (cur as { code?: unknown }).code === "string" && (cur as { code: string }).code === "23505") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Insert ONE earned-commission row for a single rep at THAT rep's own rate — the shared primitive behind
 * both the owner mint and the estimator mint, so the two can never drift in how they resolve rate / source
 * value / idempotency / audit. Resolves the rep's user_commission_settings (skipped_no_rate when missing,
 * inactive, or rate ≤ 0); resolves the deal's source value (skipped_no_value when none); SELECT-before-
 * INSERT on (deal_id, rep_user_id) (skipped_existing on hit); else INSERTs the row + an insert audit. A
 * concurrent duplicate that slips past the SELECT trips the UNIQUE constraint — caught here as 23505 and
 * returned as skipped_existing so a race never throws out of the surrounding transaction.
 */
async function insertCommissionRowForRep(
  tx: TenantDb,
  deal: {
    id: string;
    awardedAmount: string | null;
    bidEstimate: string | null;
    ddEstimate: string | null;
  },
  repUserId: string,
  contractSignedDate: string,
  triggeredByUserId: string
): Promise<CalculateCommissionResult> {
  const sourceValue = resolveSourceValue(deal);
  if (!sourceValue) {
    return { status: "skipped_no_value" };
  }

  const [settings] = await tx
    .select({
      commissionRate: userCommissionSettings.commissionRate,
      isActive: userCommissionSettings.isActive,
    })
    .from(userCommissionSettings)
    .where(eq(userCommissionSettings.userId, repUserId))
    .limit(1);

  if (!settings || !settings.isActive || Number(settings.commissionRate) <= 0) {
    return { status: "skipped_no_rate" };
  }

  // Idempotency guard. SELECT before INSERT and short-circuit on hit so a retry doesn't trip the UNIQUE
  // constraint and abort the surrounding deal-update transaction.
  const [existing] = await tx
    .select({ id: dealSignedCommissions.id })
    .from(dealSignedCommissions)
    .where(
      and(
        eq(dealSignedCommissions.dealId, deal.id),
        eq(dealSignedCommissions.repUserId, repUserId)
      )
    )
    .limit(1);

  if (existing) {
    console.warn(
      `[commissions] skipped duplicate insert for deal=${deal.id} rep=${repUserId}: existing commission row ${existing.id}`
    );
    return { status: "skipped_existing" };
  }

  const appliedRate = settings.commissionRate;
  const amount = multiplyDecimalStrings(sourceValue.amount, appliedRate);

  let inserted: { id: string } | undefined;
  try {
    [inserted] = await tx
      .insert(dealSignedCommissions)
      .values({
        dealId: deal.id,
        repUserId,
        sourceValueKind: sourceValue.kind,
        sourceValueAmount: sourceValue.amount,
        appliedRate,
        amount,
        contractSignedDateAtSigning: contractSignedDate,
        createdBy: triggeredByUserId,
      })
      .returning({ id: dealSignedCommissions.id });
  } catch (err) {
    // A concurrent insert won the race between our SELECT and INSERT — the row now exists; treat as
    // skipped_existing rather than letting the unique violation abort the transaction.
    if (isUniqueViolation(err)) {
      console.warn(
        `[commissions] concurrent duplicate insert for deal=${deal.id} rep=${repUserId} caught (23505)`
      );
      return { status: "skipped_existing" };
    }
    throw err;
  }

  await writeAuditLog(tx, {
    tableName: "deal_signed_commissions",
    recordId: inserted.id,
    action: "insert",
    changedBy: triggeredByUserId,
    changes: {
      amount: { from: null, to: amount },
      appliedRate: { from: null, to: appliedRate },
      sourceValueAmount: { from: null, to: sourceValue.amount },
      sourceValueKind: { from: null, to: sourceValue.kind },
      dealId: { from: null, to: deal.id },
      repUserId: { from: null, to: repUserId },
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
      estimatorUserId: deals.estimatorUserId,
      isChangeOrder: deals.isChangeOrder,
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

  // Owner row: the deal's assigned rep earns the FULL cut at their own rate (the historical behavior).
  const ownerResult = await insertCommissionRowForRep(
    tenantDb,
    deal,
    deal.assignedRepId,
    input.contractSignedDate,
    input.triggeredByUserId
  );

  // Additive estimator row: a rated, distinct, non-change-order estimator earns an ADDITIONAL row at the
  // ESTIMATOR's own rate, ON TOP OF the owner's full cut (additive, never a split). A change order is
  // base-deal-only — it never mints an estimator row. The rate check lives inside insertCommissionRowForRep
  // (a rateless estimator simply yields skipped_no_rate and no row). Minting at sign time here is also what
  // closes the contract-date clear→resign gap: a clear removes ALL rows, and re-signing re-mints BOTH.
  if (
    !deal.isChangeOrder &&
    deal.estimatorUserId != null &&
    deal.estimatorUserId !== deal.assignedRepId
  ) {
    await insertCommissionRowForRep(
      tenantDb,
      deal,
      deal.estimatorUserId,
      input.contractSignedDate,
      input.triggeredByUserId
    );
  }

  // The returned status describes the OWNER row (callers historically inspect the owner outcome). The
  // estimator row is an additive side effect that never changes the owner's reported result.
  return ownerResult;
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
      sourceValueKind: dealSignedCommissions.sourceValueKind,
      sourceValueAmount: dealSignedCommissions.sourceValueAmount,
      appliedRate: dealSignedCommissions.appliedRate,
      contractSignedDateAtSigning: dealSignedCommissions.contractSignedDateAtSigning,
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
        sourceValueKind: { from: row.sourceValueKind, to: sourceValue.kind },
        sourceValueAmount: { from: row.sourceValueAmount, to: sourceValue.amount },
        appliedRate: { from: row.appliedRate, to: appliedRate },
        contractSignedDateAtSigning: { from: row.contractSignedDateAtSigning, to: input.contractSignedDate },
      },
    });
    recomputed += 1;
  }

  // No caller inspects this result today. "created" when ≥1 row was recomputed; otherwise every existing
  // row was PRESERVED intact (no active rate / no source value) — reported as skipped_no_rate.
  return recomputed > 0 ? { status: "created" } : { status: "skipped_no_rate" };
}

/** Date-only (YYYY-MM-DD, UTC) of a contract_signed_at timestamp. The app stores _at at UTC midnight of
 *  the signed date, so this round-trips the canonical effective signed date. */
function effectiveSignedDateOf(deal: {
  contractSignedAt: Date | string | null;
  contractSignedDate: string | null;
}): string | null {
  // CANONICAL precedence: contract_signed_at::date FIRST, then contract_signed_date — matching the
  // deals service's read/reporting paths (a reseed/import row can carry _at without _date).
  if (deal.contractSignedAt != null) {
    const at = deal.contractSignedAt instanceof Date ? deal.contractSignedAt : new Date(deal.contractSignedAt);
    return at.toISOString().slice(0, 10);
  }
  return deal.contractSignedDate ?? null;
}

/**
 * Mint the ADDITIVE estimator commission row for a deal (the estimator's own-rate cut, on top of the
 * owner's). The estimator-scoped counterpart to calculateCommissionForDeal's owner mint, for the manual
 * estimator-edit path. Skips (never throws) when:
 *   • the deal is a change order            → skipped_change_order (base-deal-only)
 *   • the estimator IS the owner            → skipped_existing (the owner row already covers them)
 *   • the deal has no effective signed date → skipped_no_value (an unsigned deal earns nothing)
 * Otherwise delegates to the shared insert primitive (rateless estimator ⇒ skipped_no_rate / no row;
 * already-minted ⇒ skipped_existing). MUST run inside the caller's transaction.
 */
export async function mintEstimatorCommissionForDeal(
  tx: TenantDb,
  input: {
    dealId: string;
    estimatorUserId: string;
    triggeredByUserId: string;
  }
): Promise<CalculateCommissionResult> {
  const [deal] = await tx
    .select({
      id: deals.id,
      assignedRepId: deals.assignedRepId,
      isChangeOrder: deals.isChangeOrder,
      awardedAmount: deals.awardedAmount,
      bidEstimate: deals.bidEstimate,
      ddEstimate: deals.ddEstimate,
      contractSignedAt: deals.contractSignedAt,
      contractSignedDate: deals.contractSignedDate,
    })
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1);

  if (!deal) {
    return { status: "skipped_no_value" };
  }
  if (deal.isChangeOrder) {
    return { status: "skipped_change_order" };
  }
  if (input.estimatorUserId === deal.assignedRepId) {
    // The owner row already credits this user their full cut; an estimator row would be a duplicate.
    return { status: "skipped_existing" };
  }

  const effectiveSignedDate = effectiveSignedDateOf(deal);
  if (!effectiveSignedDate) {
    return { status: "skipped_no_value" };
  }

  return insertCommissionRowForRep(
    tx,
    deal,
    input.estimatorUserId,
    effectiveSignedDate,
    input.triggeredByUserId
  );
}

/**
 * Remove ONLY the estimator's commission row (scoped to (deal_id, estimator_user_id)) — the manual
 * estimator-removal counterpart. HARD GUARD: if the estimator IS the owner, return 0 without deleting,
 * so this can never wipe the owner's full-cut row. This is deliberately NOT removeCommissionForDeal,
 * which deletes EVERY row for the deal (owner included). Each deleted row is audited. Returns the count
 * removed. MUST run inside the caller's transaction.
 */
export async function removeEstimatorCommissionForDeal(
  tx: TenantDb,
  input: {
    dealId: string;
    estimatorUserId: string;
    ownerUserId: string | null;
    triggeredByUserId: string | null;
  }
): Promise<number> {
  if (input.estimatorUserId === input.ownerUserId) {
    // Never delete the owner row via the estimator path.
    return 0;
  }
  const removed = await tx
    .delete(dealSignedCommissions)
    .where(
      and(
        eq(dealSignedCommissions.dealId, input.dealId),
        eq(dealSignedCommissions.repUserId, input.estimatorUserId)
      )
    )
    .returning({
      id: dealSignedCommissions.id,
      amount: dealSignedCommissions.amount,
      repUserId: dealSignedCommissions.repUserId,
    });
  for (const row of removed) {
    await writeAuditLog(tx, {
      tableName: "deal_signed_commissions",
      recordId: row.id,
      action: "delete",
      changedBy: input.triggeredByUserId,
      changes: {
        amount: { from: row.amount, to: null },
        repUserId: { from: row.repUserId, to: null },
        dealId: { from: input.dealId, to: null },
      },
    });
  }
  return removed.length;
}
