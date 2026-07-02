import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { dealSignedCommissions, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
// Cross-office fan-out infra lives in the field module by historical convention;
// nothing imported here is field-feature-specific.
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

    const result = await recalculateCommissionForDeal(officeDb, {
      dealId,
      contractSignedDate: signedDate,
      triggeredByUserId,
      // Re-rate ONLY this rep's rows: a rate edit for one rep must never rewrite a co-booked rep's
      // row on a shared deal (which would race with that other rep's own recompute).
      onlyRepUserId: repUserId,
      // A settings change is deliberate, so a 0% effective rate must re-rate the rep's rows to $0
      // (not preserve a stale payout). The deal-edit path leaves this off to keep #732 all-or-nothing.
      zeroOnNoRate: true,
    });
    if (result.status === "created") recomputed += 1;
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
async function runRepRecompute(
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

// Per-rep in-memory serialization. Two rapid settings edits for the same rep must not run their
// cross-office recomputes concurrently: an earlier recompute that read the OLD rate inside its
// office transactions could commit AFTER the later one and leave deal_signed_commissions at the
// stale rate. Chaining each rep's recompute after any in-flight one guarantees the last-committed
// rate wins. There is no await between the map read and write below, so concurrent calls chain
// deterministically. Per-instance only; cross-instance serialization is part of the deferred
// job-queue work (see the spec's "Cross-office recompute" note).
const repRecomputeChains = new Map<string, Promise<unknown>>();

export function recalculateAllCommissionsForRep(
  userId: string,
  triggeredByUserId: string,
): Promise<RepRecomputeSummary> {
  const prior = repRecomputeChains.get(userId) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(() => runRepRecompute(userId, triggeredByUserId));
  repRecomputeChains.set(userId, run);
  // Drop the entry once this is the tail of the chain, so the map doesn't grow unbounded. The
  // trailing `.catch` swallows this cleanup branch's rejection — `run`'s own rejection is handled
  // by the caller (the fire-and-forget wrapper), and this branch must not surface as an unhandled
  // rejection if `runRepRecompute` throws (e.g. listActiveFieldOffices can't reach public.offices).
  void run
    .finally(() => {
      if (repRecomputeChains.get(userId) === run) repRecomputeChains.delete(userId);
    })
    .catch(() => undefined);
  return run;
}
