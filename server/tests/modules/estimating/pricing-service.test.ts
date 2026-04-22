import { describe, expect, it } from "vitest";
import {
  applyMarketRateAdjustment,
  buildPricingRecommendation,
  buildPricingRecommendationRationale,
  isInferredRecommendationRowEligible,
  isConfirmedMeasurementCandidateForPricing,
  resolvePricingScopeFromExtraction,
} from "../../../src/modules/estimating/pricing-service.js";

function makeMarketAdjustment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    market: {
      id: (overrides.marketId ?? "market-1") as string,
      name: "Texas Market",
      slug: "tx",
      type: "state",
      stateCode: "TX",
      regionId: null,
      isActive: true,
      createdAt: new Date("2026-04-21T00:00:00Z"),
      updatedAt: new Date("2026-04-21T00:00:00Z"),
    },
    resolutionLevel: (overrides.resolutionLevel ?? "state") as any,
    resolutionSource: {
      type: (overrides.resolutionSourceType ?? "state") as any,
      key: (overrides.resolutionSourceKey ?? "TX") as string,
      marketId: (overrides.marketId ?? "market-1") as string,
    },
    baselinePrice: (overrides.baselinePrice ?? 118.34) as number,
    selectedRule: null,
    componentAdjustments: [
      {
        component: "labor",
        weight: 0.5,
        baselineAmount: 59.17,
        adjustmentPercent: 10,
        adjustmentAmount: 5.92,
        adjustedAmount: 65.09,
      },
      {
        component: "material",
        weight: 0.3,
        baselineAmount: 35.5,
        adjustmentPercent: -20,
        adjustmentAmount: -7.1,
        adjustedAmount: 28.4,
      },
      {
        component: "equipment",
        weight: 0.2,
        baselineAmount: 23.67,
        adjustmentPercent: 0,
        adjustmentAmount: 0,
        adjustedAmount: 23.67,
      },
    ],
    adjustedPrice: (overrides.adjustedPrice ?? 117.16) as number,
    rationale: {
      resolvedMarket: {
        id: (overrides.marketId ?? "market-1") as string,
        name: "Texas Market",
        slug: "tx",
        type: "state",
        stateCode: "TX",
        regionId: null,
        isActive: true,
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      resolutionLevel: (overrides.resolutionLevel ?? "state") as any,
      resolutionSource: {
        type: (overrides.resolutionSourceType ?? "state") as any,
        key: (overrides.resolutionSourceKey ?? "TX") as string,
        marketId: (overrides.marketId ?? "market-1") as string,
      },
      baselinePrice: (overrides.baselinePrice ?? 118.34) as number,
      selectedRuleId: (overrides.selectedRuleId ?? "rule-1") as string | null,
      componentAdjustments: [
        {
          component: "labor",
          weight: 0.5,
          baselineAmount: 59.17,
          adjustmentPercent: 10,
          adjustmentAmount: 5.92,
          adjustedAmount: 65.09,
        },
        {
          component: "material",
          weight: 0.3,
          baselineAmount: 35.5,
          adjustmentPercent: -20,
          adjustmentAmount: -7.1,
          adjustedAmount: 28.4,
        },
        {
          component: "equipment",
          weight: 0.2,
          baselineAmount: 23.67,
          adjustmentPercent: 0,
          adjustmentAmount: 0,
          adjustedAmount: 23.67,
        },
      ],
    },
  } as any;
}

describe("buildPricingRecommendation", () => {
  it("preserves the baseline before market-rate adjustment is applied", () => {
    const baseline = buildPricingRecommendation({
      quantity: 3,
      catalogBaselinePrice: 100,
      historicalPrices: [110, 115, 120],
      vendorQuotePrice: 130,
      awardedOutcomeAdjustmentPercent: -2,
      internalAdjustmentPercent: 5,
      regionId: "dfw",
      projectTypeId: "roofing",
    });

    expect(baseline.priceBasis).toBe("catalog_baseline_with_adjustments");
    expect(baseline.recommendedUnitPrice).toBeCloseTo(118.34, 2);
    expect(baseline.recommendedTotalPrice).toBeCloseTo(baseline.recommendedUnitPrice * baseline.quantity, 1);
    expect(baseline.comparableHistoricalPrices).toEqual([110, 115, 120]);
    expect(baseline.marketAdjustmentPercent).toBe(0);
    expect(baseline.assumptions.catalogBaselineUsed).toBe(true);
    expect(baseline.confidence).toBeGreaterThan(0);
  });

  it("applies market-rate component adjustments to the baseline recommendation", () => {
    const baseline = buildPricingRecommendation({
      quantity: 3,
      catalogBaselinePrice: 100,
      historicalPrices: [110, 115, 120],
      vendorQuotePrice: 130,
      awardedOutcomeAdjustmentPercent: -2,
      internalAdjustmentPercent: 5,
      regionId: "dfw",
      projectTypeId: "roofing",
    });

    const adjusted = applyMarketRateAdjustment({
      recommendation: baseline,
      marketRateAdjustment: makeMarketAdjustment(),
    });

    expect(adjusted.recommendedUnitPrice).not.toBeCloseTo(baseline.recommendedUnitPrice, 2);
    expect(adjusted.recommendedTotalPrice).toBeCloseTo(adjusted.recommendedUnitPrice * adjusted.quantity, 2);
    expect(adjusted.marketRateContext.resolutionLevel).toBe("state");
    expect(adjusted.marketRateRationale.componentAdjustments).toHaveLength(3);
  });

  it("resolves normalized pricing scope from extraction metadata before falling back to division or general", () => {
    expect(
      resolvePricingScopeFromExtraction({
        divisionHint: "07",
        metadataJson: {
          pricingScopeType: "trade",
          pricingScopeKey: "roofing",
        },
      })
    ).toEqual({
      pricingScopeType: "trade",
      pricingScopeKey: "roofing",
    });

    expect(
      resolvePricingScopeFromExtraction({
        divisionHint: "07",
        metadataJson: {
          scopeType: "division",
          scopeKey: "05",
        },
      })
    ).toEqual({
      pricingScopeType: "division",
      pricingScopeKey: "05",
    });

    expect(
      resolvePricingScopeFromExtraction({
        metadataJson: {},
      })
    ).toEqual({
      pricingScopeType: "general",
      pricingScopeKey: "default",
    });
  });

  it("still produces an adjusted recommendation when market resolution falls back", () => {
    const baseline = buildPricingRecommendation({
      quantity: 1,
      catalogBaselinePrice: 80,
      historicalPrices: [],
      vendorQuotePrice: null,
      awardedOutcomeAdjustmentPercent: 0,
      internalAdjustmentPercent: 0,
      regionId: null,
      projectTypeId: null,
    });

    const adjusted = applyMarketRateAdjustment({
      recommendation: baseline,
      marketRateAdjustment: makeMarketAdjustment({
        resolutionLevel: "global_default",
        resolutionSourceType: "global",
        resolutionSourceKey: "default",
        marketId: "market-default",
        adjustedPrice: 92.5,
      }),
    });

    expect(adjusted.marketRateContext.resolutionLevel).toBe("global_default");
    expect(adjusted.recommendedTotalPrice).toBeCloseTo(92.5, 2);
    expect(adjusted.recommendedUnitPrice).toBeCloseTo(92.5, 2);
  });

  it("keeps unit and total prices internally consistent for non-even quantities", () => {
    const baseline = buildPricingRecommendation({
      quantity: 3,
      catalogBaselinePrice: 100,
      historicalPrices: [110, 115, 120],
      vendorQuotePrice: 130,
      awardedOutcomeAdjustmentPercent: -2,
      internalAdjustmentPercent: 5,
      regionId: "dfw",
      projectTypeId: "roofing",
    });

    const adjusted = applyMarketRateAdjustment({
      recommendation: baseline,
      marketRateAdjustment: makeMarketAdjustment({ adjustedPrice: 117.16 }),
    });

    expect(adjusted.quantity).toBe(3);
    expect(adjusted.recommendedUnitPrice).toBeCloseTo(39.05, 2);
    expect(adjusted.recommendedTotalPrice).toBeCloseTo(117.15, 2);
    expect(adjusted.recommendedUnitPrice * adjusted.quantity).toBeCloseTo(adjusted.recommendedTotalPrice, 2);
  });

  it("guards zero or negative quantities in market-adjusted recommendations", () => {
    const zeroQuantityBaseline = buildPricingRecommendation({
      quantity: 0,
      catalogBaselinePrice: 80,
      historicalPrices: [],
      vendorQuotePrice: null,
      awardedOutcomeAdjustmentPercent: 0,
      internalAdjustmentPercent: 0,
      regionId: null,
      projectTypeId: null,
    });
    const negativeQuantityBaseline = {
      ...zeroQuantityBaseline,
      quantity: -2,
    };

    const zeroAdjusted = applyMarketRateAdjustment({
      recommendation: zeroQuantityBaseline,
      marketRateAdjustment: makeMarketAdjustment({ adjustedPrice: 42.25 }),
    });
    const negativeAdjusted = applyMarketRateAdjustment({
      recommendation: negativeQuantityBaseline,
      marketRateAdjustment: makeMarketAdjustment({ adjustedPrice: 42.25 }),
    });

    for (const adjusted of [zeroAdjusted, negativeAdjusted]) {
      expect(Number.isFinite(adjusted.recommendedUnitPrice)).toBe(true);
      expect(Number.isFinite(adjusted.recommendedTotalPrice)).toBe(true);
      expect(adjusted.recommendedUnitPrice).toBeCloseTo(42.25, 2);
      expect(adjusted.recommendedTotalPrice).toBeCloseTo(42.25, 2);
    }
  });

  it("does not reintroduce a hardcoded regional adjustment path", () => {
    const baseA = buildPricingRecommendation({
      quantity: 2,
      catalogBaselinePrice: 100,
      historicalPrices: [110, 115],
      vendorQuotePrice: 120,
      awardedOutcomeAdjustmentPercent: 0,
      internalAdjustmentPercent: 0,
      regionId: "dfw",
      projectTypeId: "roofing",
    });
    const baseB = buildPricingRecommendation({
      quantity: 2,
      catalogBaselinePrice: 100,
      historicalPrices: [110, 115],
      vendorQuotePrice: 120,
      awardedOutcomeAdjustmentPercent: 0,
      internalAdjustmentPercent: 0,
      regionId: "austin",
      projectTypeId: "waterproofing",
    });

    expect(baseA.recommendedUnitPrice).toBe(baseB.recommendedUnitPrice);

    const adjustedA = applyMarketRateAdjustment({
      recommendation: baseA,
      marketRateAdjustment: makeMarketAdjustment({ adjustedPrice: 150 }),
    });
    const adjustedB = applyMarketRateAdjustment({
      recommendation: baseB,
      marketRateAdjustment: makeMarketAdjustment({ adjustedPrice: 150 }),
    });

    expect(adjustedA.recommendedUnitPrice).toBe(adjustedB.recommendedUnitPrice);
  });

  it("excludes unconfirmed measurement candidates from pricing eligibility", () => {
    expect(
      isConfirmedMeasurementCandidateForPricing({
        extractionType: "measurement_candidate",
        metadataJson: {
          measurementConfirmationState: "pending",
        },
      })
    ).toBe(false);
  });

  it("allows confirmed measurement candidates into pricing eligibility", () => {
    expect(
      isConfirmedMeasurementCandidateForPricing({
        extractionType: "measurement_candidate",
        metadataJson: {
          measurementConfirmationState: "approved",
        },
      })
    ).toBe(true);
  });

  it("allows non-measurement rows into pricing eligibility", () => {
    expect(
      isConfirmedMeasurementCandidateForPricing({
        extractionType: "scope_line",
        metadataJson: {
          measurementConfirmationState: "pending",
        },
      })
    ).toBe(true);
  });

  it("requires document-backed evidence plus historical or dependency support before pricing an inferred row", () => {
    expect(
      isInferredRecommendationRowEligible({
        sourceType: "inferred",
        documentEvidence: null,
        historicalSupportCount: 0,
        dependencySupportCount: 0,
      })
    ).toBe(false);

    expect(
      isInferredRecommendationRowEligible({
        sourceType: "inferred",
        documentEvidence: {
          documentId: "doc-1",
          sourceText: "Companion work implied by spec",
        },
        historicalSupportCount: 0,
        dependencySupportCount: 2,
      })
    ).toBe(true);

    expect(
      isInferredRecommendationRowEligible({
        sourceType: "inferred",
        documentEvidence: {
          sourceExtractionId: "extraction-1",
        },
        historicalSupportCount: 1,
        dependencySupportCount: 0,
      })
    ).toBe(false);
  });

  it("builds rationale payloads that carry duplicate-group metadata for persistence", () => {
    const result = buildPricingRecommendationRationale({
      normalizedIntent: "roofing:tearoff",
      sectionName: "Roofing",
      sourceRowIdentity: "row-1",
      optionRows: [
        {
          rank: 1,
          optionLabel: "Tearoff base",
          optionKind: "recommended",
        },
        {
          rank: 2,
          optionLabel: "Tearoff alternate",
          optionKind: "alternate",
        },
      ],
      duplicateGroupMetadata: {
        duplicateKeys: ["catalog:cat-a"],
        suppressedCount: 1,
      },
      evidenceJson: {
        documentEvidence: ["sheet 2"],
        historicalSupport: ["job-7"],
      },
    });

    expect(result.duplicateGroupMetadata.duplicateKeys).toEqual(["catalog:cat-a"]);
    expect(result.optionRows.map((option: any) => option.rank)).toEqual([1, 2]);
    expect(result.evidenceJson.documentEvidence).toEqual(["sheet 2"]);
  });
});
