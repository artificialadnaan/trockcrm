import { beforeEach, describe, expect, it, vi } from "vitest";

const drizzleMock = vi.fn();
const poolQueryMock = vi.fn();
const getHistoricalPricingSignalsMock = vi.fn();
const listCatalogCandidatesForMatchingMock = vi.fn();
const resolveActiveCatalogSnapshotVersionIdMock = vi.fn();
const rankExtractionMatchesMock = vi.fn();
const buildPricingRecommendationMock = vi.fn();

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: drizzleMock,
}));

vi.mock("../../src/db.js", () => ({
  pool: {
    query: poolQueryMock,
  },
}));

vi.mock("../../../server/src/modules/estimating/catalog-read-model-service.js", () => ({
  listCatalogCandidatesForMatching: listCatalogCandidatesForMatchingMock,
  resolveActiveCatalogSnapshotVersionId: resolveActiveCatalogSnapshotVersionIdMock,
}));

vi.mock("../../../server/src/modules/estimating/historical-pricing-service.js", () => ({
  getHistoricalPricingSignals: getHistoricalPricingSignalsMock,
}));

vi.mock("../../../server/src/modules/estimating/matching-service.js", () => ({
  rankExtractionMatches: rankExtractionMatchesMock,
}));

vi.mock("../../../server/src/modules/estimating/pricing-service.js", () => ({
  buildPricingRecommendation: buildPricingRecommendationMock,
}));

describe("estimate generation job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    poolQueryMock.mockResolvedValue({
      rows: [{ slug: "estimating" }],
    });
  });

  it("returns early when the queued parse run no longer owns the document", async () => {
    const appDb = {
      select: vi.fn(),
    } as any;
    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                activeParseRunId: "parse-run-newer",
                parseStatus: "completed",
                ocrStatus: "completed",
              },
            ]),
          })),
        })),
      })),
      insert: vi.fn(),
      update: vi.fn(),
    } as any;

    drizzleMock.mockReturnValueOnce(appDb).mockReturnValueOnce(tenantDb);

    const { runEstimateGeneration } = await import("../../src/jobs/estimate-generation.js");

    await runEstimateGeneration(
      {
        documentId: "doc-1",
        dealId: "deal-1",
        parseRunId: "parse-run-1",
      },
      "office-1"
    );

    expect(tenantDb.execute).toHaveBeenCalledTimes(1);
    expect(appDb.select).not.toHaveBeenCalled();
    expect(tenantDb.insert).not.toHaveBeenCalled();
    expect(getHistoricalPricingSignalsMock).not.toHaveBeenCalled();
    expect(listCatalogCandidatesForMatchingMock).not.toHaveBeenCalled();
    expect(rankExtractionMatchesMock).not.toHaveBeenCalled();
    expect(buildPricingRecommendationMock).not.toHaveBeenCalled();
  });
});
