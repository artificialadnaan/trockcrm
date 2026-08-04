import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
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
    // Defaults to the extraction because that is what three of this file's four callers are about. The
    // fourth records a status change on `estimate_pricing_recommendations`, and an event filed under the
    // wrong subject is worse than no event: it is answerable only by someone who already knows to look
    // at the other table.
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

/**
 * Drops the review decision on any recommendation whose price was computed from a quantity that was
 * never supplied, once the real quantity arrives.
 *
 * WHY THIS IS NOT COVERED BY THE PROMOTE PREDICATE. `loadApprovedRecommendationsForRun` refuses a
 * recommendation whose extraction has no priceable quantity — but it asks about the LIVE quantity, and
 * the correction has just made that quantity valid. So the gate that was holding the stale row back
 * swings open at the exact moment the row becomes wrong: the extraction now says 700, the approved
 * recommendation still says the `1` the old pricer invented, and the promote reads its numbers off the
 * recommendation. A client-facing line for one unit, carrying a human's approval, produced by an edit
 * that was correct.
 *
 * SENT BACK TO REVIEW, NOT REJECTED. The approval was a real judgement about a real row; what it was
 * not is a judgement about 700. `pending_review` is the value `reviewEstimatePricingRecommendation`
 * already writes for "somebody has to look at this again" — every consumer maps it to a non-promotable
 * state, so nothing here needs a new status or a migration to be understood.
 *
 * ALREADY-PROMOTED ROWS ARE LEFT ALONE. Their line item exists; changing the recommendation's status
 * would not unmake it, and `reviewEstimatePricingRecommendation` refuses to review a promoted row at
 * all (409). Re-promotion is already blocked by `promotable`. Correcting what is on an issued estimate
 * is an estimate revision, not a side effect of an edit.
 *
 * MANUAL ROWS ARE EXEMPT, on `sourceType` and for exactly the reason the promote query is: a manual
 * recommendation carries its own `manualQuantity`, and its extraction match exists only as an
 * active-artifact anchor. It was never priced from this quantity, so this correction says nothing
 * about it.
 */
async function sendStaleRecommendationsBackToReview(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
  correctedQuantity: string | null;
}) {
  // KEYED ON THE MATCH JOIN, not on `sourceExtractionId`, because that is the path the promote query
  // travels: anything it can admit for this extraction has to be something this can reach. The column
  // is also nullable and `on delete set null`, and the rows at issue here are the oldest ones in the
  // table — keying on it would miss precisely the population this exists for.
  const stale = await args.tenantDb
    .select({
      id: estimatePricingRecommendations.id,
      status: estimatePricingRecommendations.status,
      recommendedQuantity: estimatePricingRecommendations.recommendedQuantity,
    })
    .from(estimatePricingRecommendations)
    .where(
      and(
        eq(estimatePricingRecommendations.dealId, args.dealId),
        // Only the promotable states. `pending`, `pending_review` and `rejected` cannot reach an
        // estimate, so rewriting them would churn rows without removing any risk.
        inArray(estimatePricingRecommendations.status, ["approved", "overridden"]),
        ne(estimatePricingRecommendations.sourceType, "manual"),
        isNull(estimatePricingRecommendations.promotedEstimateLineItemId),
        inArray(
          estimatePricingRecommendations.extractionMatchId,
          args.tenantDb
            .select({ id: estimateExtractionMatches.id })
            .from(estimateExtractionMatches)
            .where(eq(estimateExtractionMatches.extractionId, args.extractionId))
        )
      )
    )
    // Read before the write and held, so the event below can state which decision was dropped. RETURNING
    // hands back the new status, not the one being replaced, and "approved or overridden, we did not
    // record which" is not an audit trail anybody can act on.
    //
    // THIS TAKES ITS LOCKS IN THE OPPOSITE ORDER TO THE PROMOTE, which locks recommendations and then
    // the joined extraction in one statement while the caller here locked the extraction first. Stated
    // rather than hidden: a promote running concurrently with this edit can deadlock, and Postgres ends
    // it by aborting one of them (40P01) — a failed request, not a lost update. The inversion is not
    // caused by this `for update`; writing the recommendation at all creates it. Dropping the lock would
    // only trade a detected abort for silently overwriting a decision made in the same window.
    .for("update");

  if (stale.length === 0) return;

  const staleIds = stale.map((recommendation) => recommendation.id);

  await args.tenantDb
    .update(estimatePricingRecommendations)
    .set({ status: "pending_review", updatedAt: new Date() })
    .where(
      and(
        eq(estimatePricingRecommendations.dealId, args.dealId),
        inArray(estimatePricingRecommendations.id, staleIds)
      )
    );

  for (const recommendation of stale) {
    await insertReviewEvent(args.tenantDb, {
      dealId: args.dealId,
      subjectType: "estimate_pricing_recommendation",
      subjectId: recommendation.id,
      // The same event type `reviewEstimatePricingRecommendation` writes for this transition, so a
      // reader filtering the recommendation's history does not have to know this caller exists. What
      // makes it legible is `reason` plus the quantity on both sides.
      eventType: "pending_review",
      userId: args.userId,
      beforeJson: {
        status: recommendation.status,
        recommendedQuantity: recommendation.recommendedQuantity,
      },
      afterJson: {
        status: "pending_review",
        extractionQuantity: args.correctedQuantity,
      },
      reason:
        "Extraction quantity corrected from an unpriceable value; the approved price was computed " +
        "without one",
    });
  }
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
  // Reset only from `needs_quantity`, and only once a quantity actually exists. Any other status is
  // somebody else's state machine — `approved`, `unmatched`, `overridden` all mean things this edit has
  // no business rewriting — and a null quantity would send the row back to be flagged again on the next
  // run, which is a loop rather than a fix.
  //
  // DECIDED IN SQL, UNDER THE UPDATE'S OWN ROW LOCK, not from the snapshot read above. `existing` is
  // read before this statement takes its lock, so the generation job can claim the row in between:
  // the read sees `pending`, the worker commits `needs_quantity`, and this update then writes the
  // quantity while leaving the flag in place. The row ends up corrected AND excluded from every later
  // candidate query — the same permanent stranding, reached through the opposite interleaving. A
  // JavaScript boolean computed from a stale row cannot see that; a CASE evaluated when the row is
  // locked can.
  //
  /** The one definition of "can be priced", shared by every decision below. Mirrors the worker's own
   *  guard and `applyMarketRateAdjustment`: absent, non-finite and nonpositive are all unpriceable. */
  const isPriceable = (value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0;
  };

  const suppliesQuantity = isPriceable(nextQuantity);

  /** Numeric where both sides are numbers, so "700" and "700.000" are the same quantity rather than a
   *  spurious edit; identity otherwise, which is what compares two nulls. */
  const sameQuantity = (left: unknown, right: unknown): boolean => {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
    return (left ?? null) === (right ?? null);
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
  // THE REQUEUE ALONE DOES NOT RETIRE THE OLD PRICE. `pending` asks for a new recommendation; it does
  // nothing to the approved one already sitting there, and the promote reads its numbers off the
  // recommendation rather than the extraction. See `sendStaleRecommendationsBackToReview` below, which
  // closes the other half of that window.
  //
  // AND IT DOES NOT OVERWRITE A HUMAN DECISION. `approved`, `rejected` and `overridden` are somebody's
  // judgement about this row; making a quantity unpriceable is a reason to stop PRICING it, never a
  // reason to silently undo a review. Those rows are held out of the promote by the quantity predicate
  // in draft-estimate-service.ts, which is where the harm actually was.
  //
  // Decided in SQL for the same reason the requeue is: `existing` is authoritative only until this
  // statement takes its own lock, and the CASE is evaluated when the row is held.
  const statusAfterEdit = becomesUnpriceable
    ? sql`case when ${estimateExtractions.status} in ('pending', 'needs_quantity', 'processed', 'unmatched') then 'needs_quantity' else ${estimateExtractions.status} end`
    : sql`case when ${estimateExtractions.status} in ('needs_quantity', 'processed') then 'pending' else ${estimateExtractions.status} end`;

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

  // NARROWER THAN THE REQUEUE ABOVE, deliberately. The requeue fires on any real quantity change,
  // because a priced row whose quantity moved needs re-pricing. Retiring somebody's APPROVAL is a
  // heavier act, and it is warranted by one thing only: the price was computed from a quantity nobody
  // supplied. An edit from 700 to 800 changes what the recommendation should say — a re-pricing
  // question — but the approval behind it was still a judgement about a number a human stated, and
  // dropping it would cost a re-review on every ordinary quantity edit.
  const correctsUnpriceable = quantityChanged && !isPriceable(existing.quantity) && suppliesQuantity;

  // AFTER the edit's own event, so the history reads in the order it happened: the estimator supplied a
  // number, and these are the decisions that supplying it invalidated. One transaction either way —
  // `tenantMiddleware` holds it open — so nothing here can commit without the edit that caused it.
  if (correctsUnpriceable) {
    await sendStaleRecommendationsBackToReview({
      tenantDb: args.tenantDb,
      dealId: args.dealId,
      extractionId: args.extractionId,
      userId: args.userId,
      correctedQuantity: nextQuantity,
    });
  }

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
