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
 * Calculate the booked commission row for a deal that just had its
 * contract_signed_date set. Idempotent at the (deal_id, rep_user_id)
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
