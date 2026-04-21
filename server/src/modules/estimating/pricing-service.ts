export interface BuildPricingRecommendationInput {
  quantity: number;
  catalogBaselinePrice: number | null;
  historicalPrices: number[];
  vendorQuotePrice: number | null;
  awardedOutcomeAdjustmentPercent?: number | null;
  internalAdjustmentPercent: number;
  regionId: string | null;
  projectTypeId: string | null;
}

export function getRegionalMarketAdjustmentPercent(input: {
  regionId: string | null;
  projectTypeId: string | null;
}) {
  const table = {
    "dfw:roofing": 10,
    "dfw:waterproofing": 8,
  } as const;

  return table[`${input.regionId ?? "unknown"}:${input.projectTypeId ?? "unknown"}` as keyof typeof table] ?? 0;
}

export function buildPricingRecommendation(input: BuildPricingRecommendationInput) {
  const historicalMedian =
    input.historicalPrices.length > 0
      ? [...input.historicalPrices].sort((a, b) => a - b)[Math.floor(input.historicalPrices.length / 2)]
      : null;

  const quoteAdjustedBase =
    input.vendorQuotePrice != null
      ? ((input.catalogBaselinePrice ?? input.vendorQuotePrice) * 0.5) + (input.vendorQuotePrice * 0.5)
      : input.catalogBaselinePrice ?? historicalMedian ?? 0;

  const awardedAdjustedBase =
    quoteAdjustedBase * (1 + (input.awardedOutcomeAdjustmentPercent ?? 0) / 100);

  const afterInternal = awardedAdjustedBase * (1 + input.internalAdjustmentPercent / 100);

  const regionalAdjustmentPercent = getRegionalMarketAdjustmentPercent({
    projectTypeId: input.projectTypeId,
    regionId: input.regionId,
  });

  const adjusted = Number((afterInternal * (1 + regionalAdjustmentPercent / 100)).toFixed(2));

  return {
    priceBasis: "catalog_baseline_with_adjustments",
    recommendedUnitPrice: adjusted,
    recommendedTotalPrice: Number((adjusted * input.quantity).toFixed(2)),
    comparableHistoricalPrices: input.historicalPrices,
    historicalMedianPrice: historicalMedian,
    catalogBaselinePrice: input.catalogBaselinePrice ?? null,
    marketAdjustmentPercent: regionalAdjustmentPercent,
    assumptions: {
      catalogBaselineUsed: input.catalogBaselinePrice != null,
      vendorQuotePrice: input.vendorQuotePrice ?? null,
      awardedOutcomeAdjustmentPercent: input.awardedOutcomeAdjustmentPercent ?? 0,
      internalAdjustmentPercent: input.internalAdjustmentPercent,
    },
    confidence: historicalMedian != null ? 0.84 : 0.58,
  };
}

export function isConfirmedMeasurementCandidateForPricing(input: {
  extractionType?: string | null;
  metadataJson?: Record<string, unknown> | null;
}) {
  if (input.extractionType !== "measurement_candidate") return true;

  return input.metadataJson?.measurementConfirmationState === "approved";
}
