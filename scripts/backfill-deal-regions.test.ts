import { describe, expect, it } from "vitest";
import {
  buildDealRegionBackfillPlan,
  type DealRegionBackfillDeal,
  type DealRegionRow,
} from "./backfill-deal-regions.js";

const regions: DealRegionRow[] = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "west_coast",
    name: "West Coast",
    isActive: true,
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "central",
    name: "Central",
    isActive: true,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "east_coast",
    name: "East Coast",
    isActive: true,
  },
  {
    id: "region-texas-old",
    slug: "texas",
    name: "Texas",
    isActive: false,
  },
  {
    id: "region-southeast-old",
    slug: "southeast",
    name: "Southeast",
    isActive: false,
  },
];

function deal(input: Partial<DealRegionBackfillDeal>): DealRegionBackfillDeal {
  return {
    schemaName: "office_dallas",
    dealId: input.dealId ?? "deal-1",
    dealNumber: input.dealNumber ?? "DFW-1",
    dealName: input.dealName ?? "Deal",
    currentRegionId: input.currentRegionId ?? null,
    currentRegionSlug: input.currentRegionSlug ?? null,
    currentRegionName: input.currentRegionName ?? null,
    propertyState: input.propertyState ?? null,
    dealPropertyState: input.dealPropertyState ?? null,
  };
}

describe("deal region backfill planner", () => {
  it("derives a target region from structured state", () => {
    const plan = buildDealRegionBackfillPlan({
      regions,
      deals: [
        deal({ dealId: "deal-ca", propertyState: "CA" }),
        deal({ dealId: "deal-tx", propertyState: "TX" }),
        deal({ dealId: "deal-ga", propertyState: "GA" }),
      ],
    });

    expect(plan.counts.withUsableState).toBe(3);
    expect(plan.changes.map((change) => [change.dealId, change.targetRegionSlug])).toEqual([
      ["deal-ca", "west_coast"],
      ["deal-tx", "central"],
      ["deal-ga", "east_coast"],
    ]);
  });

  it("leaves no-state blank deals unchanged", () => {
    const plan = buildDealRegionBackfillPlan({
      regions,
      deals: [deal({ dealId: "deal-blank" })],
    });

    expect(plan.counts.leftBlankNoState).toBe(1);
    expect(plan.changes).toHaveLength(0);
  });

  it("falls back from old region values when no state exists", () => {
    const plan = buildDealRegionBackfillPlan({
      regions,
      deals: [
        deal({
          dealId: "deal-old-texas",
          currentRegionId: "region-texas-old",
          currentRegionSlug: "texas",
          currentRegionName: "Texas",
        }),
        deal({
          dealId: "deal-old-southeast",
          currentRegionId: "region-southeast-old",
          currentRegionSlug: "southeast",
          currentRegionName: "Southeast",
        }),
        deal({
          dealId: "deal-old-east",
          currentRegionId: "33333333-3333-4333-8333-333333333333",
          currentRegionSlug: "east_coast",
          currentRegionName: "East Coast",
        }),
      ],
    });

    expect(plan.changes.map((change) => [change.dealId, change.source, change.targetRegionSlug])).toEqual([
      ["deal-old-texas", "legacy_fallback", "central"],
      ["deal-old-southeast", "legacy_fallback", "east_coast"],
    ]);
    expect(plan.counts.unchanged).toBe(1);
  });

  it("is idempotent after applying planned changes", () => {
    const firstPlan = buildDealRegionBackfillPlan({
      regions,
      deals: [
        deal({ dealId: "deal-ca", propertyState: "CA" }),
        deal({
          dealId: "deal-old-texas",
          currentRegionId: "region-texas-old",
          currentRegionSlug: "texas",
        }),
      ],
    });

    const updatedDeals = firstPlan.changes.map((change) =>
      deal({
        dealId: change.dealId,
        currentRegionId: change.targetRegionId,
        currentRegionSlug: change.targetRegionSlug,
        currentRegionName: change.targetRegionName,
        propertyState: change.propertyState,
        dealPropertyState: change.dealPropertyState,
      })
    );
    const secondPlan = buildDealRegionBackfillPlan({ regions, deals: updatedDeals });

    expect(firstPlan.counts.willUpdate).toBe(2);
    expect(secondPlan.counts.willUpdate).toBe(0);
  });
});
