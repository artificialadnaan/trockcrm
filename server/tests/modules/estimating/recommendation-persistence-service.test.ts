import { describe, expect, it, vi } from "vitest";
import { buildRecommendationOptionSet } from "../../../src/modules/estimating/recommendation-option-service.js";
import {
  applyMarketRateAdjustment,
  buildPricingRecommendation,
} from "../../../src/modules/estimating/pricing-service.js";
import { persistPricingRecommendationBundle } from "../../../src/modules/estimating/recommendation-persistence-service.js";

function makeMarketAdjustment() {
  return {
    market: {
      id: "market-dfw",
      name: "Dallas Market",
      slug: "dfw",
      type: "state",
      stateCode: "TX",
      regionId: null,
      isActive: true,
      createdAt: new Date("2026-04-21T00:00:00Z"),
      updatedAt: new Date("2026-04-21T00:00:00Z"),
    },
    resolutionLevel: "state" as const,
    resolutionSource: {
      type: "state" as const,
      key: "TX",
      marketId: "market-dfw",
    },
    baselinePrice: 200,
    selectedRule: {
      id: "rule-1",
    },
    componentAdjustments: [
      {
        component: "labor",
        weight: 0.5,
        baselineAmount: 100,
        adjustmentPercent: 10,
        adjustmentAmount: 10,
        adjustedAmount: 110,
      },
      {
        component: "material",
        weight: 0.3,
        baselineAmount: 60,
        adjustmentPercent: -10,
        adjustmentAmount: -6,
        adjustedAmount: 54,
      },
      {
        component: "equipment",
        weight: 0.2,
        baselineAmount: 40,
        adjustmentPercent: 0,
        adjustmentAmount: 0,
        adjustedAmount: 40,
      },
    ],
    adjustedPrice: 204,
    rationale: {
      resolvedMarket: {
        id: "market-dfw",
        name: "Dallas Market",
        slug: "dfw",
        type: "state",
        stateCode: "TX",
        regionId: null,
        isActive: true,
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      resolutionLevel: "state" as const,
      resolutionSource: {
        type: "state" as const,
        key: "TX",
        marketId: "market-dfw",
      },
      baselinePrice: 200,
      selectedRuleId: "rule-1",
      componentAdjustments: [
        {
          component: "labor",
          weight: 0.5,
          baselineAmount: 100,
          adjustmentPercent: 10,
          adjustmentAmount: 10,
          adjustedAmount: 110,
        },
        {
          component: "material",
          weight: 0.3,
          baselineAmount: 60,
          adjustmentPercent: -10,
          adjustmentAmount: -6,
          adjustedAmount: 54,
        },
        {
          component: "equipment",
          weight: 0.2,
          baselineAmount: 40,
          adjustmentPercent: 0,
          adjustmentAmount: 0,
          adjustedAmount: 40,
        },
      ],
    },
  } as any;
}

describe("persistPricingRecommendationBundle", () => {
  it("persists adjusted recommendation values and market-rate evidence", async () => {
    const baseline = buildPricingRecommendation({
      quantity: 2,
      catalogBaselinePrice: 100,
      historicalPrices: [90, 95, 105],
      vendorQuotePrice: 110,
      awardedOutcomeAdjustmentPercent: 0,
      internalAdjustmentPercent: 0,
      regionId: "dfw",
      projectTypeId: "roofing",
    });
    const recommendation = applyMarketRateAdjustment({
      recommendation: baseline,
      marketRateAdjustment: makeMarketAdjustment(),
    });
    const recommendationSet = buildRecommendationOptionSet({
      sectionName: "Roofing",
      normalizedIntent: "roofing:tearoff",
      sourceRowIdentity: "row-1",
      candidates: [
        {
          optionLabel: "Catalog item",
          catalogItemId: "catalog-1",
          score: 10,
          historicalSelectionCount: 2,
          unitCompatibilityScore: 5,
          absolutePriceDeviation: 3,
          stableId: "catalog-1",
          evidenceJson: { source: "history" },
        },
      ],
    });

    const insertPayloads: any[] = [];
    const updatePayloads: any[] = [];
    const tenantDb = {
      insert: vi.fn((table: any) => ({
        values: vi.fn((payload: any) => {
          insertPayloads.push({ table, payload });
          const id = payload.matchType ? "match-1" : payload.dealId ? "recommendation-1" : "option-1";
          return {
            returning: vi.fn().mockResolvedValue([{ id }]),
          };
        }),
      })),
      update: vi.fn((table: any) => ({
        set: vi.fn((payload: any) => ({
          where: vi.fn(async () => {
            updatePayloads.push({ table, payload });
          }),
        })),
      })),
    } as any;

    await persistPricingRecommendationBundle({
      tenantDb,
      generationRunId: "run-1",
      extraction: {
        id: "ext-1",
        dealId: "deal-1",
        projectId: "project-1",
        documentId: "doc-1",
        quantity: 2,
        unit: "ea",
        sourceType: "extracted",
        normalizedIntent: "roofing:tearoff",
        sourceRowIdentity: "row-1",
      },
      topMatch: {
        catalogItemId: "catalog-1",
        matchScore: 99,
        reasons: { exactNameMatch: true },
        historicalLineItemIds: ["hist-1"],
        catalogBaselinePrice: 100,
      },
      recommendation,
      recommendationSet,
      rationaleJson: recommendationSet.rationaleJson,
    });

    const recommendationInsert = insertPayloads.find(
      ({ payload }) => payload && typeof payload === "object" && "recommendedUnitPrice" in payload
    )?.payload;

    expect(recommendationInsert.recommendedUnitPrice).toBe("102.00");
    expect(recommendationInsert.recommendedTotalPrice).toBe("204.00");
    expect(recommendationInsert.assumptionsJson.marketRate.resolvedMarket.id).toBe("market-dfw");
    expect(recommendationInsert.assumptionsJson.marketRate.componentAdjustments).toHaveLength(3);
    expect(recommendationInsert.evidenceJson.marketRate.resolvedMarket.slug).toBe("dfw");
    expect(recommendationInsert.evidenceJson.marketRate.componentAdjustments[0].component).toBe("labor");
    expect(updatePayloads).toHaveLength(1);
  });
});
