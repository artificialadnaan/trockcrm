import type {
  MarketRateAdjustmentResult,
} from "./market-rate-service.js";

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

export interface PricingRecommendation {
  quantity: number;
  priceBasis: string;
  recommendedUnitPrice: number;
  recommendedTotalPrice: number;
  comparableHistoricalPrices: number[];
  historicalMedianPrice: number | null;
  catalogBaselinePrice: number | null;
  marketAdjustmentPercent: number;
  assumptions: {
    catalogBaselineUsed: boolean;
    vendorQuotePrice: number | null;
    awardedOutcomeAdjustmentPercent: number;
    internalAdjustmentPercent: number;
  };
  confidence: number;
}

export interface MarketRateEnrichedPricingRecommendation extends PricingRecommendation {
  marketRateContext: {
    resolvedMarket: MarketRateAdjustmentResult["market"];
    resolutionLevel: MarketRateAdjustmentResult["resolutionLevel"];
    resolutionSource: MarketRateAdjustmentResult["resolutionSource"];
  };
  marketRateRationale: MarketRateAdjustmentResult["rationale"];
}

export interface BuildPricingRecommendationRationaleInput {
  normalizedIntent: string;
  sectionName: string | null;
  sourceRowIdentity: string;
  optionRows: Array<{
    rank: number;
    optionLabel: string;
    optionKind: "recommended" | "alternate";
    catalogItemId?: string | null;
    localCatalogItemId?: string | null;
    normalizedCustomItemKey?: string | null;
  }>;
  duplicateGroupMetadata: {
    sectionName?: string | null;
    normalizedIntent?: string;
    sourceRowIdentity?: string;
    duplicateKeys: string[];
    suppressedCount: number;
  };
  evidenceJson: Record<string, unknown>;
}

export function buildPricingRecommendation(input: BuildPricingRecommendationInput): PricingRecommendation {
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

  return {
    quantity: input.quantity,
    priceBasis: "catalog_baseline_with_adjustments",
    recommendedUnitPrice: Number(afterInternal.toFixed(2)),
    recommendedTotalPrice: Number((afterInternal * input.quantity).toFixed(2)),
    comparableHistoricalPrices: input.historicalPrices,
    historicalMedianPrice: historicalMedian,
    catalogBaselinePrice: input.catalogBaselinePrice ?? null,
    marketAdjustmentPercent: 0,
    assumptions: {
      catalogBaselineUsed: input.catalogBaselinePrice != null,
      vendorQuotePrice: input.vendorQuotePrice ?? null,
      awardedOutcomeAdjustmentPercent: input.awardedOutcomeAdjustmentPercent ?? 0,
      internalAdjustmentPercent: input.internalAdjustmentPercent,
    },
    confidence: historicalMedian != null ? 0.84 : 0.58,
  };
}

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

export function applyMarketRateAdjustment(input: {
  recommendation: PricingRecommendation;
  marketRateAdjustment: MarketRateAdjustmentResult;
}): MarketRateEnrichedPricingRecommendation {
  const adjustedTotal = roundCurrency(input.marketRateAdjustment.adjustedPrice);
  const adjustedUnit = roundCurrency(adjustedTotal / input.recommendation.quantity);
  const baselineTotal = input.recommendation.recommendedTotalPrice;
  const marketAdjustmentPercent =
    baselineTotal === 0
      ? 0
      : Number((((adjustedTotal - baselineTotal) / baselineTotal) * 100).toFixed(3));

  return {
    ...input.recommendation,
    recommendedUnitPrice: adjustedUnit,
    recommendedTotalPrice: adjustedTotal,
    marketAdjustmentPercent,
    assumptions: {
      ...input.recommendation.assumptions,
    },
    marketRateContext: {
      resolvedMarket: input.marketRateAdjustment.market,
      resolutionLevel: input.marketRateAdjustment.resolutionLevel,
      resolutionSource: input.marketRateAdjustment.resolutionSource,
    },
    marketRateRationale: input.marketRateAdjustment.rationale,
  };
}

export function isInferredRecommendationRowEligible(input: {
  sourceType?: string | null;
  documentEvidence: {
    documentId?: string | null;
    sourceText?: string | null;
    sourceExtractionId?: string | null;
  } | null;
  historicalSupportCount: number;
  dependencySupportCount: number;
}) {
  if (input.sourceType !== "inferred") return true;

  const hasDocumentEvidence =
    Boolean(input.documentEvidence?.documentId) ||
    Boolean(input.documentEvidence?.sourceText?.trim());

  return (
    hasDocumentEvidence &&
    (input.historicalSupportCount > 0 || input.dependencySupportCount > 0)
  );
}

export function buildPricingRecommendationRationale(
  input: BuildPricingRecommendationRationaleInput
) {
  const duplicateGroupMetadata = {
    sectionName: input.duplicateGroupMetadata.sectionName ?? input.sectionName,
    normalizedIntent: input.duplicateGroupMetadata.normalizedIntent ?? input.normalizedIntent,
    sourceRowIdentity: input.duplicateGroupMetadata.sourceRowIdentity ?? input.sourceRowIdentity,
    duplicateKeys: [...input.duplicateGroupMetadata.duplicateKeys].sort(),
    suppressedCount: input.duplicateGroupMetadata.suppressedCount,
  };

  return {
    normalizedIntent: input.normalizedIntent,
    sectionName: input.sectionName,
    sourceRowIdentity: input.sourceRowIdentity,
    optionRows: input.optionRows.map((option) => ({
      rank: option.rank,
      optionLabel: option.optionLabel,
      optionKind: option.optionKind,
      catalogItemId: option.catalogItemId ?? null,
      localCatalogItemId: option.localCatalogItemId ?? null,
      normalizedCustomItemKey: option.normalizedCustomItemKey ?? null,
    })),
    duplicateGroupMetadata,
    evidenceJson: input.evidenceJson,
  };
}

export function isConfirmedMeasurementCandidateForPricing(input: {
  extractionType?: string | null;
  metadataJson?: unknown;
}) {
  if (input.extractionType !== "measurement_candidate") return true;

  if (
    !input.metadataJson ||
    typeof input.metadataJson !== "object" ||
    input.metadataJson === null
  ) {
    return false;
  }

  return (input.metadataJson as Record<string, unknown>).measurementConfirmationState === "approved";
}
