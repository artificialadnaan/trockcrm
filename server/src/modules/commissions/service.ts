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
  | "skipped_change_order"
  // OWNER-ROW INVARIANT (3rd facet): the estimator-mint path returns this when the deal has NO booked
  // OWNER row (attribution_role = 'owner'). The estimator's additive row must NEVER be the first/only dsc
  // row on a deal — otherwise the owner is orphaned AND the #736 owner backfill (which skips any deal that
  // already carries ANY dsc row) is blinded to the deal, so the owner never gets a row even after they
  // gain a rate. Gating the mint on an existing owner row keeps a rateless-owner deal at ZERO rows.
  | "skipped_no_owner_row";

export interface CalculateCommissionResult {
  status: CalculateCommissionStatus;
  commissionId?: string;
  amount?: string;
  appliedRate?: string;
  sourceValueAmount?: string;
  sourceValueKind?: CommissionSourceValueKind;
  // The additive ESTIMATOR side-effect outcome of calculateCommissionForDeal, when one applies (a rated,
  // distinct, non-CO estimator). Backward-compatible: `status` above always describes the OWNER row, so
  // existing callers that read `.status`/`.amount` are unaffected. `undefined` when no estimator applies.
  // Consumed by the owner-backfill tally so estimator rows minted as a side effect are not undercounted.
  estimator?: { status: CalculateCommissionStatus; repUserId?: string; amount?: string };
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
 * Insert ONE earned-commission row for a single rep at THAT rep's own rate — the shared primitive behind
 * both the owner mint and the estimator mint, so the two can never drift in how they resolve rate / source
 * value / idempotency / audit. Resolves the rep's user_commission_settings (skipped_no_rate when missing,
 * inactive, or rate ≤ 0); resolves the deal's source value (skipped_no_value when none); then INSERTs the
 * row + an insert audit.
 *
 * IDEMPOTENCY IS TRANSACTION-SAFE: the INSERT uses ON CONFLICT (deal_id, rep_user_id) DO NOTHING, so a
 * duplicate (idempotent retry OR a concurrent winner) yields an EMPTY `.returning()` WITHOUT raising a
 * 23505 — returned as skipped_existing while the surrounding transaction STAYS VALID. (A caught 23505
 * would NOT recover the tx: in Postgres the unique violation aborts it, so the caller's later statements
 * and the commit would fail. ON CONFLICT avoids the abort entirely.)
 *
 * `role` stamps attribution_role so the OWNER's full-cut row and an ESTIMATOR's additive row stay
 * distinguishable even after an owner reassignment (the estimator-removal path keys on it).
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
  triggeredByUserId: string,
  role: "owner" | "estimator"
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

  const appliedRate = settings.commissionRate;
  const amount = multiplyDecimalStrings(sourceValue.amount, appliedRate);

  // Tx-safe idempotency: ON CONFLICT (deal_id, rep_user_id) DO NOTHING. An existing row (retry) or a
  // concurrent insert that wins the race yields an EMPTY returning() — no 23505, so the transaction is
  // never aborted. An empty result ⇒ the row already exists ⇒ skipped_existing.
  const [inserted] = await tx
    .insert(dealSignedCommissions)
    .values({
      dealId: deal.id,
      repUserId,
      attributionRole: role,
      sourceValueKind: sourceValue.kind,
      sourceValueAmount: sourceValue.amount,
      appliedRate,
      amount,
      contractSignedDateAtSigning: contractSignedDate,
      createdBy: triggeredByUserId,
    })
    .onConflictDoNothing({
      target: [dealSignedCommissions.dealId, dealSignedCommissions.repUserId],
    })
    .returning({ id: dealSignedCommissions.id });

  if (!inserted) {
    console.warn(
      `[commissions] skipped duplicate insert for deal=${deal.id} rep=${repUserId}: row already exists (ON CONFLICT DO NOTHING)`
    );
    return { status: "skipped_existing" };
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
    input.triggeredByUserId,
    "owner"
  );

  // Additive estimator row: a rated, distinct, non-change-order estimator earns an ADDITIONAL row at the
  // ESTIMATOR's own rate, ON TOP OF the owner's full cut (additive, never a split). A change order is
  // base-deal-only — it never mints an estimator row. The rate check lives inside insertCommissionRowForRep
  // (a rateless estimator simply yields skipped_no_rate and no row). Minting at sign time here is also what
  // closes the contract-date clear→resign gap: a clear removes ALL rows, and re-signing re-mints BOTH.
  // The `estimatorUserId !== assignedRepId` term here is a CHEAP OPTIMIZATION, not the load-bearing guard:
  // at SIGN time assigned_rep_id IS the owner row just minted above, so estimator===assignedRepId means the
  // owner row already covers them and we can skip the redundant insert. Correctness does NOT rely on this
  // proxy — if estimator did equal the owner, the estimator insert would conflict on (deal_id, rep_user_id)
  // and onConflictDoNothing would skip it anyway (the OWNER-ROW INVARIANT backstop). Reassignment can't
  // break this branch because it only runs at sign time, before any reassignment.
  //
  // OWNER-ROW INVARIANT (3rd facet): the estimator mint is routed through mintEstimatorCommissionForDeal —
  // the SINGLE helper that gates on an EXISTING owner row — rather than inserting directly. So if the owner
  // mint above was skipped (e.g. skipped_no_rate: the owner has no active rate), the estimator helper sees
  // NO owner row and returns skipped_no_owner_row, minting nothing. That keeps the estimator row from ever
  // becoming the first/only dsc row on a deal (no orphaned owner; the #736 owner backfill still finds the
  // deal). When the owner mint succeeded the owner row exists, so the gate passes and the estimator mints.
  let estimatorResult: CalculateCommissionResult | undefined;
  if (
    !deal.isChangeOrder &&
    deal.estimatorUserId != null &&
    deal.estimatorUserId !== deal.assignedRepId
  ) {
    estimatorResult = await mintEstimatorCommissionForDeal(tenantDb, {
      dealId: deal.id,
      estimatorUserId: deal.estimatorUserId,
      triggeredByUserId: input.triggeredByUserId,
    });
  }

  // The top-level status describes the OWNER row (callers historically inspect the owner outcome). The
  // estimator row is an additive side effect — surfaced under `.estimator` (backward-compatible) so the
  // owner-backfill tally can account for the estimator rows it mints instead of undercounting them.
  return {
    ...ownerResult,
    estimator: estimatorResult
      ? {
          status: estimatorResult.status,
          repUserId: deal.estimatorUserId ?? undefined,
          amount: estimatorResult.amount,
        }
      : undefined,
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
    // In-place, keyed on row.id. Deliberately recomputes ONLY amount/rate/source/date — it never touches
    // rep_user_id OR attribution_role, so a row stays booked to its original rep AND keeps its owner-vs-
    // estimator role across a date/amount correction (attribution-preserving).
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
 *   • the deal is a change order              → skipped_change_order (base-deal-only)
 *   • the estimator already BOOKS a dsc row   → skipped_existing (never a 2nd cut for the same person)
 *   • the deal has no effective signed date   → skipped_no_value (an unsigned deal earns nothing)
 *   • the deal has NO booked OWNER row        → skipped_no_owner_row (the estimator row must never be the
 *                                               first/only dsc row — see OWNER-ROW INVARIANT below)
 * Otherwise delegates to the shared insert primitive (rateless estimator ⇒ skipped_no_rate / no row;
 * already-minted ⇒ skipped_existing). MUST run inside the caller's transaction.
 *
 * OWNER-ROW INVARIANT: the "already covered" gate is the ACTUAL booked deal_signed_commissions row for
 * this estimator (rep presence on the deal), NEVER the MUTABLE deal.assigned_rep_id. After an owner
 * reassignment the booked owner row stays on the ORIGINAL rep while assigned_rep_id moves, so an
 * assigned_rep_id proxy is wrong in BOTH directions: it would fail to skip the original (still-booked)
 * owner if they are later named estimator, AND — worse — it would WRONGLY skip the new assignee when they
 * are named estimator, denying them a commission they are owed (they book no row yet). Keying on the row
 * is reassignment-safe. (onConflictDoNothing + UNIQUE(deal_id, rep_user_id) remain the backstop; this
 * EXISTS check is the load-bearing guard.)
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

  // OWNER-ROW INVARIANT (the authoritative skip): does this estimator ALREADY book a row on this deal —
  // as the owner's full-cut row OR an already-minted estimator row? Gate on the ACTUAL row (rep presence),
  // NOT deal.assignedRepId (mutable — a reassignment leaves the owner row on the original rep). If they
  // already earn on the deal, never mint a 2nd cut for them.
  const [existingForEstimator] = await tx
    .select({ id: dealSignedCommissions.id })
    .from(dealSignedCommissions)
    .where(
      and(
        eq(dealSignedCommissions.dealId, deal.id),
        eq(dealSignedCommissions.repUserId, input.estimatorUserId)
      )
    )
    .limit(1);
  if (existingForEstimator) {
    return { status: "skipped_existing" };
  }

  const effectiveSignedDate = effectiveSignedDateOf(deal);
  if (!effectiveSignedDate) {
    return { status: "skipped_no_value" };
  }

  // OWNER-ROW INVARIANT (3rd facet, the load-bearing money-safety gate): the estimator's ADDITIVE row must
  // NEVER be the first/only deal_signed_commissions row on a deal. Mint it ONLY when an OWNER row
  // (attribution_role = 'owner') already exists on the deal. If none exists — e.g. the owner had no active
  // rate at sign time, so calculateCommissionForDeal's owner mint returned skipped_no_rate and wrote no row
  // — minting the estimator alone would ORPHAN the owner AND blind the #736 owner backfill (it skips any
  // deal already carrying ANY dsc row), so the owner would never get a row even after gaining a rate. This
  // SINGLE helper gate covers every call site: sign-time calc (owner is minted just before, so the row
  // exists iff the owner succeeded), the manual setDealEstimator edit, and the backfill. A signed-but-
  // rateless-owner deal therefore stays at ZERO rows, exactly so the owner backfill can still find it.
  const [ownerRow] = await tx
    .select({ id: dealSignedCommissions.id })
    .from(dealSignedCommissions)
    .where(
      and(
        eq(dealSignedCommissions.dealId, deal.id),
        eq(dealSignedCommissions.attributionRole, "owner")
      )
    )
    .limit(1);
  if (!ownerRow) {
    return { status: "skipped_no_owner_row" };
  }

  return insertCommissionRowForRep(
    tx,
    deal,
    input.estimatorUserId,
    effectiveSignedDate,
    input.triggeredByUserId,
    "estimator"
  );
}

/**
 * Remove ONLY the estimator's ADDITIVE commission row — the manual estimator-removal counterpart.
 *
 * STRUCTURAL OWNER-ROW GUARD: the DELETE is scoped to (deal_id, rep_user_id = estimator,
 * attribution_role = 'estimator'), so it can NEVER touch an OWNER full-cut row (which carries
 * attribution_role = 'owner'). This is the load-bearing money-safety fix: after an OWNER reassignment the
 * deal's rep_user_id alone could no longer tell owner-vs-estimator apart, so the prior (deal_id, rep)
 * delete could wipe an owner row whose rep happened to match a departing estimator. The role predicate
 * makes that impossible.
 *
 * The role predicate REPLACES (and is strictly stronger than) the old estimator===owner userid short-
 * circuit, which is deliberately NOT kept: it both failed to guard the real bug (there ownerUserId was the
 * REASSIGNED owner ≠ the estimator, so it never fired) AND it would wrongly block a legitimate removal in
 * the inverse case — a former estimator who later BECOMES the deal's reassigned owner still has a real
 * estimator-role row that must be removable when the estimator is cleared. `ownerUserId` is retained on the
 * input for caller/audit context (it no longer gates the delete; the role predicate is the sole guarantee).
 *
 * This is deliberately NOT removeCommissionForDeal, which deletes EVERY row for the deal (owner included).
 * Each deleted row is audited. Returns the count removed. MUST run inside the caller's transaction.
 */
export async function removeEstimatorCommissionForDeal(
  tx: TenantDb,
  input: {
    dealId: string;
    estimatorUserId: string;
    // Retained for caller/audit context. The role-scoped DELETE — not a userid comparison — is what
    // protects the owner row, so this is intentionally not used to gate the delete (see doc above).
    ownerUserId: string | null;
    triggeredByUserId: string | null;
  }
): Promise<number> {
  const removed = await tx
    .delete(dealSignedCommissions)
    .where(
      and(
        eq(dealSignedCommissions.dealId, input.dealId),
        eq(dealSignedCommissions.repUserId, input.estimatorUserId),
        // Role-scoped: an OWNER row (attribution_role = 'owner') can never match, so the owner's full cut
        // is structurally protected even when estimator === the deal's (reassigned) current owner.
        eq(dealSignedCommissions.attributionRole, "estimator")
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
