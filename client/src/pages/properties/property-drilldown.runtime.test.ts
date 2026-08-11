// @vitest-environment node
//
// Reconciliation-by-construction for the Properties drillable summary cards. Properties is client-paginated
// (the hook fetches up to 250 and the page slices in-browser), so each card's number and the list it drills
// to derive from ONE in-memory array filtered by ONE predicate — they cannot diverge. The cards keep showing
// FULL-set aggregates (stable); clicking one narrows the list to that card's predicate. For the two SUM cards
// (Active opportunities, Linked pipeline) reconciliation is on the aggregate (sum over the drilled list ===
// the card); for the COUNT card (Untouched) it is the row count.
import { describe, expect, it } from "vitest";
import type { PropertySurface } from "@/hooks/use-properties";
import {
  PROPERTY_CARD_PREDICATES,
  hasActiveOpportunities,
  hasLinkedPipeline,
  isStaleProperty,
} from "./property-list-page";

const DAY = 24 * 60 * 60 * 1000;
const recent = new Date(Date.now() - 5 * DAY).toISOString();
const old = new Date(Date.now() - 60 * DAY).toISOString();

function prop(o: Partial<PropertySurface> & { id: string }): PropertySurface {
  return {
    leadCount: 0,
    dealCount: 0,
    activeDealsCount: 0,
    linkedValue: null,
    activePipelineValue: null,
    lastActivityAt: null,
    roofArea: null,
    ...o,
  } as unknown as PropertySurface;
}

// p1: opp+pipeline, fresh | p2: nothing, stale | p3: opp+pipeline, stale(null activity) | p4: opp+pipeline(activePipelineValue), fresh
const properties: PropertySurface[] = [
  prop({ id: "p1", leadCount: 2, activeDealsCount: 1, linkedValue: "100000", lastActivityAt: recent }),
  prop({ id: "p2", leadCount: 0, activeDealsCount: 0, linkedValue: "0", lastActivityAt: old }),
  prop({ id: "p3", leadCount: 0, activeDealsCount: 3, linkedValue: "50000", lastActivityAt: null }),
  prop({ id: "p4", leadCount: 1, activeDealsCount: 0, activePipelineValue: "25000", lastActivityAt: recent }),
];

// What the cards display — aggregates over the FULL set (mirrors the page's `totals` useMemo).
const cardOpportunities = properties.reduce((s, p) => s + p.leadCount + (p.activeDealsCount ?? p.dealCount), 0);
const cardPipeline = properties.reduce((s, p) => s + Number(p.linkedValue ?? p.activePipelineValue ?? 0), 0);
const cardStaleCount = properties.filter(isStaleProperty).length;

describe("property card predicates", () => {
  it("classify each property correctly", () => {
    expect(properties.filter(hasActiveOpportunities).map((p) => p.id)).toEqual(["p1", "p3", "p4"]);
    expect(properties.filter(hasLinkedPipeline).map((p) => p.id)).toEqual(["p1", "p3", "p4"]);
    expect(properties.filter(isStaleProperty).map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("PROPERTY_CARD_PREDICATES maps each card id to its predicate", () => {
    expect(PROPERTY_CARD_PREDICATES.opportunities).toBe(hasActiveOpportunities);
    expect(PROPERTY_CARD_PREDICATES.pipeline).toBe(hasLinkedPipeline);
    expect(PROPERTY_CARD_PREDICATES.stale).toBe(isStaleProperty);
  });
});

describe("reconciliation — card number === the list it drills to", () => {
  it("Untouched count === number of rows in the stale-drilled list", () => {
    const drilled = properties.filter(PROPERTY_CARD_PREDICATES.stale);
    expect(cardStaleCount).toBe(2);
    expect(drilled.length).toBe(cardStaleCount);
  });

  it("Active-opportunities sum === sum over the opportunities-drilled list", () => {
    const drilled = properties.filter(PROPERTY_CARD_PREDICATES.opportunities);
    const drilledSum = drilled.reduce((s, p) => s + p.leadCount + (p.activeDealsCount ?? p.dealCount), 0);
    expect(cardOpportunities).toBe(7);
    expect(drilledSum).toBe(cardOpportunities); // dropped rows contribute 0 to the sum
  });

  it("Linked-pipeline $ sum === sum over the pipeline-drilled list", () => {
    const drilled = properties.filter(PROPERTY_CARD_PREDICATES.pipeline);
    const drilledSum = drilled.reduce((s, p) => s + Number(p.linkedValue ?? p.activePipelineValue ?? 0), 0);
    expect(cardPipeline).toBe(175000);
    expect(drilledSum).toBe(cardPipeline);
  });
});

/**
 * A DEDUCTIVE change order makes a property's linked value NEGATIVE.
 *
 * A change order is a real child deal (0156) that inherits its parent's property_id, sits in Won, is
 * active and not on-hold — so it is inside the property linked-value SUM by construction. That SUM
 * (propertyLinkedDealValueSql -> aliasedDealBestEstimateWithForecastSql) is change-order-aware, so a
 * deductive CO enters it as a NEGATIVE number and a property can arrive here netting below zero: the
 * deductions on a project can outweigh whatever else the property still contributes (a parent that is
 * soft-deleted is excluded from the SUM entirely — the query filters is_active — and a parent held to $0
 * contributes nothing, while the child, which inherits neither flag, keeps its full negative value).
 *
 * The `> 0` gate made that property VANISH from the drilled list while its money stayed in the card's
 * number, which is the worse half of the failure: a wrong total is visible, a missing row is not — there
 * is no way to see which site the number came from once it has been filtered out from under it.
 */
describe("a net-negative property must not vanish from the pipeline drill", () => {
  // ONE array, as above: the card number and the drilled list both derive from it, so the reconciliation
  // below is the real invariant and not two hand-written numbers agreeing by luck.
  const withDeduction: PropertySurface[] = [
    prop({ id: "n1", leadCount: 0, activeDealsCount: 1, linkedValue: "100000", lastActivityAt: recent }),
    prop({ id: "n2", leadCount: 0, activeDealsCount: 1, linkedValue: "-30000", lastActivityAt: recent }),
    prop({ id: "n3", leadCount: 0, activeDealsCount: 0, linkedValue: "0", lastActivityAt: recent }),
  ];
  const cardWithDeduction = withDeduction.reduce(
    (s, p) => s + Number(p.linkedValue ?? p.activePipelineValue ?? 0),
    0
  );

  it("keeps the property whose linked pipeline nets negative", () => {
    expect(withDeduction.filter(hasLinkedPipeline).map((p) => p.id)).toEqual(["n1", "n2"]);
  });

  it("Linked-pipeline $ sum === sum over the drilled list even with a deduction in it", () => {
    const drilled = withDeduction.filter(PROPERTY_CARD_PREDICATES.pipeline);
    const drilledSum = drilled.reduce((s, p) => s + Number(p.linkedValue ?? p.activePipelineValue ?? 0), 0);
    expect(cardWithDeduction).toBe(70000);
    expect(drilledSum).toBe(cardWithDeduction);
  });

  it("still drops a property that contributes NOTHING to the number", () => {
    // The predicate is "contributes to the card", not "is positive". A $0 property moves the sum by
    // nothing, so dropping it narrows the list without breaking the reconciliation — a negative one
    // moves it by exactly its own value, so dropping that DOES break it.
    expect(withDeduction.filter(hasLinkedPipeline).map((p) => p.id)).not.toContain("n3");
  });

  it("reconciles for a property set that nets negative overall", () => {
    // Not merely "a negative row among positives": the whole card can read below zero, and the drill has
    // to be able to show every site that put it there.
    const allDeductive = [
      prop({ id: "d1", activeDealsCount: 1, linkedValue: "-30000", lastActivityAt: recent }),
      prop({ id: "d2", activeDealsCount: 1, linkedValue: "-12500", lastActivityAt: recent }),
    ];
    const card = allDeductive.reduce((s, p) => s + Number(p.linkedValue ?? p.activePipelineValue ?? 0), 0);
    const drilled = allDeductive.filter(PROPERTY_CARD_PREDICATES.pipeline);
    expect(card).toBe(-42500);
    expect(drilled.map((p) => p.id)).toEqual(["d1", "d2"]);
    expect(drilled.reduce((s, p) => s + Number(p.linkedValue ?? p.activePipelineValue ?? 0), 0)).toBe(card);
  });
});
