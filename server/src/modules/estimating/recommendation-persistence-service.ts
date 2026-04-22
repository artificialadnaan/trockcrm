import { eq } from "drizzle-orm";
import {
  estimateExtractionMatches,
  estimateExtractions,
  estimatePricingRecommendationOptions,
  estimatePricingRecommendations,
} from "@trock-crm/shared/schema";
import type { MarketRateEnrichedPricingRecommendation } from "./pricing-service.js";
import type { BuildRecommendationOptionSetResult } from "./recommendation-option-service.js";

async function insertWithReturningOrThrow<TRecord extends { id: string }>(
  db: any,
  table: unknown,
  values: Record<string, unknown> | Record<string, unknown>[]
) {
  const insertQuery = db.insert(table).values(values) as any;

  if (typeof insertQuery.returning === "function") {
    const rows = await insertQuery.returning();
    return rows[0] as TRecord;
  }

  throw new Error("estimate generation requires returning() support for persisted recommendation rows");
}

export interface PersistPricingRecommendationBundleInput {
  tenantDb: any;
  generationRunId: string | null;
  extraction: {
    id: string;
    dealId: string;
    projectId: string | null;
    documentId: string | null;
    quantity: number;
    unit: string | null;
    sourceType: "extracted" | "inferred";
    normalizedIntent: string;
    sourceRowIdentity: string;
    evidenceText?: string | null;
    rawLabel?: string | null;
    normalizedLabel?: string | null;
  };
  topMatch: {
    catalogItemId: string;
    matchScore: number;
    reasons: Record<string, unknown>;
    historicalLineItemIds: string[];
    catalogBaselinePrice: number | null;
  };
  recommendation: MarketRateEnrichedPricingRecommendation;
  recommendationSet: BuildRecommendationOptionSetResult;
  rationaleJson: Record<string, unknown>;
}

function buildMarketRateJson(input: Pick<MarketRateEnrichedPricingRecommendation, "marketRateContext" | "marketRateRationale">) {
  return {
    resolvedMarket: input.marketRateContext.resolvedMarket,
    resolutionLevel: input.marketRateContext.resolutionLevel,
    resolutionSource: input.marketRateContext.resolutionSource,
    componentAdjustments: input.marketRateRationale.componentAdjustments,
    baselinePrice: input.marketRateRationale.baselinePrice,
    selectedRuleId: input.marketRateRationale.selectedRuleId,
  };
}

function formatCurrency(value: number) {
  return Number(value.toFixed(2)).toFixed(2);
}

export async function persistPricingRecommendationBundle(input: PersistPricingRecommendationBundleInput) {
  const savedMatch = await insertWithReturningOrThrow<{ id: string }>(
    input.tenantDb,
    estimateExtractionMatches,
    {
      extractionId: input.extraction.id,
      catalogItemId: input.topMatch.catalogItemId,
      matchType: "catalog_plus_history",
      matchScore: input.topMatch.matchScore.toString(),
      status: "suggested",
      reasonJson: input.topMatch.reasons,
      evidenceJson: {
        historicalLineItemIds: input.topMatch.historicalLineItemIds,
      },
    }
  );

  const marketRateJson = buildMarketRateJson(input.recommendation);

  const savedRecommendation = await insertWithReturningOrThrow<{ id: string }>(
    input.tenantDb,
    estimatePricingRecommendations,
    {
      dealId: input.extraction.dealId,
      projectId: input.extraction.projectId,
      extractionMatchId: savedMatch?.id ?? input.extraction.id,
      sourceDocumentId: input.extraction.documentId ?? null,
      sourceExtractionId: input.extraction.id,
      sourceType: input.extraction.sourceType,
      normalizedIntent: input.extraction.normalizedIntent,
      sourceRowIdentity: input.extraction.sourceRowIdentity,
      recommendedQuantity: String(input.recommendation.quantity),
      recommendedUnit: input.extraction.unit ?? null,
      recommendedUnitPrice: formatCurrency(input.recommendation.recommendedUnitPrice),
      recommendedTotalPrice: formatCurrency(input.recommendation.recommendedTotalPrice),
      priceBasis: input.recommendation.priceBasis,
      catalogBaselinePrice:
        input.recommendation.catalogBaselinePrice != null
          ? String(input.recommendation.catalogBaselinePrice)
          : null,
      historicalMedianPrice:
        input.recommendation.historicalMedianPrice != null
          ? String(input.recommendation.historicalMedianPrice)
          : null,
      marketAdjustmentPercent: String(input.recommendation.marketAdjustmentPercent),
      confidence: String(input.recommendation.confidence),
      assumptionsJson: {
        ...input.recommendation.assumptions,
        rationaleJson: input.rationaleJson,
        marketRate: marketRateJson,
      },
      evidenceJson: {
        comparableHistoricalPrices: input.recommendation.comparableHistoricalPrices,
        duplicateGroupMetadata: input.recommendationSet.duplicateGroupMetadata,
        optionRows: input.recommendationSet.optionRows.map((option) => ({
          rank: option.rank,
          optionLabel: option.optionLabel,
          optionKind: option.optionKind,
          catalogItemId: option.catalogItemId,
          localCatalogItemId: option.localCatalogItemId,
          normalizedCustomItemKey: option.normalizedCustomItemKey,
          stableId: option.stableId,
        })),
        marketRate: marketRateJson,
      },
      createdByRunId: input.generationRunId,
      selectedSourceType: null,
      selectedOptionId: null,
      catalogBacking: input.extraction.sourceType === "inferred" ? "estimate_only" : "procore_synced",
      promotedLocalCatalogItemId: null,
      manualOrigin: null,
      manualLabel: null,
      manualIdentityKey: null,
      manualQuantity: null,
      manualUnit: null,
      manualUnitPrice: null,
      manualNotes: null,
      overrideQuantity: null,
      overrideUnit: null,
      overrideUnitPrice: null,
      overrideNotes: null,
      status: "pending",
    }
  );

  if (input.recommendationSet.optionRows.length > 0) {
    await input.tenantDb.insert(estimatePricingRecommendationOptions).values(
      input.recommendationSet.optionRows.map((option) => ({
        recommendationId: savedRecommendation.id,
        catalogItemId: option.catalogItemId,
        localCatalogItemId: option.localCatalogItemId,
        rank: option.rank,
        optionLabel: option.optionLabel,
        optionKind: option.optionKind,
      }))
    );
  }

  await input.tenantDb
    .update(estimateExtractions)
    .set({ status: "processed" })
    .where(eq(estimateExtractions.id, input.extraction.id));

  return {
    match: savedMatch,
    recommendation: savedRecommendation,
  };
}
