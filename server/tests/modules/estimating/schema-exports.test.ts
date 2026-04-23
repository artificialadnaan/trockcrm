import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  costCatalogCodes,
  costCatalogItemCodes,
  costCatalogItems,
  costCatalogPrices,
  costCatalogSnapshotVersions,
  costCatalogSources,
  costCatalogSyncRuns,
  estimateDealMarketOverrides,
  estimateDocumentParseRuns,
  estimateDocumentPages,
  estimateExtractions,
  estimateExtractionMatches,
  estimateGenerationRuns,
  estimateMarketAdjustmentRules,
  estimateMarketFallbackGeographies,
  estimateMarketZipMappings,
  estimateMarkets,
  estimatePricingRecommendations,
  estimatePricingRecommendationOptions,
  estimateReviewEvents,
  estimateSourceDocuments,
} from "../../../../shared/src/schema/index.js";

describe("estimating schema exports", () => {
  it("exports the full catalog, recommendation, and generation schema set", () => {
    expect(costCatalogSources).toBeDefined();
    expect(costCatalogSyncRuns).toBeDefined();
    expect(costCatalogSnapshotVersions).toBeDefined();
    expect(costCatalogCodes).toBeDefined();
    expect(costCatalogItems).toBeDefined();
    expect(costCatalogItemCodes).toBeDefined();
    expect(costCatalogPrices).toBeDefined();
    expect(estimateSourceDocuments).toBeDefined();
    expect(estimateDocumentParseRuns).toBeDefined();
    expect(estimateDocumentPages).toBeDefined();
    expect(estimateMarkets).toBeDefined();
    expect(estimateMarketZipMappings).toBeDefined();
    expect(estimateMarketFallbackGeographies).toBeDefined();
    expect(estimateMarketAdjustmentRules).toBeDefined();
    expect(estimateDealMarketOverrides).toBeDefined();
    expect(estimateExtractions).toBeDefined();
    expect(estimateExtractionMatches).toBeDefined();
    expect(estimatePricingRecommendations).toBeDefined();
    expect(estimatePricingRecommendationOptions).toBeDefined();
    expect(estimateGenerationRuns).toBeDefined();
    expect(estimateReviewEvents).toBeDefined();

    const marketColumns = getTableColumns(estimateMarkets);
    expect(marketColumns.type).toBeDefined();
    expect(marketColumns.stateCode).toBeDefined();
    expect(marketColumns.regionId).toBeDefined();

    const zipColumns = getTableColumns(estimateMarketZipMappings);
    expect(zipColumns.sourceType).toBeDefined();
    expect(zipColumns.sourceConfidence).toBeDefined();

    const ruleColumns = getTableColumns(estimateMarketAdjustmentRules);
    expect(ruleColumns.marketId.notNull).toBe(false);
    expect(ruleColumns.priority).toBeDefined();
    expect(ruleColumns.fallbackPriority).toBeDefined();

    const overrideConfig = getTableConfig(estimateDealMarketOverrides);
    expect(
      overrideConfig.foreignKeys.map((fk) => fk.getName())
    ).toContain("estimate_deal_market_overrides_deal_id_deals_id_fk");

    const recommendationColumns = getTableColumns(estimatePricingRecommendations);
    expect(recommendationColumns.sourceType).toBeDefined();
    expect(recommendationColumns.sourceType.name).toBe("source_type");
    expect(recommendationColumns.normalizedIntent).toBeDefined();
    expect(recommendationColumns.sourceRowIdentity).toBeDefined();
    expect(recommendationColumns.createdByRunId).toBeDefined();
    expect(recommendationColumns.createdByRunId.name).toBe("generation_run_id");
    expect(recommendationColumns.manualOrigin).toBeDefined();
    expect(recommendationColumns.selectedSourceType).toBeDefined();
    expect(recommendationColumns.catalogBacking).toBeDefined();
    expect(recommendationColumns.promotedLocalCatalogItemId).toBeDefined();
    expect(recommendationColumns.manualLabel).toBeDefined();
    expect(recommendationColumns.manualIdentityKey).toBeDefined();
    expect(recommendationColumns.manualQuantity).toBeDefined();
    expect(recommendationColumns.manualUnit).toBeDefined();
    expect(recommendationColumns.manualUnitPrice).toBeDefined();
    expect(recommendationColumns.manualNotes).toBeDefined();
    expect(recommendationColumns.overrideQuantity).toBeDefined();
    expect(recommendationColumns.overrideUnit).toBeDefined();
    expect(recommendationColumns.overrideUnitPrice).toBeDefined();
    expect(recommendationColumns.overrideNotes).toBeDefined();

    const optionColumns = getTableColumns(estimatePricingRecommendationOptions);
    expect(optionColumns.recommendationId).toBeDefined();
    expect(optionColumns.catalogItemId).toBeDefined();
    expect(optionColumns.localCatalogItemId).toBeDefined();
    expect(optionColumns.rank).toBeDefined();
    expect(optionColumns.optionLabel).toBeDefined();
    expect(optionColumns.optionKind).toBeDefined();
  });
});
