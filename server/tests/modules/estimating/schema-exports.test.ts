import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  costCatalogCodes,
  costCatalogItemCodes,
  costCatalogItems,
  costCatalogPrices,
  costCatalogSnapshotVersions,
  costCatalogSources,
  costCatalogSyncRuns,
  estimateDocumentParseRuns,
  estimateDocumentPages,
  estimateExtractions,
  estimateExtractionMatches,
  estimateGenerationRuns,
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
    expect(estimateExtractions).toBeDefined();
    expect(estimateExtractionMatches).toBeDefined();
    expect(estimatePricingRecommendations).toBeDefined();
    expect(estimatePricingRecommendationOptions).toBeDefined();
    expect(estimateGenerationRuns).toBeDefined();
    expect(estimateReviewEvents).toBeDefined();

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
