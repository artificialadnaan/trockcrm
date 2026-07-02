import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { dealSignedCommissions, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  listActiveFieldOffices,
  runInOfficeTransaction,
} from "../field/cross-office.js";
import { effectiveSignedDateOf, recalculateCommissionForDeal } from "./service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Re-rate every deal in ONE office where `repUserId` books a deal_signed_commissions row, using
 * the rep's CURRENT effective rate (the mirror written by the settings-save). Delegates to the
 * existing per-deal writer, which recomputes each row at its own booked rep's current rate and
 * preserves rep/role/date (attribution-preserving). Returns the number of deals recomputed.
 */
export async function recalculateRepCommissionsInOffice(
  officeDb: TenantDb,
  repUserId: string,
  triggeredByUserId: string,
): Promise<number> {
  const dealRows = await officeDb
    .selectDistinct({ dealId: dealSignedCommissions.dealId })
    .from(dealSignedCommissions)
    .where(eq(dealSignedCommissions.repUserId, repUserId));

  let recomputed = 0;
  for (const { dealId } of dealRows) {
    const [deal] = await officeDb
      .select({
        contractSignedAt: deals.contractSignedAt,
        contractSignedDate: deals.contractSignedDate,
      })
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1);
    // Preserve the deal's own signed date so re-rating changes only amount/rate, never the date.
    const signedDate = deal ? effectiveSignedDateOf(deal) : null;
    if (!signedDate) continue;

    await recalculateCommissionForDeal(officeDb, {
      dealId,
      contractSignedDate: signedDate,
      triggeredByUserId,
    });
    recomputed += 1;
  }
  return recomputed;
}

export interface RepRecomputeSummary {
  recomputed: number;
  officeFailures: Array<{ office: string; error: string }>;
}

/**
 * Fan out {@link recalculateRepCommissionsInOffice} across ALL active offices (there is no
 * rep→offices map; the established pattern fans out unconditionally, and a rep with no rows in
 * an office simply recomputes 0). Each office runs in its own transaction; one office failing
 * degrades gracefully and is reported, never thrown.
 */
export async function recalculateAllCommissionsForRep(
  userId: string,
  triggeredByUserId: string,
): Promise<RepRecomputeSummary> {
  const offices = await listActiveFieldOffices();
  let recomputed = 0;
  const officeFailures: Array<{ office: string; error: string }> = [];

  for (const office of offices) {
    try {
      recomputed += await runInOfficeTransaction(office, triggeredByUserId, (officeDb) =>
        recalculateRepCommissionsInOffice(officeDb, userId, triggeredByUserId),
      );
    } catch (err) {
      officeFailures.push({
        office: office.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { recomputed, officeFailures };
}
