import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateExtractionMatches,
  estimateExtractions,
  estimatePricingRecommendations,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { resolvePricingScopeFromExtraction } from "./pricing-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

async function insertReviewEvent(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    subjectId: string;
    eventType: string;
    userId: string;
    /** Defaults to the extraction. The promoted-line flag below is the one caller that addresses a
     *  different subject, and the column exists precisely so the two can be told apart. */
    subjectType?: string;
    beforeJson?: Record<string, unknown>;
    afterJson?: Record<string, unknown>;
    reason?: string | null;
  }
) {
  const [event] = await tenantDb
    .insert(estimateReviewEvents)
    .values({
      dealId: input.dealId,
      subjectType: input.subjectType ?? "estimate_extraction",
      subjectId: input.subjectId,
      eventType: input.eventType,
      userId: input.userId,
      beforeJson: input.beforeJson ?? {},
      afterJson: input.afterJson ?? {},
      reason: input.reason ?? null,
    })
    .returning();

  return event;
}

/** The one definition of "can be priced", shared by every decision in this file. Mirrors the
 *  worker's own guard and `applyMarketRateAdjustment`: absent, non-finite and nonpositive are all
 *  unpriceable. Module-level because approve needs it as well as edit. */
function isPriceableQuantity(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

async function loadEstimateExtraction(
  tenantDb: TenantDb,
  dealId: string,
  extractionId: string
) {
  const [extraction] = await tenantDb
    .select()
    .from(estimateExtractions)
    .where(
      and(
        eq(estimateExtractions.id, extractionId),
        eq(estimateExtractions.dealId, dealId)
      )
    )
    .limit(1)
    // LOCKED FOR THE REST OF THE REQUEST'S TRANSACTION.
    //
    // `tenantMiddleware` opens a transaction before any of these handlers run and holds it until
    // `commitTransaction`, so this SELECT and the UPDATE that follows it are already one transaction —
    // but an unlocked read is still only a snapshot, and the generation worker can change the row in
    // between. That is not hypothetical here: it claims quantity-less rows and moves them to
    // `needs_quantity`, so an edit could correctly requeue a row while recording `pending -> pending`
    // in its own audit event, contradicting the worker event written moments earlier.
    //
    // `FOR UPDATE` makes the snapshot authoritative rather than merely recent: the row cannot change
    // under any of the three callers between reading it and writing it. All three want that — approve
    // and reject read a status and then overwrite it, which is the same check-then-act.
    //
    // Cheap because it is one row by primary key, already inside a transaction that is about to write
    // it. The worker's own claim is a single conditional UPDATE, so the two contend for one row lock
    // and one of them waits rather than either losing an update.
    .for("update");

  return extraction ?? null;
}

function buildUpdatedPricingScopeMetadata(input: {
  existingMetadataJson: unknown;
  normalizedLabel: string | null | undefined;
  divisionHint: string | null | undefined;
  rawLabel: string | null | undefined;
}) {
  const metadata =
    input.existingMetadataJson &&
    typeof input.existingMetadataJson === "object" &&
    input.existingMetadataJson !== null
      ? { ...(input.existingMetadataJson as Record<string, unknown>) }
      : {};

  delete metadata.pricingScopeType;
  delete metadata.pricingScopeKey;
  delete metadata.scopeType;
  delete metadata.scopeKey;

  const pricingScope = resolvePricingScopeFromExtraction({
    divisionHint: input.divisionHint ?? null,
    metadataJson: metadata,
    normalizedIntent: input.normalizedLabel ?? input.rawLabel ?? null,
    rawLabel: input.rawLabel ?? input.normalizedLabel ?? null,
  });

  return {
    ...metadata,
    ...pricingScope,
  };
}

export async function updateEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
  input: {
    normalizedLabel?: string;
    quantity?: string | null;
    unit?: string | null;
    divisionHint?: string | null;
  };
}) {
  const existing = await loadEstimateExtraction(args.tenantDb, args.dealId, args.extractionId);

  if (!existing) {
    throw new AppError(404, "Estimate extraction not found");
  }

  // OMITTED IS NOT THE SAME AS NULL. `?? existing.quantity` collapsed the two: a caller explicitly
  // clearing a quantity had the old value silently restored, so the field could not be emptied at all.
  // `in` distinguishes "the request did not mention quantity" from "the request said null".
  const nextQuantity = "quantity" in args.input ? args.input.quantity ?? null : existing.quantity;

  // SUPPLYING THE MISSING NUMBER MUST PUT THE ROW BACK IN THE QUEUE, or `needs_quantity` is a trap
  // rather than a flag.
  //
  // The generation job marks a quantity-less row `needs_quantity` and skips pricing it. The candidate
  // query then selects non-measurement rows ONLY when `status = 'pending'` — so a row corrected here
  // would keep the flag, never be re-selected, and never produce a pricing recommendation again. The
  // estimator does exactly what the flag asks and the row silently stays dead: worse than the
  // mispricing the flag replaced, because that at least produced a number somebody could challenge.
  //
  // Reset only from a claimable status, and only once a quantity actually exists. `rejected` and
  // `unmatched` mean things this edit has no business rewriting, and a null quantity would send the row
  // back to be flagged again on the next run, which is a loop rather than a fix. The exact claimable
  // list, and why `approved` is on it, is at `statusAfterEdit` below.
  //
  // DECIDED IN SQL, UNDER THE UPDATE'S OWN ROW LOCK, not from the snapshot read above. `existing` is
  // read before this statement takes its lock, so the generation job can claim the row in between:
  // the read sees `pending`, the worker commits `needs_quantity`, and this update then writes the
  // quantity while leaving the flag in place. The row ends up corrected AND excluded from every later
  // candidate query — the same permanent stranding, reached through the opposite interleaving. A
  // JavaScript boolean computed from a stale row cannot see that; a CASE evaluated when the row is
  // locked can.
  //
  /** Module-level now — see `isPriceableQuantity`. Kept as a local alias so the reasoning in the
   *  comments below still reads against a short name. */
  const isPriceable = isPriceableQuantity;

  const suppliesQuantity = isPriceable(nextQuantity);

  /** Numeric where both sides are numbers, so "700" and "700.000" are the same quantity rather than a
   *  spurious edit; identity otherwise, which is what compares two nulls.
   *
   *  ABSENCE IS HANDLED FIRST, and it has to be. `Number(null)` is 0 and `Number(undefined)` is NaN, so
   *  going through the numeric branch made a NULL quantity compare EQUAL to a supplied 0: a PATCH
   *  writing `quantity: 0` onto a null row reported `quantityChanged = false` while the stored value
   *  genuinely changed. "There is no number" and "the number is zero" are different facts about a
   *  quantity, and only the second is a measurement.
   *
   *  LATENT TODAY, AND FIXED ANYWAY. `quantityChanged` has exactly one consumer — `requeuesForPricing`,
   *  which ANDs it with `suppliesQuantity` — and `suppliesQuantity` is false for 0, so the two
   *  disagreeing cases (null->0 and 0->null) reach no branch that behaves differently. There is
   *  therefore no test below that fails on the old comparison, because no observable behaviour changes.
   *  It is corrected because the name states a fact that was untrue, and the next consumer to read it
   *  would inherit the wrong answer silently. */
  const sameQuantity = (left: unknown, right: unknown): boolean => {
    const leftMissing = left === null || left === undefined;
    const rightMissing = right === null || right === undefined;
    if (leftMissing || rightMissing) return leftMissing && rightMissing;

    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
    return left === right;
  };

  // A REAL CHANGE TO THE QUANTITY, which is not the same as the request carrying one.
  //
  // `nextQuantity` falls back to `existing.quantity` when the field is omitted, so on a `processed` row
  // with a valid quantity `suppliesQuantity` is true for EVERY edit — and the requeue added for legacy
  // rows then fired on a label, unit or division change, sending the row back to `pending` and buying a
  // whole generation run for an edit that did not touch pricing at all.
  const quantityProvided = "quantity" in args.input;
  const quantityChanged = quantityProvided && !sameQuantity(nextQuantity, existing.quantity);

  // ANY MOVE FROM PRICEABLE TO UNPRICEABLE, not only a move to null.
  //
  // Restricting this to null left the worst version of the original bug in place: changing a
  // `processed` row's quantity from 700 to "0" — or to a negative, or to "NaN" — satisfied neither
  // branch, so the status was untouched. The row kept `processed`, the worker only reselects ordinary
  // rows at `pending`, and the promote predicate now rejects its stale recommendation. Stranded, unable
  // to be priced, and absent from the needs-quantity bucket that exists to surface exactly that.
  //
  // `existing` is read `FOR UPDATE`, so the "was priceable" half is authoritative rather than a guess.
  const becomesUnpriceable =
    quantityProvided && isPriceable(existing.quantity) && !suppliesQuantity;

  /** A quantity that is both NEW and usable — the only thing that should re-open a priced row. */
  const requeuesForPricing = quantityChanged && suppliesQuantity;

  // `processed` REQUEUES TOO, not just `needs_quantity`. Rows priced BEFORE this branch existed were
  // priced with a null quantity treated as one unit, and they sit at `processed`. Supplying the real
  // quantity for one of those left it `processed` — excluded from the worker's ordinary-row filter, so
  // never re-priced — while the promote predicate now sees a live positive quantity and would happily
  // admit the OLD recommendation, the one computed from a quantity of 1. Correcting the number would
  // have made the wrong price MORE likely to ship, not less.
  //
  // Requeuing on any quantity change is right beyond that legacy case: a priced row whose quantity
  // moved needs re-pricing, and `pending` is how this system says so.
  //
  // `approved` REQUEUES TOO — and the two branches below differ about it ON PURPOSE.
  //
  // Holding `approved` on a NEW usable quantity stranded the row. The worker reselects ordinary
  // extractions only at `status = 'pending'`, so it was never re-priced; meanwhile the promote
  // predicate in draft-estimate-service.ts refuses its stored recommendation, because that
  // recommendation was computed from the quantity the estimator has just replaced. Neither repriceable
  // nor promotable, with nothing on the screen to explain it — the same dead end the `processed` case
  // above describes, reached through the review path instead of the pricing one.
  //
  // That is not undoing somebody's review. The approval was a statement about a row whose quantity has
  // since changed; `estimate_review_events` still records both the approval and this edit; and
  // `pending` is the only way this system says "needs pricing". Re-approving after the re-price is the
  // honest cost, and the workbench's `approved` count becomes accurate rather than merely stable.
  //
  // THE CLEARING BRANCH KEEPS ITS RESTRAINT, because the asymmetry is real: a cleared quantity leaves
  // nothing to re-price, so reopening the row buys no repair and still costs a human decision — and
  // the promote predicate already holds that row back. Supplying a usable number is the opposite: the
  // row CAN be repaired, and only `pending` repairs it.
  //
  // `rejected` is excluded from both. It is a decision not to include this line at all, so it is not
  // stranded by staying put, and requeuing it would push a refused row back into pricing.
  //
  // `unmatched` REQUEUES TOO, and its absence made this branch a ONE-WAY DOOR. The clearing branch
  // above deliberately sends an `unmatched` row to `needs_quantity` — so the system already accepts
  // that `unmatched` is a state a quantity edit may move a row out of. Leaving it off the usable-
  // quantity list meant the return trip did not exist: a row the worker marked `unmatched` sits outside
  // its `pending` candidate filter, so nothing re-prices it, and supplying or correcting the quantity
  // left it exactly where it was. Both exits from that room were closed, which is precisely the
  // stranding this whole branch exists to prevent, reached by the one status the list forgot.
  //
  // Decided in SQL for the same reason the requeue is: `existing` is authoritative only until this
  // statement takes its own lock, and the CASE is evaluated when the row is held.
  const statusAfterEdit = becomesUnpriceable
    ? sql`case when ${estimateExtractions.status} in ('pending', 'needs_quantity', 'processed', 'unmatched') then 'needs_quantity' else ${estimateExtractions.status} end`
    : sql`case when ${estimateExtractions.status} in ('needs_quantity', 'processed', 'approved', 'unmatched') then 'pending' else ${estimateExtractions.status} end`;

  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      normalizedLabel: args.input.normalizedLabel ?? existing.normalizedLabel,
      quantity: nextQuantity,
      ...(requeuesForPricing || becomesUnpriceable ? { status: statusAfterEdit } : {}),
      unit: args.input.unit ?? existing.unit,
      divisionHint: args.input.divisionHint ?? existing.divisionHint,
      metadataJson: buildUpdatedPricingScopeMetadata({
        existingMetadataJson: existing.metadataJson,
        normalizedLabel: args.input.normalizedLabel ?? existing.normalizedLabel,
        divisionHint: args.input.divisionHint ?? existing.divisionHint,
        rawLabel: existing.rawLabel ?? existing.normalizedLabel ?? null,
      }),
      updatedAt: new Date(),
    })
    // SCOPED BY DEAL, like its approve and reject siblings. The id alone was enough while the row was
    // only read back for its own fields; it stopped being enough the moment `updated.status` is
    // dereferenced below, because a mismatch now throws a TypeError where the siblings return a clean
    // 404. `loadEstimateExtraction` already refused a foreign deal, so this is defence in depth rather
    // than a hole being closed — but the two statements should not disagree about what they address.
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .returning();

  // The locked read above makes this unreachable in practice: the row was found, and held, moments ago.
  // Guarded anyway because the alternative is a TypeError on the next line, and "not found" is the
  // answer the two sibling verbs already give for the same shape.
  if (!updated) {
    throw new AppError(404, "Estimate extraction not found");
  }

  // REQUEUING DOES NOT UNDO THE LINE THIS ROW ALREADY PRODUCED.
  //
  // When a `processed` or `approved` extraction has already been PROMOTED, its estimate_line_items
  // row is sitting in a client-facing estimate at the OLD number. Moving the extraction back to
  // `pending` makes it re-price, and duplicate grouping is scoped to the new generation run — so
  // approving and promoting the correction adds a SECOND line while the first stays in the total.
  // The edit that was supposed to fix a number ends up double-counting it.
  //
  // FLAGGED, NOT RETIRED, and that is a deliberate choice rather than the easy one. Migration 0215
  // states the policy for the identical situation on historical rows: "this migration will not
  // silently alter a number a client has been shown: removing or rewriting an already-quoted line is
  // an estimator's decision, and one that needs the deal in front of them." Retiring or rewriting
  // the line here would have this service quietly edit a client-facing estimate as a side effect of
  // a quantity correction, which is a much larger behavioural step than making the problem visible.
  // Same event type, subject and shape 0215 uses, so the two arrive in the review feed identically.
  //
  // Only when the requeue ACTUALLY happened: `statusAfterEdit` is a SQL CASE resolved under the row
  // lock, so `updated.status` is the only thing that knows whether this edit moved the row.
  if (requeuesForPricing && updated.status === "pending" && existing.status !== "pending") {
    const promoted = await args.tenantDb
      .select({
        lineItemId: estimatePricingRecommendations.promotedEstimateLineItemId,
        recommendationId: estimatePricingRecommendations.id,
      })
      .from(estimatePricingRecommendations)
      .innerJoin(
        estimateExtractionMatches,
        eq(estimatePricingRecommendations.extractionMatchId, estimateExtractionMatches.id)
      )
      .where(
        and(
          eq(estimateExtractionMatches.extractionId, args.extractionId),
          sql`${estimatePricingRecommendations.promotedEstimateLineItemId} is not null`
        )
      );

    for (const row of promoted) {
      if (!row.lineItemId) continue;
      await insertReviewEvent(args.tenantDb, {
        dealId: args.dealId,
        subjectType: "estimate_line_item",
        subjectId: row.lineItemId,
        eventType: "remediation_required",
        userId: args.userId,
        beforeJson: {
          extractionId: args.extractionId,
          recommendationId: row.recommendationId,
          previousQuantity: existing.quantity,
        },
        afterJson: { correctedQuantity: updated.quantity },
        reason:
          "The extraction behind this line was corrected from " +
          `${existing.quantity ?? "none"} to ${updated.quantity ?? "none"} and requeued for ` +
          "re-pricing. This line still carries the OLD number and is still counted in the estimate " +
          "total, so promoting the corrected recommendation will add a second line beside it. " +
          "Re-price or void this line; nothing has been changed automatically.",
      });
    }
  }

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "edited",
    userId: args.userId,
    beforeJson: {
      // STATUS IS PART OF THIS EDIT when it supplies a missing quantity — the row moves from
      // `needs_quantity` back to `pending`, which is what makes it eligible for pricing again. The
      // approve and reject paths in this service record their transitions; an edit that silently
      // requeues a row leaves the history unable to explain why it started being priced.
      status: existing.status,
      normalizedLabel: existing.normalizedLabel,
      quantity: existing.quantity,
      unit: existing.unit,
      divisionHint: existing.divisionHint,
    },
    afterJson: {
      // Read off the UPDATED row rather than recomputed here: the reset is a SQL CASE evaluated under
      // the row lock, so the database is the only thing that knows what it actually resolved to.
      status: updated.status,
      normalizedLabel: updated.normalizedLabel,
      quantity: updated.quantity,
      unit: updated.unit,
      divisionHint: updated.divisionHint,
    },
  });

  return { extraction: updated, reviewEvent };
}

export async function approveEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
}) {
  const existing = await loadEstimateExtraction(args.tenantDb, args.dealId, args.extractionId);

  if (!existing) {
    throw new AppError(404, "Estimate extraction not found");
  }

  // NO QUANTITY GUARD HERE, and the absence is deliberate — an earlier revision of this file added
  // one and it was wrong twice over.
  //
  // WRONG IN BLAST RADIUS: `extractEstimateScopeRows` (extraction-service.ts) creates EVERY
  // deterministically-parsed `scope_line` with `quantity: null`, so refusing approval on an
  // unpriceable quantity refused approval on essentially every parsed row until somebody typed a
  // number in. It also refused rows that are genuinely promotable: promotion admits a `manual`
  // recommendation and a positive `overrideQuantity` WITHOUT consulting the extraction's quantity
  // (draft-estimate-service.ts), so a row with a manual row anchored to it prices perfectly well
  // while the guard insisted it could not be priced.
  //
  // WRONG IN PLACE: `estimate_extractions.status = 'approved'` feeds only the workbench counter and
  // the requeue CASE below. The status that actually gates promotion lives on the RECOMMENDATION and
  // is set by `approveEstimatePricingRecommendation`, which has no such guard — so blocking here
  // stopped nothing from being promoted, it only removed a way to clear the queue.
  //
  // The underlying report was real: approving DOES remove a row from the needs-quantity bucket
  // without making it priceable. But the remedy has to be aimed at the recommendation and
  // conditioned on there being no promotable path, not a blanket refusal on the extraction. Left
  // open deliberately rather than papered over — see the PR discussion.

  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      status: "approved",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "approved",
    userId: args.userId,
    beforeJson: {
      status: existing.status,
      normalizedLabel: existing.normalizedLabel,
      quantity: existing.quantity,
      unit: existing.unit,
      divisionHint: existing.divisionHint,
    },
    afterJson: {
      status: "approved",
      normalizedLabel: updated.normalizedLabel,
      quantity: updated.quantity,
      unit: updated.unit,
      divisionHint: updated.divisionHint,
    },
  });

  return { extraction: updated, reviewEvent };
}

export async function rejectEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
  reason?: string | null;
}) {
  const existing = await loadEstimateExtraction(args.tenantDb, args.dealId, args.extractionId);

  if (!existing) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      status: "rejected",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "rejected",
    userId: args.userId,
    beforeJson: {
      status: existing.status,
      normalizedLabel: existing.normalizedLabel,
      quantity: existing.quantity,
      unit: existing.unit,
      divisionHint: existing.divisionHint,
    },
    afterJson: {
      status: "rejected",
      normalizedLabel: updated.normalizedLabel,
      quantity: updated.quantity,
      unit: updated.unit,
      divisionHint: updated.divisionHint,
    },
    reason: args.reason ?? null,
  });

  return { extraction: updated, reviewEvent };
}
