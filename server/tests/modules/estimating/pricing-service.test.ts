import { describe, expect, it } from "vitest";
import {
  buildPricingRecommendation,
  isConfirmedMeasurementDerivedExtraction,
} from "../../../src/modules/estimating/pricing-service.js";

describe("buildPricingRecommendation", () => {
  it("applies a geography and project-type market adjustment from the market-rate service", () => {
    const result = buildPricingRecommendation({
      quantity: 3,
      catalogBaselinePrice: 100,
      historicalPrices: [110, 115, 120],
      vendorQuotePrice: 130,
      awardedOutcomeAdjustmentPercent: -2,
      internalAdjustmentPercent: 5,
      regionId: "dfw",
      projectTypeId: "roofing",
    });

    expect(result.priceBasis).toBe("catalog_baseline_with_adjustments");
    expect(result.comparableHistoricalPrices).toEqual([110, 115, 120]);
    expect(result.marketAdjustmentPercent).toBe(10);
    expect(result.assumptions.catalogBaselineUsed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("excludes pending measurement-derived rows from pricing eligibility", () => {
    expect(
      isConfirmedMeasurementDerivedExtraction({
        metadataJson: {
          measurementDerived: true,
          measurementConfirmationState: "pending",
        },
      })
    ).toBe(false);
  });

  it("allows confirmed measurement-derived rows into pricing eligibility", () => {
    expect(
      isConfirmedMeasurementDerivedExtraction({
        metadataJson: {
          measurementDerived: true,
          measurementConfirmationState: "approved",
        },
      })
    ).toBe(true);
  });
});
