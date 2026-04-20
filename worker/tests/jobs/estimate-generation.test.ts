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

function readSqlText(query: any) {
  const chunks = query?.queryChunks ?? [];
  return chunks
    .map((chunk: any) => {
      if (chunk?.queryChunks) {
        return readSqlText(chunk);
      }
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        return Array.isArray(chunk.value) ? chunk.value.join("") : "";
      }
      return "?";
    })
    .join("");
}

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

  it("filters pending extractions to the still-active parse run before processing", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([]);
    const documentLimit = vi.fn().mockResolvedValue([
      {
        activeParseRunId: "parse-run-1",
        parseStatus: "completed",
        ocrStatus: "completed",
      },
    ]);
    const extractionWhere = vi.fn().mockResolvedValue([]);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    let tenantSelectCallCount = 0;
    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn((fields?: any) => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;

          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                limit: documentLimit,
              })),
            };
          }

          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }

          throw new Error(`Unexpected tenant select call: ${tenantSelectCallCount}`);
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([
            {
              id: "generation-run-1",
            },
          ]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    } as any;

    getHistoricalPricingSignalsMock.mockResolvedValue({
      historicalItems: [],
      vendorQuotes: [],
      currentDeal: null,
    });
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

    const extractionFilterSql = readSqlText(extractionWhere.mock.calls[0]?.[0]);
    expect(extractionFilterSql).toContain("sourceParseRunId");
    expect(extractionFilterSql).toContain("estimate_source_documents as document");
    expect(extractionFilterSql).toContain("active_parse_run_id");
    expect(extractionFilterSql).toContain("document.parse_status = 'completed'");
    expect(extractionFilterSql).toContain("document.ocr_status = 'completed'");
    expect(rankExtractionMatchesMock).not.toHaveBeenCalled();
    expect(buildPricingRecommendationMock).not.toHaveBeenCalled();
    expect(tenantDb.insert).toHaveBeenCalledTimes(1);
  });
});
