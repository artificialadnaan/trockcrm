// AGAINST A REAL POSTGRES, because the sibling suite cannot be.
//
// extraction-review-service.test.ts drives a mocked `tenantDb`: it proves which expression was SENT,
// which is the only thing a mock can prove. It cannot say whether that expression parses, whether the
// CASE resolves to the status the comment claims, or whether the correlated sub-select finds the
// recommendation it is written to find — and the fix under test is almost entirely SQL. A mock will
// hold `sql\`case when ... end\`` just as happily when it is invalid.
//
// So this file asserts the OUTCOME: seed the row shapes that exist in production, run the service, read
// the table back.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  estimateExtractionMatches,
  estimateExtractions,
  estimatePricingRecommendations,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { updateEstimateExtraction } from "../../../src/modules/estimating/extraction-review-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("d1");
const DOCUMENT = U("d2");
const USER = U("d3");
const EXTRACTION = U("e1");
const MATCH = U("a1");
const ORDINARY_RECOMMENDATION = U("b1");
const MANUAL_RECOMMENDATION = U("b2");
const PROMOTED_RECOMMENDATION = U("b3");
const PROMOTED_LINE_ITEM = U("c1");

let pg: PGlite;
// Typed loosely for the same reason the walkthrough runtime suites are: the service is typed against
// NodePgDatabase and the PGlite driver is wire-compatible, not structurally identical.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

/** The legacy shape, and the reason this fix exists: `needs_quantity` did not exist when this row was
 *  priced, so a null quantity became `Number(null ?? 1)` = one unit and the row was marked `processed`
 *  for it. The recommendation below still carries that invented 1. */
async function seedLegacyPricedRow() {
  await tenantDb.insert(estimateExtractions).values({
    id: EXTRACTION,
    dealId: DEAL,
    documentId: DOCUMENT,
    extractionType: "scope_item",
    rawLabel: "Replace wall base throughout",
    normalizedLabel: "replace wall base throughout",
    quantity: null,
    unit: "LF",
    divisionHint: "09",
    status: "processed",
  });

  await tenantDb.insert(estimateExtractionMatches).values({
    id: MATCH,
    extractionId: EXTRACTION,
    matchType: "catalog_plus_history",
    status: "selected",
  });

  await tenantDb.insert(estimatePricingRecommendations).values([
    {
      id: ORDINARY_RECOMMENDATION,
      dealId: DEAL,
      extractionMatchId: MATCH,
      sourceType: "extracted",
      normalizedIntent: "replace wall base throughout",
      sourceRowIdentity: `extracted:${EXTRACTION}`,
      recommendedQuantity: "1.000",
      recommendedUnitPrice: "3.25",
      recommendedTotalPrice: "3.25",
      priceBasis: "catalog",
      status: "approved",
    },
    // A MANUAL row hanging off the same match. It promotes its own `manualQuantity` and this extraction
    // is only its active-artifact anchor, so the correction says nothing about it — the promote query
    // exempts it for the same reason, and sweeping it would make a hand-entered line vanish as
    // `recommendation_unavailable`.
    {
      id: MANUAL_RECOMMENDATION,
      dealId: DEAL,
      extractionMatchId: MATCH,
      sourceType: "manual",
      normalizedIntent: "hand entered line",
      sourceRowIdentity: `manual:${EXTRACTION}`,
      manualQuantity: "12.000",
      manualUnitPrice: "40.00",
      recommendedQuantity: "12.000",
      priceBasis: "manual",
      status: "approved",
    },
    // Already on an estimate. Changing a status cannot unmake the line item, and reviewing a promoted
    // recommendation is a 409 — correcting what has been issued is an estimate revision, not a side
    // effect of an edit.
    {
      id: PROMOTED_RECOMMENDATION,
      dealId: DEAL,
      extractionMatchId: MATCH,
      sourceType: "extracted",
      normalizedIntent: "already promoted",
      sourceRowIdentity: `extracted:promoted:${EXTRACTION}`,
      recommendedQuantity: "1.000",
      promotedEstimateLineItemId: PROMOTED_LINE_ITEM,
      priceBasis: "catalog",
      status: "approved",
    },
  ]);
}

async function readStatuses() {
  const [extraction] = await tenantDb
    .select({ status: estimateExtractions.status, quantity: estimateExtractions.quantity })
    .from(estimateExtractions)
    .where(eq(estimateExtractions.id, EXTRACTION));

  const recommendations = await tenantDb
    .select({ id: estimatePricingRecommendations.id, status: estimatePricingRecommendations.status })
    .from(estimatePricingRecommendations)
    .where(eq(estimatePricingRecommendations.dealId, DEAL));

  return {
    extraction,
    statusOf: (id: string) =>
      recommendations.find((row: { id: string }) => row.id === id)?.status ?? null,
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [
      estimateExtractions,
      estimateExtractionMatches,
      estimatePricingRecommendations,
      estimateReviewEvents,
    ])
  );
  tenantDb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(
    "truncate estimate_review_events, estimate_pricing_recommendations, estimate_extraction_matches, estimate_extractions"
  );
});

describe("correcting a quantity that was never supplied", () => {
  it("requeues the legacy processed row and retires the price built on the invented 1", async () => {
    await seedLegacyPricedRow();

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: EXTRACTION,
      userId: USER,
      input: { quantity: "700.000" },
    });

    const { extraction, statusOf } = await readStatuses();

    // REQUEUED. Without this the row keeps `processed`, the worker's ordinary-row candidate filter
    // (`status = 'pending'`) never selects it again, and the estimator has no way to tell: the edit
    // succeeded and the row shows the right number next to the price of one unit, permanently.
    expect(extraction.status).toBe("pending");
    expect(Number(extraction.quantity)).toBe(700);

    // AND THE STALE APPROVAL IS GONE. The promote's quantity predicate asks about the LIVE quantity,
    // which this edit has just made valid — so the gate holding this recommendation back opens at the
    // exact moment the recommendation becomes wrong, and its `1` reaches a client estimate under
    // somebody's approval.
    expect(statusOf(ORDINARY_RECOMMENDATION)).toBe("pending_review");
    expect(statusOf(MANUAL_RECOMMENDATION)).toBe("approved");
    expect(statusOf(PROMOTED_RECOMMENDATION)).toBe("approved");

    const events = await tenantDb
      .select({
        subjectType: estimateReviewEvents.subjectType,
        subjectId: estimateReviewEvents.subjectId,
        beforeJson: estimateReviewEvents.beforeJson,
        reason: estimateReviewEvents.reason,
      })
      .from(estimateReviewEvents)
      .where(eq(estimateReviewEvents.dealId, DEAL))
      .orderBy(estimateReviewEvents.createdAt, estimateReviewEvents.id);

    // ONLY the recommendation that was actually swept gets an event — not one per row considered.
    const recommendationEvents = events.filter(
      (row: { subjectType: string }) => row.subjectType === "estimate_pricing_recommendation"
    );
    expect(recommendationEvents).toHaveLength(1);

    const [event] = recommendationEvents;
    expect(event.subjectId).toBe(ORDINARY_RECOMMENDATION);
    // The history has to say which decision was dropped and what it was computed from. "Status changed"
    // gives a reviewer no reason to look.
    expect(event.beforeJson).toMatchObject({ status: "approved", recommendedQuantity: "1.000" });
    expect(event.reason).toContain("unpriceable");

    // The edit's own event comes FIRST, so the history reads in the order it happened: the estimator
    // supplied a number, and this is what supplying it invalidated.
    expect(events[0].subjectType).toBe("estimate_extraction");
  });

  it("leaves an approved price alone when the stored quantity was already priceable", async () => {
    // THE TWO RULES ARE DELIBERATELY DIFFERENT WIDTHS, and this is where they part company. The row is
    // still requeued — a priced row whose quantity moved needs re-pricing — but the approval stands.
    // Editing 700 to 800 is a re-pricing question, not an invalidated decision: the price behind it was
    // computed from a number a human actually stated. Dropping it would cost a re-review on every
    // ordinary quantity edit.
    await seedLegacyPricedRow();
    await tenantDb
      .update(estimateExtractions)
      .set({ quantity: "700.000" })
      .where(eq(estimateExtractions.id, EXTRACTION));

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: EXTRACTION,
      userId: USER,
      input: { quantity: "800.000" },
    });

    const { extraction, statusOf } = await readStatuses();

    expect(extraction.status).toBe("pending");
    expect(statusOf(ORDINARY_RECOMMENDATION)).toBe("approved");
  });

  it("does not requeue a row a human decided, and still retires the price built on the invented 1", async () => {
    // The deliberate asymmetry, and the one that is easiest to flatten by accident. `approved` on the
    // EXTRACTION is a judgement about the line, and this edit has no business rewriting it. The approved
    // RECOMMENDATION is a judgement about a price computed from a quantity nobody supplied.
    await seedLegacyPricedRow();
    await tenantDb
      .update(estimateExtractions)
      .set({ status: "approved" })
      .where(eq(estimateExtractions.id, EXTRACTION));

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: EXTRACTION,
      userId: USER,
      input: { quantity: "700.000" },
    });

    const { extraction, statusOf } = await readStatuses();

    expect(extraction.status).toBe("approved");
    expect(statusOf(ORDINARY_RECOMMENDATION)).toBe("pending_review");
  });

  it("parks a priced row at needs_quantity when its quantity is taken away", async () => {
    // The opposite direction, kept here so the two halves of the transition are proven against the same
    // database. A `processed` row whose quantity became unpriceable is otherwise stranded: the worker
    // reselects ordinary rows only at `pending`, and the promote now refuses its recommendation.
    await seedLegacyPricedRow();
    await tenantDb
      .update(estimateExtractions)
      .set({ quantity: "700.000" })
      .where(eq(estimateExtractions.id, EXTRACTION));

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: EXTRACTION,
      userId: USER,
      input: { quantity: "0" },
    });

    const { extraction, statusOf } = await readStatuses();

    expect(extraction.status).toBe("needs_quantity");
    // Nothing is swept in this direction: the promote's own quantity predicate already refuses a
    // recommendation whose extraction has no priceable quantity, so the approval is not yet wrong.
    expect(statusOf(ORDINARY_RECOMMENDATION)).toBe("approved");
  });
});
