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
  estimateReviewEvents,
  estimateSourceDocuments,
} from "../../../../shared/src/schema/index.js";

describe("estimating schema exports", () => {
  it("exports the full catalog and generation schema set", () => {
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
    expect(estimateGenerationRuns).toBeDefined();
    expect(estimateReviewEvents).toBeDefined();
  });
});
