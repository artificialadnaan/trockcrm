import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { dealSignedCommissions, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
// Cross-office fan-out infra lives in the field module by historical convention;
// nothing imported here is field-feature-specific.
import {
  listActiveFieldOffices,
  runInOfficeTransaction,
} from "../field/cross-office.js";
import { lockDealCommissions } from "./deal-commission-lock.js";
import {
  effectiveSignedDateOf,
  mintSalesSourceCommissionForDeal,
  recalculateCommissionForDeal,
} from "./service.js";
import type { CommissionRole } from "./service.js";

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
  roles?: CommissionRole[],
): Promise<number> {
  const dealRows = await officeDb
    .selectDistinct({ dealId: dealSignedCommissions.dealId })
    .from(dealSignedCommissions)
    .where(eq(dealSignedCommissions.repUserId, repUserId));

  // Resolved UP FRONT, before any lock is taken, because its deal ids have to join the same globally
  // ordered lock set as the row-scan's (see below). A second, separately ordered traversal would
  // reintroduce exactly the cycle the ordering exists to prevent.
  const sourcedDeals =
    !roles || roles.includes("sales_source")
      ? await officeDb
          .select({ id: deals.id })
          .from(deals)
          .where(
            and(
              eq(deals.salesSourceUserId, repUserId),
              eq(deals.workflowRoute, "service"),
              eq(deals.isActive, true)
            )
          )
      : [];

  // GLOBAL LOCK ORDER. Every deal this transaction will touch is locked here, in sorted id order,
  // before any work begins.
  //
  // Two recomputes for DIFFERENT reps routinely share deals (a co-booked owner and estimator, or an
  // owner and a sales source). Each holds its advisory locks until COMMIT, so acquiring them in
  // traversal order lets one lock deal X and wait for Y while the other holds Y and waits for X —
  // Postgres breaks the tie by aborting one. That abort is close to invisible: the caller is
  // fire-and-forget and only collects `officeFailures`, so the settings save still reports success
  // while that office's payouts silently stay at the old rate. A deterministic global order makes the
  // cycle unconstructible, and keeps the whole recompute in one transaction.
  const orderedDealIds = [
    ...new Set([...dealRows.map((row) => row.dealId), ...sourcedDeals.map((deal) => deal.id)]),
  ].sort();
  for (const dealId of orderedDealIds) {
    // Serialize this deal's commission mutations against "Move back to Opportunity", which voids the
    // deal's commission after showing the operator an exact amount. Taken BEFORE any deal is read, so
    // no eligibility decision below can be made from a snapshot a concurrent move-back is about to
    // invalidate — and before any row lock, which is what keeps the two paths deadlock-free
    // (see deal-commission-lock.ts).
    await lockDealCommissions(officeDb, dealId);
  }

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
      // When a roles filter is provided (e.g. only "sales_source" changed), re-rate ONLY rows whose
      // attribution_role is in the set — so a service-source-only edit never rewrites the same rep's
      // owner/estimator rows against the deal's current value.
      onlyRoles: roles,
      // A settings change is deliberate, so a 0% effective rate must re-rate the rep's rows to $0
      // (not preserve a stale payout). The deal-edit path leaves this off to keep #732 all-or-nothing.
      zeroOnNoRate: true,
    });
    if (result.status === "created") recomputed += 1;
  }

  // Sales-source recompute must ALSO discover sourced deals that have NO sales_source row yet. A deal
  // signed while the rep had a 0% effective service-source rate (solo structure / serviceSourceRate 0)
  // mints no row (skipped_no_rate), so the row-scan above — which only sees deals where the rep already
  // books a dsc row — can never revisit it. When the rep later gains a positive source rate (solo→mixed
  // or a raised rate), mint the now-earned row here so the live "rewrite all" recompute actually creates
  // it (what a manual backfill would otherwise be needed for). mintSalesSourceCommissionForDeal is
  // idempotent (an existing row → skipped_existing) and still no-ops while the effective rate is 0 or the
  // deal is unsigned, so running it over every sourced deal is safe and never double-counts the row-scan.
  // Deliberately sales_source-specific: owner rows are discoverable via assigned_rep_id but keep the
  // backfill-only convention, whereas the sourced-deal link is a first-class column and a solo↔mixed
  // switch is the designed 0↔positive flow.
  for (const { id: dealId } of sourcedDeals) {
    // THE path that made deal-commission-lock.ts necessary: this mint reads the deal (signed date
    // included) without locking or writing it, then INSERTs a row for a rep that had none — so it is
    // the one commission writer neither the deal-row FOR UPDATE nor the deal_signed_commissions row
    // locks can serialize. Its lock was already taken above, in the global order.
    const result = await mintSalesSourceCommissionForDeal(officeDb, {
      dealId,
      salesSourceUserId: repUserId,
      triggeredByUserId,
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
  roles?: CommissionRole[],
): Promise<RepRecomputeSummary> {
  const offices = await listActiveFieldOffices();
  let recomputed = 0;
  const officeFailures: Array<{ office: string; error: string }> = [];

  for (const office of offices) {
    try {
      recomputed += await runInOfficeTransaction(office, triggeredByUserId, (officeDb) =>
        recalculateRepCommissionsInOffice(officeDb, userId, triggeredByUserId, roles),
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
  roles?: CommissionRole[],
): Promise<RepRecomputeSummary> {
  const prior = repRecomputeChains.get(userId) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(() => runRepRecompute(userId, triggeredByUserId, roles));
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
