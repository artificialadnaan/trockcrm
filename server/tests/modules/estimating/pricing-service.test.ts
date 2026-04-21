import { describe, expect, it } from "vitest";
import {
  buildPricingRecommendation,
  buildPricingRecommendationRationale,
  isInferredRecommendationRowEligible,
  isConfirmedMeasurementCandidateForPricing,
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
