// The promote gate, EXECUTED rather than described.
//
// This file replaces a suite that asserted SUBSTRINGS of the drizzle SQL text — `toContain("> 0")`,
// `toContain("NaN")`, `toContain("is distinct from")` — and never ran the query. Those assertions
// cannot fail for the reason they claim: replacing the whole predicate with `sql\`( 1 = 1 or …\``,
// which is TRUE for every row and admits everything, left all 23 of them green. A test that passes
// against an open gate is not testing the gate.
//
// Everything here runs the SHIPPING query against a real Postgres (PGlite), over tables derived from
// the REAL Drizzle definitions — so `numeric(14,3)` is numeric, and `'NaN'::numeric` sorts the way
// Postgres sorts it (ABOVE every finite value, which is why a bare `> 0` test would admit it). Rows
// that must promote and rows that must not are seeded side by side, and the assertion is on the ids
// the query RETURNS.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  estimateExtractionMatches,
  estimateExtractions,
  estimateLineItems,
  estimatePricingRecommendationOptions,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSections,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  loadApprovedRecommendationsForRun,
  promoteApprovedRecommendationsToEstimate,
} from "../../../src/modules/estimating/draft-estimate-service.js";

const U = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const DEAL = U("d1");
// Hex-only suffixes: these are real `uuid` columns, so "r1" is not a uuid.
const RUN = U("e11");
const OTHER_RUN = U("e22");
const DOCUMENT = U("f1");

let pg: PGlite;
// The service is typed against NodePgDatabase and the PGlite driver is wire-compatible rather than
// structurally identical — the same loosening every other runtime suite in this repo applies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

/** One extraction + match + recommendation chain, which is the shape the promote query joins over. */
async function seedCandidate(input: {
  /** Used to name the row in assertions AND to derive its ids, so a failure says which case broke. */
  key: string;
  extractionQuantity: string | null;
  recommendedQuantity?: string | null;
  sourceType?: string;
  selectedSourceType?: string | null;
  overrideQuantity?: string | null;
  manualQuantity?: string | null;
  manualUnitPrice?: string | null;
  status?: string;
  runId?: string;
}) {
  const seq = seedCounter++;
  const extractionId = U(`a${seq}`);
  const matchId = U(`b${seq}`);
  const recommendationId = U(`c${seq}`);

  await tenantDb.insert(estimateExtractions).values({
    id: extractionId,
    dealId: DEAL,
    documentId: DOCUMENT,
    extractionType: "scope_line",
    rawLabel: input.key,
    normalizedLabel: input.key,
    quantity: input.extractionQuantity,
    status: "processed",
  });
  await tenantDb.insert(estimateExtractionMatches).values({
    id: matchId,
    extractionId,
    matchType: "catalog",
  });
  await tenantDb.insert(estimatePricingRecommendations).values({
    id: recommendationId,
    dealId: DEAL,
    extractionMatchId: matchId,
    sourceType: input.sourceType ?? "extracted",
    normalizedIntent: input.key,
    sourceRowIdentity: `extracted:${extractionId}`,
    createdByRunId: input.runId ?? RUN,
    selectedSourceType: input.selectedSourceType ?? null,
    overrideQuantity: input.overrideQuantity ?? null,
    manualLabel: input.sourceType === "manual" ? input.key : null,
    manualQuantity: input.manualQuantity ?? null,
    manualUnitPrice: input.manualUnitPrice ?? null,
    recommendedQuantity:
      input.recommendedQuantity === undefined ? input.extractionQuantity : input.recommendedQuantity,
    recommendedUnitPrice: "250.00",
    priceBasis: "catalog",
    status: input.status ?? "approved",
  });

  return { key: input.key, extractionId, matchId, recommendationId };
}

let seedCounter = 1;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [
      estimateExtractions,
      estimateExtractionMatches,
      estimatePricingRecommendations,
      estimatePricingRecommendationOptions,
      estimateSections,
      estimateLineItems,
      estimateReviewEvents,
    ])
  );
  tenantDb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  seedCounter = 1;
  await pg.exec(`
    TRUNCATE estimate_review_events, estimate_line_items, estimate_sections,
             estimate_pricing_recommendation_options, estimate_pricing_recommendations,
             estimate_extraction_matches, estimate_extractions;
  `);
});

async function gatedIds() {
  const rows = await loadApprovedRecommendationsForRun(tenantDb, DEAL, RUN, undefined, {
    requirePriceableQuantity: true,
  });

  return rows.map((row) => row.recommendationId).sort();
}

describe("the promote gate, run against a database", () => {
  it("ADMITS a live positive quantity and REFUSES every unpriceable one", async () => {
    // The whole point of the gate: a recommendation outlives the quantity it was computed from, and an
    // approval is a statement about the recommendation. Nothing between clearing a quantity and the
    // estimate looked at the extraction again.
    const healthy = await seedCandidate({ key: "healthy", extractionQuantity: "700" });
    const cleared = await seedCandidate({ key: "cleared", extractionQuantity: null });
    const zero = await seedCandidate({ key: "zero", extractionQuantity: "0" });
    const negative = await seedCandidate({ key: "negative", extractionQuantity: "-5" });
    // NaN is the case a substring assertion could never prove. Postgres orders numeric NaN ABOVE every
    // finite value, so `NaN > 0` is TRUE — a positive test alone admits it into a client estimate.
    const notANumber = await seedCandidate({ key: "nan", extractionQuantity: "NaN" });

    expect(await gatedIds()).toEqual([healthy.recommendationId]);
    // Named individually so a failure says WHICH unpriceable shape leaked through.
    for (const refused of [cleared, zero, negative, notANumber]) {
      expect(await gatedIds()).not.toContain(refused.recommendationId);
    }
  });

  it("REFUSES a corrected extraction whose recommendation was priced from the OLD number", async () => {
    // The repair path, which live-and-positive alone does not catch. Migration 0215 parks a row that was
    // fabricated as one unit; the estimator supplies the real 700; the recommendation still holds the
    // fabricated 1 and `resolvePromotionLineValues` still promotes THAT. Refused so the row must
    // re-price, which is the only thing that actually repairs it.
    const repaired = await seedCandidate({
      key: "repaired",
      extractionQuantity: "700",
      recommendedQuantity: "1",
    });
    const rePriced = await seedCandidate({
      key: "re-priced",
      extractionQuantity: "700",
      recommendedQuantity: "700",
    });

    expect(await gatedIds()).toEqual([rePriced.recommendationId]);
    expect(await gatedIds()).not.toContain(repaired.recommendationId);
  });

  it("compares the quantities as NUMBERS, so 700 and 700.000 are the same quantity", async () => {
    // `numeric(14,3)` round-trips as text. A string comparison would refuse a genuinely ready row, which
    // is the worse direction of the same disagreement.
    const scaled = await seedCandidate({
      key: "scaled",
      extractionQuantity: "700",
      recommendedQuantity: "700.000",
    });

    expect(await gatedIds()).toEqual([scaled.recommendationId]);
  });

  it("EXEMPTS an override with its own quantity, and holds that quantity to the same standard", async () => {
    // `resolvePromotionLineValues` does `case "override": quantity = row.overrideQuantity ?? quantity`,
    // so for these rows the anchor extraction's quantity is not the number that reaches the estimate —
    // gating on it dropped a complete override. The exemption is NOT unconditional: an override
    // carrying 0, a negative or NaN must fail, or the widening reintroduces the very bug being removed.
    const withQuantity = await seedCandidate({
      key: "override-25",
      extractionQuantity: null,
      recommendedQuantity: null,
      selectedSourceType: "override",
      overrideQuantity: "25",
    });
    const overrideZero = await seedCandidate({
      key: "override-0",
      extractionQuantity: "700",
      selectedSourceType: "override",
      overrideQuantity: "0",
    });
    const overrideNegative = await seedCandidate({
      key: "override--5",
      extractionQuantity: "700",
      selectedSourceType: "override",
      overrideQuantity: "-5",
    });
    const overrideNaN = await seedCandidate({
      key: "override-nan",
      extractionQuantity: "700",
      selectedSourceType: "override",
      overrideQuantity: "NaN",
    });

    // THE ALTERNATIVES ARE MUTUALLY EXCLUSIVE, and the three refused rows above prove it: each has a
    // PERFECTLY HEALTHY extraction (700, matching its recommendation). If the extraction alternative
    // were unguarded it would rescue them — and `resolvePromotionLineValues` prefers a non-null
    // override, so the estimate would carry the INVALID override number on a row the workbench
    // simultaneously calls unpromotable.
    expect(await gatedIds()).toEqual([withQuantity.recommendationId]);
  });

  it("does NOT exempt a PRICE-ONLY override, which genuinely falls back to the extraction", async () => {
    // `updateEstimatePricingRecommendationReviewState` sets `overrideUnitPrice` and `overrideNotes`
    // without ever setting `overrideQuantity`, so this is the ordinary override, not an edge one. Such a
    // row must be judged on the extraction, because that is exactly what promotion falls back to.
    const priceOnlyLive = await seedCandidate({
      key: "price-only-live",
      extractionQuantity: "700",
      selectedSourceType: "override",
      overrideQuantity: null,
    });
    const priceOnlyDead = await seedCandidate({
      key: "price-only-dead",
      extractionQuantity: null,
      selectedSourceType: "override",
      overrideQuantity: null,
    });

    expect(await gatedIds()).toEqual([priceOnlyLive.recommendationId]);
    expect(await gatedIds()).not.toContain(priceOnlyDead.recommendationId);
  });

  it("requires a MANUAL row to carry its own usable quantity, rather than exempting it wholesale", async () => {
    // THE EXEMPTION'S JUSTIFICATION WAS FALSE AS WRITTEN. "A manual recommendation promotes its own
    // manualQuantity" is true only when it HAS one: `manual_quantity` is nullable, `manual-row-service`
    // writes null straight through on a cleared PATCH, and it writes the same null into
    // `recommended_quantity` — so `source_type = 'manual'` on its own admitted a row with no quantity
    // anywhere. Nonpositive is worse still: an override quantity of 0 was refused while a MANUAL 0 was
    // waved through, and 0 promotes AS ITSELF onto a client-facing line.
    //
    // The anchor extraction is deliberately unpriceable on every row here, because that is the real
    // shape: a manual row's extraction match is an active-artifact anchor, not a quantity source.
    const usable = await seedCandidate({
      key: "manual-10",
      extractionQuantity: null,
      recommendedQuantity: "10",
      sourceType: "manual",
      selectedSourceType: "manual",
      manualQuantity: "10",
      manualUnitPrice: "250.00",
    });
    const clearedManual = await seedCandidate({
      key: "manual-cleared",
      extractionQuantity: null,
      recommendedQuantity: null,
      sourceType: "manual",
      selectedSourceType: "manual",
      manualQuantity: null,
      manualUnitPrice: "250.00",
    });
    const zeroManual = await seedCandidate({
      key: "manual-0",
      extractionQuantity: null,
      recommendedQuantity: "0",
      sourceType: "manual",
      selectedSourceType: "manual",
      manualQuantity: "0",
      manualUnitPrice: "250.00",
    });
    const negativeManual = await seedCandidate({
      key: "manual--5",
      extractionQuantity: null,
      recommendedQuantity: "-5",
      sourceType: "manual",
      selectedSourceType: "manual",
      manualQuantity: "-5",
      manualUnitPrice: "250.00",
    });

    expect(await gatedIds()).toEqual([usable.recommendationId]);
    for (const refused of [clearedManual, zeroManual, negativeManual]) {
      expect(await gatedIds()).not.toContain(refused.recommendationId);
    }
  });

  it("still admits a manual row whose OVERRIDE carries the quantity", async () => {
    // The alternatives are an OR, so tightening the manual branch must not strand a manual row that
    // legitimately promotes an override quantity instead of its own.
    const overriddenManual = await seedCandidate({
      key: "manual-overridden",
      extractionQuantity: null,
      recommendedQuantity: null,
      sourceType: "manual",
      selectedSourceType: "override",
      manualQuantity: null,
      overrideQuantity: "12",
      manualUnitPrice: "250.00",
    });

    expect(await gatedIds()).toEqual([overriddenManual.recommendationId]);
  });

  it("is scoped to the run and to reviewed rows, gate or no gate", async () => {
    const approved = await seedCandidate({ key: "approved", extractionQuantity: "700" });
    const overridden = await seedCandidate({
      key: "overridden",
      extractionQuantity: "700",
      status: "overridden",
    });
    const pending = await seedCandidate({
      key: "pending",
      extractionQuantity: "700",
      status: "pending",
    });
    const rejected = await seedCandidate({
      key: "rejected",
      extractionQuantity: "700",
      status: "rejected",
    });
    const otherRun = await seedCandidate({
      key: "other-run",
      extractionQuantity: "700",
      runId: OTHER_RUN,
    });

    expect(await gatedIds()).toEqual(
      [approved.recommendationId, overridden.recommendationId].sort()
    );
    for (const excluded of [pending, rejected, otherRun]) {
      expect(await gatedIds()).not.toContain(excluded.recommendationId);
    }
  });

  it("omits the gate entirely when it is NOT requested, so duplicate derivation sees every row", async () => {
    // Applying the gate to the wide read is a CORRECTNESS bug rather than a scoping one: a filtered-out
    // duplicate makes its valid sibling look UNIQUE, so the sibling promotes even when the filtered row
    // already holds a promoted line item. Asserted by RUNNING the ungated read and finding the
    // unpriceable rows in its result — the old suite asserted the ABSENCE of the string "NaN", which
    // says nothing about which rows come back.
    const healthy = await seedCandidate({ key: "healthy", extractionQuantity: "700" });
    const cleared = await seedCandidate({ key: "cleared", extractionQuantity: null });
    const notANumber = await seedCandidate({ key: "nan", extractionQuantity: "NaN" });

    const rows = await loadApprovedRecommendationsForRun(tenantDb, DEAL, RUN);

    expect(rows.map((row) => row.recommendationId).sort()).toEqual(
      [healthy.recommendationId, cleared.recommendationId, notANumber.recommendationId].sort()
    );
  });

  it("locks only when asked, and only the rows the caller is about to write", async () => {
    // `FOR UPDATE` on the wide read held every qualifying recommendation, match and extraction for the
    // length of section and line-item creation, so two people promoting DISJOINT rows serialised.
    // Executed rather than asserted about: the locked read must still return the same row.
    const healthy = await seedCandidate({ key: "healthy", extractionQuantity: "700" });

    const locked = await loadApprovedRecommendationsForRun(
      tenantDb,
      DEAL,
      RUN,
      [healthy.recommendationId],
      { lock: true, requirePriceableQuantity: true }
    );

    expect(locked.map((row) => row.recommendationId)).toEqual([healthy.recommendationId]);
  });
});

describe("promoting into an estimate never invents a quantity", () => {
  /** The quantities that actually reached `estimate_line_items`, which is the client-facing artifact. */
  async function promotedLineQuantities(recommendationIds: string[]) {
    const result = await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: DEAL,
      generationRunId: RUN,
      approvedRecommendationIds: recommendationIds,
    });
    const { rows } = (await pg.query(
      "SELECT description, quantity::text AS quantity, total_price::text AS total FROM estimate_line_items ORDER BY description"
    )) as { rows: Array<{ description: string; quantity: string; total: string }> };

    return { result, lines: rows };
  }

  it("refuses a manual row with no quantity of its own instead of pricing it as ONE UNIT", async () => {
    // `resolvePromotionLineValues` fell back to `"1"` for exactly this row, and `createLineItem` has the
    // same `?? "1"` behind it — two fabrication sites on one path. A manual line at 10 x $250 that is
    // PATCHed to a blank quantity keeps its unit price, and one unit of anything has a price.
    const cleared = await seedCandidate({
      key: "manual-cleared",
      extractionQuantity: null,
      recommendedQuantity: null,
      sourceType: "manual",
      selectedSourceType: "manual",
      manualQuantity: null,
      manualUnitPrice: "250.00",
    });

    const { result, lines } = await promotedLineQuantities([cleared.recommendationId]);

    expect(lines).toHaveLength(0);
    expect(result.promotedRecommendationIds).toEqual([]);
    expect(result.rowErrors.map((error) => error.recommendationId)).toEqual([
      cleared.recommendationId,
    ]);
  });

  it("refuses a manual quantity of ZERO or a negative rather than promoting it as itself", async () => {
    // Not the same failure as the null: 0 and -5 are truthy STRINGS, so the completeness check upstream
    // passes them and they reach the estimate AS THEMSELVES — a $0 line, or a negative one, on a quote
    // somebody signs. An override quantity of 0 was already refused; this is the same rule applied to
    // the manual column it was missing from.
    const zero = await seedCandidate({
      key: "manual-0",
      extractionQuantity: null,
      recommendedQuantity: "0",
      sourceType: "manual",
      selectedSourceType: "manual",
      manualQuantity: "0",
      manualUnitPrice: "250.00",
    });
    const negative = await seedCandidate({
      key: "manual--5",
      extractionQuantity: null,
      recommendedQuantity: "-5",
      sourceType: "manual",
      selectedSourceType: "manual",
      manualQuantity: "-5",
      manualUnitPrice: "250.00",
    });

    const { result, lines } = await promotedLineQuantities([
      zero.recommendationId,
      negative.recommendationId,
    ]);

    expect(lines).toHaveLength(0);
    expect(result.promotedRecommendationIds).toEqual([]);
    expect(result.rowErrors.map((error) => error.recommendationId).sort()).toEqual(
      [zero.recommendationId, negative.recommendationId].sort()
    );
  });

  it("promotes a complete manual row with the number the estimator actually typed", async () => {
    // The control. Without it the two refusals above are equally satisfied by "manual rows never
    // promote", which would be a far worse bug than the one being fixed.
    const usable = await seedCandidate({
      key: "manual-10",
      extractionQuantity: null,
      recommendedQuantity: "10",
      sourceType: "manual",
      selectedSourceType: "manual",
      manualQuantity: "10",
      manualUnitPrice: "250.00",
    });

    const { result, lines } = await promotedLineQuantities([usable.recommendationId]);

    expect(result.promotedRecommendationIds).toEqual([usable.recommendationId]);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].quantity)).toBe(10);
    expect(Number(lines[0].total)).toBe(2500);
  });

  it("refuses a row the GATE admitted on one column and promotion would price from the other", async () => {
    // THE GAP BETWEEN THE TWO COALESCE ORDERS, which is why the guard at the point of use is not
    // redundant with the gate. The gate coalesces `manual_quantity` then `recommended_quantity`;
    // `resolvePromotionLineValues` reverses that order on the catalog-option branch. A row whose two
    // columns disagree therefore passes the gate on the healthy one and prices from the broken one —
    // and this is a real shape, not a contrived one: the two columns are written together today, but
    // nothing in the schema makes them agree, and a line item is where the disagreement is charged.
    //
    // Reachable, so the guard is genuinely exercised rather than being an unreachable comment: remove
    // it and a -$1,250.00 line appears.
    const divergent = await seedCandidate({
      key: "manual-divergent",
      extractionQuantity: null,
      recommendedQuantity: "-5",
      sourceType: "manual",
      selectedSourceType: "catalog_option",
      manualQuantity: "10",
      manualUnitPrice: "250.00",
    });

    // The gate DOES admit it — stated explicitly, or the test below would be satisfied by the gate
    // refusing the row and the guard never running.
    expect(await gatedIds()).toContain(divergent.recommendationId);

    const { result, lines } = await promotedLineQuantities([divergent.recommendationId]);

    expect(lines).toHaveLength(0);
    expect(result.promotedRecommendationIds).toEqual([]);
    expect(result.rowErrors).toEqual([
      expect.objectContaining({
        recommendationId: divergent.recommendationId,
        code: "unpriceable_quantity",
      }),
    ]);
  });

  it("promotes an extracted row at the extraction's own number", async () => {
    const healthy = await seedCandidate({ key: "healthy", extractionQuantity: "700" });

    const { result, lines } = await promotedLineQuantities([healthy.recommendationId]);

    expect(result.promotedRecommendationIds).toEqual([healthy.recommendationId]);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].quantity)).toBe(700);
  });

  it("refuses an extracted row whose quantity was cleared, with no line written", async () => {
    const cleared = await seedCandidate({ key: "cleared", extractionQuantity: null });

    const { result, lines } = await promotedLineQuantities([cleared.recommendationId]);

    expect(lines).toHaveLength(0);
    expect(result.promotedRecommendationIds).toEqual([]);
    expect(result.rowErrors[0]).toMatchObject({
      recommendationId: cleared.recommendationId,
      code: "recommendation_unavailable",
    });
  });
});

// Kept out of the describes above: this is the sabotage detector for the whole file, and it belongs
// with neither the gate nor the promote path.
describe("the seeded fixtures are the shapes the gate is meant to judge", () => {
  it("stores NaN as a real numeric NaN, which is what makes the NaN case meaningful", async () => {
    await seedCandidate({ key: "nan", extractionQuantity: "NaN" });

    const { rows } = (await pg.query(
      `SELECT (quantity = 'NaN'::numeric) AS is_nan, (quantity > 0) AS is_positive
         FROM estimate_extractions WHERE raw_label = 'nan'`
    )) as { rows: Array<{ is_nan: boolean; is_positive: boolean }> };

    expect(rows[0].is_nan).toBe(true);
    // The trap, demonstrated rather than asserted in prose: NaN sorts ABOVE every finite value, so a
    // positive test alone would have admitted it.
    expect(rows[0].is_positive).toBe(true);
  });
});
