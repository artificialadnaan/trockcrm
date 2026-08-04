import { beforeEach, describe, expect, it, vi } from "vitest";

const drizzleMock = vi.fn();
const poolQueryMock = vi.fn();
const poolConnectMock = vi.fn();
const getHistoricalPricingSignalsMock = vi.fn();
const createMarketRateProviderMock = vi.fn();
const resolveMarketContextMock = vi.fn();
const calculateMarketRateAdjustmentMock = vi.fn();
const applyMarketRateAdjustmentMock = vi.fn();
const listCatalogCandidatesForMatchingMock = vi.fn();
const resolveActiveCatalogSnapshotVersionIdMock = vi.fn();
const rankExtractionMatchesMock = vi.fn();
const buildPricingRecommendationMock = vi.fn();
const isInferredRecommendationRowEligibleMock = vi.fn((input: any) => {
  if (input.sourceType !== "inferred") return true;

  return (
    (input.documentEvidence?.documentId || input.documentEvidence?.sourceText?.trim()) &&
    (input.historicalSupportCount > 0 || input.dependencySupportCount > 0)
  );
});
const isConfirmedMeasurementCandidateForPricingMock = vi.fn((input: any) =>
  input.extractionType !== "measurement_candidate" ||
  input.metadataJson?.measurementConfirmationState === "approved"
);
const cloneManualRowsForGenerationRunMock = vi.fn();

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: drizzleMock,
}));

vi.mock("../../src/db.js", () => ({
  pool: {
    query: poolQueryMock,
    connect: poolConnectMock,
  },
}));

// The job resolves each server module dist-FIRST with a src fallback (importFirstAvailable in
// src/jobs/estimate-generation.ts). A mock bound only to the dist specifier silently no-ops whenever the
// src branch is taken: the real module loads and the spies record ZERO calls — exactly the
// "buildPricingRecommendationMock receives 0 calls" symptom reported on #988. Each mock below is
// therefore registered against BOTH specifiers, so the suite no longer depends on whether server/dist
// happens to exist (it differs between a fresh clone, a post-`npm run build` tree, and a CI sandbox).
vi.mock("../../../server/dist/modules/estimating/catalog-read-model-service.js", () => ({
  listCatalogCandidatesForMatching: listCatalogCandidatesForMatchingMock,
  resolveActiveCatalogSnapshotVersionId: resolveActiveCatalogSnapshotVersionIdMock,
}));
vi.mock("../../../server/src/modules/estimating/catalog-read-model-service.js", () => ({
  listCatalogCandidatesForMatching: listCatalogCandidatesForMatchingMock,
  resolveActiveCatalogSnapshotVersionId: resolveActiveCatalogSnapshotVersionIdMock,
}));

vi.mock("../../../server/dist/modules/estimating/historical-pricing-service.js", () => ({
  getHistoricalPricingSignals: getHistoricalPricingSignalsMock,
}));
vi.mock("../../../server/src/modules/estimating/historical-pricing-service.js", () => ({
  getHistoricalPricingSignals: getHistoricalPricingSignalsMock,
}));

vi.mock("../../../server/dist/modules/estimating/market-rate-provider.js", () => ({
  createMarketRateProvider: createMarketRateProviderMock,
}));
vi.mock("../../../server/src/modules/estimating/market-rate-provider.js", () => ({
  createMarketRateProvider: createMarketRateProviderMock,
}));

vi.mock("../../../server/dist/modules/estimating/market-resolution-service.js", () => ({
  resolveMarketContext: resolveMarketContextMock,
}));
vi.mock("../../../server/src/modules/estimating/market-resolution-service.js", () => ({
  resolveMarketContext: resolveMarketContextMock,
}));

vi.mock("../../../server/dist/modules/estimating/market-rate-service.js", () => ({
  calculateMarketRateAdjustment: calculateMarketRateAdjustmentMock,
}));
vi.mock("../../../server/src/modules/estimating/market-rate-service.js", () => ({
  calculateMarketRateAdjustment: calculateMarketRateAdjustmentMock,
}));

vi.mock("../../../server/dist/modules/estimating/matching-service.js", () => ({
  rankExtractionMatches: rankExtractionMatchesMock,
}));
vi.mock("../../../server/src/modules/estimating/matching-service.js", () => ({
  rankExtractionMatches: rankExtractionMatchesMock,
}));

vi.mock("../../../server/dist/modules/estimating/pricing-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../server/dist/modules/estimating/pricing-service.js")>();
  return {
    ...actual,
    buildPricingRecommendation: buildPricingRecommendationMock,
    applyMarketRateAdjustment: applyMarketRateAdjustmentMock,
    isInferredRecommendationRowEligible: isInferredRecommendationRowEligibleMock,
    isConfirmedMeasurementCandidateForPricing: isConfirmedMeasurementCandidateForPricingMock,
  };
});
vi.mock("../../../server/src/modules/estimating/pricing-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../server/src/modules/estimating/pricing-service.js")>();
  return {
    ...actual,
    buildPricingRecommendation: buildPricingRecommendationMock,
    applyMarketRateAdjustment: applyMarketRateAdjustmentMock,
    isInferredRecommendationRowEligible: isInferredRecommendationRowEligibleMock,
    isConfirmedMeasurementCandidateForPricing: isConfirmedMeasurementCandidateForPricingMock,
  };
});

vi.mock("../../../server/dist/modules/estimating/draft-estimate-service.js", () => ({
  cloneManualRowsForGenerationRun: cloneManualRowsForGenerationRunMock,
}));
vi.mock("../../../server/src/modules/estimating/draft-estimate-service.js", () => ({
  cloneManualRowsForGenerationRun: cloneManualRowsForGenerationRunMock,
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

/**
 * The bound scalar out of an `eq(column, value)` condition.
 *
 * `eq` compiles to chunks [StringChunk, Column, StringChunk, Param, StringChunk]; the Param is the only
 * one carrying a plain string, because a StringChunk holds an ARRAY of SQL text and a Column holds no
 * `value` at all. That is what lets the stub below answer for the row actually being asked about.
 */
function whereParamValue(condition: any): string | undefined {
  return (condition?.queryChunks ?? []).find((chunk: any) => typeof chunk?.value === "string")?.value;
}

/**
 * The `stillPriceable` re-read, standing in for rows NOBODY TOUCHED since the snapshot.
 *
 * The guard compares the live quantity against the one the recommendation was priced from and refuses
 * ANY difference, so a stub answering with a fixed literal reads as a concurrent edit against every test
 * whose rows carry some other number. That failure is worse than loud: most of these tests assert on
 * matching and pricing, which both happen BEFORE the write, so they would keep passing while quietly
 * exercising none of the persistence they were written for. Answering out of the same rows the run
 * snapshotted keeps "unchanged" meaning unchanged; the drift cases stub their own reply.
 */
function unchangedQuantityRead(rows: Array<{ id: string; quantity: unknown }>) {
  return {
    where: vi.fn((condition: any) => {
      const row = rows.find((candidate) => candidate.id === whereParamValue(condition));
      return {
        limit: vi.fn(() => ({
          for: vi.fn().mockResolvedValue(row ? [{ quantity: row.quantity }] : []),
        })),
      };
    }),
  };
}

describe("estimate generation job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    poolQueryMock.mockResolvedValue({
      rows: [{ slug: "estimating" }],
    });
    createMarketRateProviderMock.mockReturnValue({
      findDealMarketOverride: vi.fn(),
      findMarketByZip: vi.fn(),
      findMarketByFallbackGeography: vi.fn(),
      getDefaultMarket: vi.fn(),
      listMarketAdjustmentRules: vi.fn(),
    });
    buildPricingRecommendationMock.mockImplementation((input: any) => ({
      quantity: Number(input.quantity ?? 1),
      priceBasis: "mock",
      recommendedUnitPrice: 10,
      recommendedTotalPrice: 10,
      comparableHistoricalPrices: [],
      historicalMedianPrice: null,
      catalogBaselinePrice: null,
      marketAdjustmentPercent: 0,
      assumptions: {},
      confidence: 1,
    }));
    resolveMarketContextMock.mockResolvedValue({
      market: {
        id: "market-1",
        name: "Default Market",
        slug: "default",
        type: "global",
        stateCode: null,
        regionId: null,
        isActive: true,
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      resolutionLevel: "global_default",
      resolutionSource: { type: "global", key: "default", marketId: "market-1" },
      location: { zip: null, state: null, regionId: null },
    });
    calculateMarketRateAdjustmentMock.mockResolvedValue({
      market: {
        id: "market-1",
        name: "Default Market",
        slug: "default",
        type: "global",
        stateCode: null,
        regionId: null,
        isActive: true,
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      resolutionLevel: "global_default",
      resolutionSource: { type: "global", key: "default", marketId: "market-1" },
      baselinePrice: 0,
      selectedRule: null,
      componentAdjustments: [],
      adjustedPrice: 0,
      rationale: {
        resolvedMarket: {
          id: "market-1",
          name: "Default Market",
          slug: "default",
          type: "global",
          stateCode: null,
          regionId: null,
          isActive: true,
          createdAt: new Date("2026-04-21T00:00:00Z"),
          updatedAt: new Date("2026-04-21T00:00:00Z"),
        },
        resolutionLevel: "global_default",
        resolutionSource: { type: "global", key: "default", marketId: "market-1" },
        baselinePrice: 0,
        selectedRuleId: null,
        componentAdjustments: [],
      },
    });
    applyMarketRateAdjustmentMock.mockImplementation(({ recommendation, marketRateAdjustment }: any) => ({
      ...recommendation,
      recommendedUnitPrice:
        recommendation.quantity > 0 ? marketRateAdjustment.adjustedPrice / recommendation.quantity : 0,
      recommendedTotalPrice: recommendation.quantity > 0 ? marketRateAdjustment.adjustedPrice : 0,
      marketAdjustmentPercent: 0,
      marketRateContext: {
        resolvedMarket: marketRateAdjustment.market,
        resolutionLevel: marketRateAdjustment.resolutionLevel,
        resolutionSource: marketRateAdjustment.resolutionSource,
      },
      marketRateRationale: marketRateAdjustment.rationale,
    }));
  });

  it("persists a failed generation run when the queued parse run cannot be locked as the active document owner", async () => {
    const appDb = {
      select: vi.fn(),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    const generationRunWhere = vi.fn().mockResolvedValue(undefined);
    const generationRunSet = vi.fn(() => ({
      where: generationRunWhere,
    }));
    const tenantDb = {
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
        set: generationRunSet,
      })),
    } as any;

    poolConnectMock.mockResolvedValue(lockedClient);
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

    expect(String(lockedClient.query.mock.calls[0]?.[0])).toContain("SET search_path TO office_estimating, public");
    expect(lockedClient.query).toHaveBeenCalledWith("BEGIN");
    expect(String(lockedClient.query.mock.calls[2]?.[0])).toContain("SET LOCAL search_path TO office_estimating, public");
    expect(String(lockedClient.query.mock.calls[3]?.[0])).toContain("FOR UPDATE");
    expect(lockedClient.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(lockedClient.release).toHaveBeenCalledTimes(1);
    expect(appDb.select).not.toHaveBeenCalled();
    expect(tenantDb.insert).toHaveBeenCalledTimes(1);
    expect(generationRunSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorSummary: "estimate generation skipped: parse run is no longer active",
      })
    );
    expect(generationRunWhere).toHaveBeenCalled();
    expect(getHistoricalPricingSignalsMock).not.toHaveBeenCalled();
    expect(listCatalogCandidatesForMatchingMock).not.toHaveBeenCalled();
    expect(rankExtractionMatchesMock).not.toHaveBeenCalled();
    expect(buildPricingRecommendationMock).not.toHaveBeenCalled();
  });

  it("filters eligible extractions to the still-active parse run before processing", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([]);
    const extractionRows: Array<{ id: string; quantity: unknown }> = [];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn((fields?: any) => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;

          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }

          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }

          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
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
    poolConnectMock.mockResolvedValue(lockedClient);
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
    expect(String(lockedClient.query.mock.calls[3]?.[0])).toContain("FOR UPDATE");
    expect(lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
    expect(lockedClient.release).toHaveBeenCalledTimes(1);
    expect(extractionFilterSql).toContain("sourceParseRunId");
    expect(extractionFilterSql).toContain("activeArtifact");
    expect(extractionFilterSql).toContain("estimate_source_documents as document");
    expect(extractionFilterSql).toContain("active_parse_run_id");
    expect(extractionFilterSql).toContain("document.parse_status = 'completed'");
    expect(extractionFilterSql).toContain("document.ocr_status = 'completed'");
    expect(extractionFilterSql).toContain("'pending'");
    expect(extractionFilterSql).toContain("measurement_candidate");
    expect(lockedClient.query.mock.invocationCallOrder[3]).toBeLessThan(
      extractionWhere.mock.invocationCallOrder[0]
    );
    expect(extractionWhere.mock.invocationCallOrder[0]).toBeLessThan(
      lockedClient.query.mock.invocationCallOrder[4]
    );
    expect(rankExtractionMatchesMock).not.toHaveBeenCalled();
    expect(buildPricingRecommendationMock).not.toHaveBeenCalled();
    expect(tenantDb.insert).toHaveBeenCalledTimes(1);
  });

  it("processes confirmed measurement candidates but skips unconfirmed ones", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionRows = [
      {
        id: "ext-normal",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        quantity: "1",
        unit: "ea",
        normalizedLabel: "Normal row",
        metadataJson: {
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
        },
      },
      {
        id: "ext-confirmed",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "measurement_candidate",
        status: "approved",
        quantity: "2",
        unit: "lf",
        normalizedLabel: "Confirmed measurement",
        metadataJson: {
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
          measurementConfirmationState: "approved",
        },
      },
      {
        id: "ext-unconfirmed",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "measurement_candidate",
        status: "approved",
        quantity: "3",
        unit: "lf",
        normalizedLabel: "Unconfirmed measurement",
        metadataJson: {
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
          measurementConfirmationState: "pending",
        },
      },
    ];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;
          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }
          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "generated-id" }]),
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
    resolveActiveCatalogSnapshotVersionIdMock.mockResolvedValue("snapshot-1");
    listCatalogCandidatesForMatchingMock.mockResolvedValue([]);
    rankExtractionMatchesMock.mockImplementation(async ({ extraction }: any) => [
      {
        catalogItemId: `catalog-${extraction.id}`,
        matchScore: 99,
        reasons: { matched: extraction.id },
        historicalLineItemIds: [],
        catalogBaselinePrice: 100,
        historicalUnitPrices: [],
        vendorQuotePrice: null,
        awardedOutcomeAdjustmentPercent: 0,
        internalAdjustmentPercent: 0,
      },
    ]);
    buildPricingRecommendationMock.mockImplementation(() => ({
      quantity: 1,
      priceBasis: "mock",
      recommendedUnitPrice: 10,
      recommendedTotalPrice: 10,
      comparableHistoricalPrices: [],
      historicalMedianPrice: null,
      catalogBaselinePrice: null,
      marketAdjustmentPercent: 0,
      assumptions: {},
      confidence: 1,
    }));
    poolConnectMock.mockResolvedValue(lockedClient);
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

    const rankedExtractionIds = rankExtractionMatchesMock.mock.calls.map(
      ([input]: any) => input.extraction.id
    );

    expect(rankedExtractionIds).toEqual(["ext-normal", "ext-confirmed"]);
    expect(rankedExtractionIds).not.toContain("ext-unconfirmed");
    expect(buildPricingRecommendationMock).toHaveBeenCalledTimes(2);
    expect(lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("does NOT persist a recommendation for a quantity cleared since the snapshot", async () => {
    // `pendingExtractions` is read once at the top of a run, and a generation takes a while. An
    // estimator clearing a quantity in that window leaves the loop's guard looking at the OLD positive
    // value — so the worker prices it and `persistPricingRecommendationBundle` sets the row
    // `processed`, overwriting the `needs_quantity` the edit just wrote and publishing a number built
    // on a quantity somebody explicitly removed. The re-read happens under the row lock, immediately
    // before the write it guards.
    const statusWrites: any[] = [];
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionWhere = vi.fn().mockResolvedValue([
      {
        id: "ext-cleared",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        // What the snapshot saw.
        quantity: "700",
        unit: "SF",
        normalizedLabel: "Install laminate",
        metadataJson: { sourceParseRunId: "parse-run-1", activeArtifact: true },
      },
    ]);
    const appDb = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: sourceLimit })) })) })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;
          if (tenantSelectCallCount === 1) {
            return { where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) };
          }
          if (tenantSelectCallCount === 2) return { where: extractionWhere };
          // The re-read: by now the estimator has cleared it.
          return {
            where: vi.fn(() => ({
              limit: vi.fn(() => ({ for: vi.fn().mockResolvedValue([{ quantity: null }]) })),
            })),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "generated-id" }]) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: unknown) => {
          statusWrites.push(values);
          return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "claimed" }]) })) };
        }),
      })),
    } as any;

    getHistoricalPricingSignalsMock.mockResolvedValue({
      historicalItems: [],
      vendorQuotes: [],
      currentDeal: null,
    });
    resolveActiveCatalogSnapshotVersionIdMock.mockResolvedValue("snapshot-1");
    listCatalogCandidatesForMatchingMock.mockResolvedValue([]);
    rankExtractionMatchesMock.mockImplementation(async ({ extraction }: any) => [
      {
        catalogItemId: `catalog-${extraction.id}`,
        matchScore: 99,
        reasons: {},
        historicalLineItemIds: [],
        catalogBaselinePrice: 100,
        historicalUnitPrices: [],
        vendorQuotePrice: null,
        awardedOutcomeAdjustmentPercent: 0,
        internalAdjustmentPercent: 0,
      },
    ]);
    buildPricingRecommendationMock.mockImplementation(() => ({
      quantity: 700,
      priceBasis: "mock",
      recommendedUnitPrice: 10,
      recommendedTotalPrice: 7000,
      comparableHistoricalPrices: [],
      historicalMedianPrice: null,
      catalogBaselinePrice: null,
      marketAdjustmentPercent: 0,
      assumptions: {},
      confidence: 1,
    }));
    poolConnectMock.mockResolvedValue(lockedClient);
    drizzleMock.mockReturnValueOnce(appDb).mockReturnValueOnce(tenantDb);

    const { runEstimateGeneration } = await import("../../src/jobs/estimate-generation.js");
    await runEstimateGeneration(
      { documentId: "doc-1", dealId: "deal-1", parseRunId: "parse-run-1" },
      "office-1"
    );

    // It matched and priced from the snapshot — that work is wasted, not wrong. What must NOT happen is
    // the write: `persistPricingRecommendationBundle` marks the extraction `processed`, which would
    // overwrite the `needs_quantity` the estimator's edit just set and leave a recommendation standing
    // on a quantity they removed.
    expect(buildPricingRecommendationMock).toHaveBeenCalledTimes(1);
    expect(statusWrites.some((write) => write?.status === "processed")).toBe(false);
    expect(lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
  });

  /**
   * One run over one row the snapshot saw at 10 SF, with whatever the row says by the time the persist
   * path re-reads it under the lock.
   *
   * The two cases below differ only in that live value and in what must happen, so they share this. A
   * guard that refuses a corrected quantity but also refuses an untouched one passes the drift test and
   * silently stops the feature — only the pair can tell those apart.
   */
  async function runWithLiveQuantity(liveQuantity: unknown) {
    const statusWrites: any[] = [];
    const insertPayloads: any[] = [];
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionRows = [
      {
        id: "ext-remeasured",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        // What the snapshot saw, and therefore what the recommendation is priced from.
        quantity: "10",
        unit: "SF",
        normalizedLabel: "Install laminate",
        metadataJson: { sourceParseRunId: "parse-run-1", activeArtifact: true },
      },
    ];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: sourceLimit })) })) })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;
          if (tenantSelectCallCount === 1) {
            return { where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) };
          }
          if (tenantSelectCallCount === 2) return { where: extractionWhere };
          // The re-read under the row lock, answering with what the row says NOW.
          return {
            where: vi.fn(() => ({
              limit: vi.fn(() => ({ for: vi.fn().mockResolvedValue([{ quantity: liveQuantity }]) })),
            })),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((payload: any) => {
          insertPayloads.push(payload);
          return { returning: vi.fn().mockResolvedValue([{ id: "generated-id" }]) };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: unknown) => {
          statusWrites.push(values);
          return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "claimed" }]) })) };
        }),
      })),
    } as any;

    getHistoricalPricingSignalsMock.mockResolvedValue({
      historicalItems: [],
      vendorQuotes: [],
      currentDeal: null,
    });
    resolveActiveCatalogSnapshotVersionIdMock.mockResolvedValue("snapshot-1");
    listCatalogCandidatesForMatchingMock.mockResolvedValue([]);
    rankExtractionMatchesMock.mockImplementation(async ({ extraction }: any) => [
      {
        catalogItemId: `catalog-${extraction.id}`,
        matchScore: 99,
        reasons: {},
        historicalLineItemIds: [],
        catalogBaselinePrice: 100,
        historicalUnitPrices: [],
        vendorQuotePrice: null,
        awardedOutcomeAdjustmentPercent: 0,
        internalAdjustmentPercent: 0,
      },
    ]);
    poolConnectMock.mockResolvedValue(lockedClient);
    drizzleMock.mockReturnValueOnce(appDb).mockReturnValueOnce(tenantDb);

    const { runEstimateGeneration } = await import("../../src/jobs/estimate-generation.js");
    await runEstimateGeneration(
      { documentId: "doc-1", dealId: "deal-1", parseRunId: "parse-run-1" },
      "office-1"
    );

    return {
      lockedClient,
      pricedQuantities: buildPricingRecommendationMock.mock.calls.map(([input]: any) => input.quantity),
      markedProcessed: statusWrites.some((write) => write?.status === "processed"),
      // The recommendation row is the one persistence payload carrying a source row identity.
      recommendationInserts: insertPayloads.filter(
        (payload) => payload && typeof payload === "object" && "sourceRowIdentity" in payload
      ),
    };
  }

  it("does NOT persist a recommendation for a quantity CHANGED to another positive value since the snapshot", async () => {
    // THE HOLE A RE-VALIDATING GUARD LEAVES. Re-asking "is the live quantity priceable?" only catches
    // the estimator who CLEARED it. The edit that actually happens is a correction: 10 SF re-measured
    // as 40 SF is positive at both ends, so the check passed, the row was marked `processed` — leaving
    // the pending queue — and it now reads 40 SF beside a price computed from 10. A quarter of the
    // cost, and nothing on the row says so.
    const result = await runWithLiveQuantity("40");

    // Matched and priced from the stale 10; that work is wasted, not wrong.
    expect(result.pricedQuantities).toEqual([10]);
    // What must not survive is the write. The next run re-reads the row and prices the 40.
    expect(result.recommendationInserts).toHaveLength(0);
    expect(result.markedProcessed).toBe(false);
    expect(result.lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("STILL persists when nobody touched the quantity, even at a different numeric scale", async () => {
    // THE OTHER DIRECTION, and the reason the comparison is numeric rather than a string equality.
    // `quantity` is `numeric`, and Postgres hands back the scale it was stored at — the same 10 arrives
    // as "10" or "10.00" depending on how it was written. A guard that called that an edit would refuse
    // every row it was asked about and take the whole feature down while the drift test above still
    // passed.
    const result = await runWithLiveQuantity("10.00");

    expect(result.pricedQuantities).toEqual([10]);
    expect(result.recommendationInserts).toHaveLength(1);
    expect(result.markedProcessed).toBe(true);
    expect(result.lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("REFUSES to price a row with no quantity, and marks it needs_quantity instead of billing one unit", async () => {
    // THE DEFECT. `Number(extraction.quantity ?? 1)` stood at three sites — the recommendation and both
    // persist branches — and turned "nobody said how much" into "one of them". One unit of anything has
    // a price, so the row emerged carrying a number no evidence supports, indistinguishable in the
    // totals from a quantity somebody actually stated.
    //
    // BOTH INPUTS ARE COVERED because the coercion sites are shared. `ext-ocr-null` is an OCR-parsed row,
    // which could always reach the default; `ext-walk-null` is a walkthrough row, which the ingress
    // refuses at the door today and will stop refusing once null quantities are accepted. Testing only
    // the walkthrough path would leave the parsed path silently inheriting this change.
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionRows = [
      {
        id: "ext-priced",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        quantity: "700",
        unit: "SF",
        normalizedLabel: "Install laminate flooring",
        metadataJson: { sourceParseRunId: "parse-run-1", activeArtifact: true },
      },
      {
        id: "ext-ocr-null",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        quantity: null,
        unit: null,
        normalizedLabel: "Paint one wall",
        metadataJson: { sourceParseRunId: "parse-run-1", activeArtifact: true },
      },
      {
        id: "ext-walk-null",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        quantity: null,
        unit: null,
        normalizedLabel: "Paint wall red",
        metadataJson: {
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
          sourceType: "walkthrough",
        },
      },
    ];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: sourceLimit })) })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const statusUpdates: unknown[] = [];
    const reviewEvents: any[] = [];
    // The claim matches by default; a test flips this to [] to make the row already-claimed.
    let claimedRows: Array<{ id: string }> = [{ id: "claimed" }];
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;
          if (tenantSelectCallCount === 1) {
            return { where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) };
          }
          if (tenantSelectCallCount === 2) return { where: extractionWhere };
          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: any) => {
          if (values?.eventType) reviewEvents.push(values);
          return { returning: vi.fn().mockResolvedValue([{ id: "generated-id" }]) };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: unknown) => {
          statusUpdates.push(values);
          // Serves both callers: the `unmatched` path awaits `where(...)` directly, the needs_quantity
          // claim calls `.returning()` on it. `claimedRows` lets a test make the claim lose.
          return {
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue(claimedRows),
            })),
          };
        }),
      })),
    } as any;

    getHistoricalPricingSignalsMock.mockResolvedValue({
      historicalItems: [],
      vendorQuotes: [],
      currentDeal: null,
    });
    resolveActiveCatalogSnapshotVersionIdMock.mockResolvedValue("snapshot-1");
    listCatalogCandidatesForMatchingMock.mockResolvedValue([]);
    rankExtractionMatchesMock.mockImplementation(async ({ extraction }: any) => [
      {
        catalogItemId: `catalog-${extraction.id}`,
        matchScore: 99,
        reasons: { matched: extraction.id },
        historicalLineItemIds: [],
        catalogBaselinePrice: 100,
        historicalUnitPrices: [],
        vendorQuotePrice: null,
        awardedOutcomeAdjustmentPercent: 0,
        internalAdjustmentPercent: 0,
      },
    ]);
    buildPricingRecommendationMock.mockImplementation(() => ({
      quantity: 700,
      priceBasis: "mock",
      recommendedUnitPrice: 10,
      recommendedTotalPrice: 7000,
      comparableHistoricalPrices: [],
      historicalMedianPrice: null,
      catalogBaselinePrice: null,
      marketAdjustmentPercent: 0,
      assumptions: {},
      confidence: 1,
    }));
    poolConnectMock.mockResolvedValue(lockedClient);
    drizzleMock.mockReturnValueOnce(appDb).mockReturnValueOnce(tenantDb);

    const { runEstimateGeneration } = await import("../../src/jobs/estimate-generation.js");

    await runEstimateGeneration(
      { documentId: "doc-1", dealId: "deal-1", parseRunId: "parse-run-1" },
      "office-1"
    );

    // Skipped BEFORE matching: the answer could not be used, so the work is not done.
    const rankedExtractionIds = rankExtractionMatchesMock.mock.calls.map(
      ([input]: any) => input.extraction.id
    );
    expect(rankedExtractionIds).toEqual(["ext-priced"]);

    // Priced exactly once, and never with the invented 1.
    expect(buildPricingRecommendationMock).toHaveBeenCalledTimes(1);
    const pricedQuantities = buildPricingRecommendationMock.mock.calls.map(([input]: any) => input.quantity);
    expect(pricedQuantities).toEqual([700]);
    expect(pricedQuantities).not.toContain(1);

    // Both unpriceable rows are flagged rather than dropped — somebody has to put a number on them.
    expect(statusUpdates).toContainEqual({ status: "needs_quantity" });
    expect(statusUpdates.filter((u: any) => u.status === "needs_quantity")).toHaveLength(2);

    // WHICH rows, not merely how many. A count alone passes if the same row is flagged twice and the
    // other is missed entirely, which is precisely the confusion this branch could produce.
    const flagged = reviewEvents
      .filter((event) => event.eventType === "needs_quantity")
      .map((event) => event.subjectId)
      .sort();
    expect(flagged).toEqual(["ext-ocr-null", "ext-walk-null"]);

    // A SECOND RUN OVER THE SAME STATE RECORDS NOTHING FURTHER. A measurement candidate is re-selected
    // regardless of status, so without both the read guard and the conditional claim, one unmeasured row
    // would emit a fresh event on every generation run for as long as it lacked a number. Here the claim
    // is made to lose — which is what a row someone else already flagged looks like.
    claimedRows = [];
    const eventsAfterFirstRun = reviewEvents.length;
    tenantSelectCallCount = 0;
    drizzleMock.mockReturnValueOnce(appDb).mockReturnValueOnce(tenantDb);
    poolConnectMock.mockResolvedValue({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any);

    await runEstimateGeneration(
      { documentId: "doc-1", dealId: "deal-1", parseRunId: "parse-run-1" },
      "office-1"
    );

    expect(reviewEvents).toHaveLength(eventsAfterFirstRun);
    expect(lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("assigns distinct source row identities to inferred rows that share section and normalized intent", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionRows = [
      {
        id: "ext-inferred-1",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        quantity: "1",
        unit: "ea",
        normalizedLabel: "Companion flashing",
        evidenceText: "Companion flashing implied by spec",
        divisionHint: "Roofing",
        metadataJson: {
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
          sourceType: "inferred",
          dependencySupportCount: 1,
        },
      },
      {
        id: "ext-inferred-2",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        quantity: "1",
        unit: "ea",
        normalizedLabel: "Companion flashing",
        evidenceText: "Companion flashing implied by spec",
        divisionHint: "Roofing",
        metadataJson: {
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
          sourceType: "inferred",
          dependencySupportCount: 1,
        },
      },
    ];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const insertPayloads: any[] = [];
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;
          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }
          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((payload: any) => {
          insertPayloads.push(payload);
          return {
            returning: vi.fn().mockResolvedValue([{ id: `row-${insertPayloads.length}` }]),
          };
        }),
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
    resolveActiveCatalogSnapshotVersionIdMock.mockResolvedValue("snapshot-1");
    listCatalogCandidatesForMatchingMock.mockResolvedValue([]);
    rankExtractionMatchesMock.mockImplementation(async ({ extraction }: any) => [
      {
        catalogItemId: `catalog-${extraction.id}`,
        matchScore: 99,
        reasons: { matched: extraction.id },
        historicalLineItemIds: [],
        catalogBaselinePrice: 100,
        historicalUnitPrices: [],
        vendorQuotePrice: null,
        awardedOutcomeAdjustmentPercent: 0,
        internalAdjustmentPercent: 0,
      },
    ]);
    buildPricingRecommendationMock.mockImplementation(() => ({
      quantity: 1,
      priceBasis: "mock",
      recommendedUnitPrice: 10,
      recommendedTotalPrice: 10,
      comparableHistoricalPrices: [],
      historicalMedianPrice: null,
      catalogBaselinePrice: null,
      marketAdjustmentPercent: 0,
      assumptions: {},
      confidence: 1,
    }));
    poolConnectMock.mockResolvedValue(lockedClient);
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

    const recommendationPayloads = insertPayloads.filter(
      (payload) => payload && typeof payload === "object" && !Array.isArray(payload) && "sourceRowIdentity" in payload
    );
    const sourceRowIdentities = recommendationPayloads.map((payload: any) => payload.sourceRowIdentity);

    expect(recommendationPayloads).toHaveLength(2);
    expect(new Set(sourceRowIdentities).size).toBe(2);
    expect(sourceRowIdentities[0]).toContain("ext-inferred-1");
    expect(sourceRowIdentities[1]).toContain("ext-inferred-2");
    expect(lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("derives and filters by the active parse run when payload.parseRunId is missing", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([]);
    const extractionRows: Array<{ id: string; quantity: unknown }> = [];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-active" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;
          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }
          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
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
    poolConnectMock.mockResolvedValue(lockedClient);
    drizzleMock.mockReturnValueOnce(appDb).mockReturnValueOnce(tenantDb);

    const { runEstimateGeneration } = await import("../../src/jobs/estimate-generation.js");

    await runEstimateGeneration(
      {
        documentId: "doc-1",
        dealId: "deal-1",
      },
      "office-1"
    );

    expect(String(lockedClient.query.mock.calls[3]?.[0])).toContain("FOR UPDATE");
    const extractionFilterSql = readSqlText(extractionWhere.mock.calls[0]?.[0]);
    expect(extractionFilterSql).toContain("sourceParseRunId");
    expect(extractionFilterSql).toContain("activeArtifact");
    expect(extractionFilterSql).toContain("estimate_source_documents as document");
    expect(extractionFilterSql).toContain("active_parse_run_id");
  });

  it("marks the persisted generation run failed when locked generation work throws", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([]);
    const extractionRows: Array<{ id: string; quantity: unknown }> = [];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    const generationRunWhere = vi.fn().mockResolvedValue(undefined);
    const generationRunSet = vi.fn(() => ({
      where: generationRunWhere,
    }));
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;

          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }

          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }

          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
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
        set: generationRunSet,
      })),
    } as any;

    getHistoricalPricingSignalsMock.mockRejectedValue(new Error("pricing history blew up"));
    poolConnectMock.mockResolvedValue(lockedClient);
    drizzleMock.mockReturnValueOnce(appDb).mockReturnValueOnce(tenantDb);

    const { runEstimateGeneration } = await import("../../src/jobs/estimate-generation.js");

    await expect(
      runEstimateGeneration(
        {
          documentId: "doc-1",
          dealId: "deal-1",
          parseRunId: "parse-run-1",
        },
        "office-1"
      )
    ).rejects.toThrow("pricing history blew up");

    expect(tenantDb.insert).toHaveBeenCalledTimes(1);
    expect(lockedClient.query).toHaveBeenCalledWith("ROLLBACK");
    expect(String(lockedClient.query.mock.calls[5]?.[0])).toContain("SET search_path TO office_estimating, public");
    expect(generationRunSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorSummary: "pricing history blew up",
      })
    );
    expect(generationRunWhere).toHaveBeenCalled();
    expect(lockedClient.release).toHaveBeenCalledTimes(1);
  });

  it("clones manual rows from the latest completed generation run before processing a rerun", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionRows: Array<{ id: string; quantity: unknown }> = [];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;

          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue([{ id: "run-prev" }]),
                })),
              })),
            };
          }

          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }

          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
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
    poolConnectMock.mockResolvedValue(lockedClient);
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

    expect(cloneManualRowsForGenerationRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        sourceGenerationRunId: "run-prev",
        targetGenerationRunId: "generation-run-1",
      })
    );
  });

  it("passes deal and property geography into market resolution and persists rerun request ids", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionRows = [
      {
        id: "ext-1",
        dealId: "deal-1",
        projectId: "project-1",
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        quantity: "2",
        unit: "ea",
        normalizedLabel: "Generic line item",
        divisionHint: null,
        metadataJson: {
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
          pricingScopeType: "trade",
          pricingScopeKey: "roofing",
        },
      },
    ];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    const insertPayloads: any[] = [];
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;
          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }
          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
        }),
      })),
      insert: vi.fn((table: any) => ({
        values: vi.fn((payload: any) => {
          insertPayloads.push({ table, payload });
          const id = payload.matchType ? "match-1" : payload.dealId ? "recommendation-1" : "option-1";
          return {
            returning: vi.fn().mockResolvedValue([{ id }]),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((payload: any) => ({
          where: vi.fn(async () => {
            insertPayloads.push({ table: "update", payload });
          }),
        })),
      })),
    } as any;

    getHistoricalPricingSignalsMock.mockResolvedValue({
      historicalItems: [],
      vendorQuotes: [],
      currentDeal: {
        id: "deal-1",
        projectTypeId: "roofing",
        dealRegionId: "region-1",
        dealZip: null,
        dealState: null,
        propertyId: "property-1",
        propertyZip: "76102",
        propertyState: "TX",
      },
    });
    resolveMarketContextMock.mockResolvedValue({
      market: {
        id: "market-override",
        name: "Override Market",
        slug: "override",
        type: "state",
        stateCode: "TX",
        regionId: null,
        isActive: true,
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      resolutionLevel: "zip",
      resolutionSource: { type: "zip", key: "76102", marketId: "market-override" },
      location: { zip: "76102", state: "TX", regionId: "region-1" },
    });
    calculateMarketRateAdjustmentMock.mockResolvedValue({
      market: {
        id: "market-override",
        name: "Override Market",
        slug: "override",
        type: "state",
        stateCode: "TX",
        regionId: null,
        isActive: true,
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      resolutionLevel: "zip",
      resolutionSource: { type: "zip", key: "76102", marketId: "market-override" },
      baselinePrice: 10,
      selectedRule: { id: "rule-override" },
      componentAdjustments: [
        {
          component: "labor",
          weight: 0.5,
          baselineAmount: 5,
          adjustmentPercent: 20,
          adjustmentAmount: 1,
          adjustedAmount: 6,
        },
        {
          component: "material",
          weight: 0.3,
          baselineAmount: 3,
          adjustmentPercent: 0,
          adjustmentAmount: 0,
          adjustedAmount: 3,
        },
        {
          component: "equipment",
          weight: 0.2,
          baselineAmount: 2,
          adjustmentPercent: 0,
          adjustmentAmount: 0,
          adjustedAmount: 2,
        },
      ],
      adjustedPrice: 132,
      rationale: {
        resolvedMarket: {
          id: "market-override",
          name: "Override Market",
          slug: "override",
          type: "state",
          stateCode: "TX",
          regionId: null,
          isActive: true,
          createdAt: new Date("2026-04-21T00:00:00Z"),
          updatedAt: new Date("2026-04-21T00:00:00Z"),
        },
        resolutionLevel: "zip",
        resolutionSource: { type: "zip", key: "76102", marketId: "market-override" },
        baselinePrice: 10,
        selectedRuleId: "rule-override",
        componentAdjustments: [
          {
            component: "labor",
            weight: 0.5,
            baselineAmount: 5,
            adjustmentPercent: 20,
            adjustmentAmount: 1,
            adjustedAmount: 6,
          },
          {
            component: "material",
            weight: 0.3,
            baselineAmount: 3,
            adjustmentPercent: 0,
            adjustmentAmount: 0,
            adjustedAmount: 3,
          },
          {
            component: "equipment",
            weight: 0.2,
            baselineAmount: 2,
            adjustmentPercent: 0,
            adjustmentAmount: 0,
            adjustedAmount: 2,
          },
        ],
      },
    });
    applyMarketRateAdjustmentMock.mockImplementation(({ recommendation, marketRateAdjustment }: any) => ({
      ...recommendation,
      recommendedUnitPrice:
        recommendation.quantity > 0 ? marketRateAdjustment.adjustedPrice / recommendation.quantity : 0,
      recommendedTotalPrice: recommendation.quantity > 0 ? marketRateAdjustment.adjustedPrice : 0,
      marketAdjustmentPercent: 32,
      marketRateContext: {
        resolvedMarket: marketRateAdjustment.market,
        resolutionLevel: marketRateAdjustment.resolutionLevel,
        resolutionSource: marketRateAdjustment.resolutionSource,
      },
      marketRateRationale: marketRateAdjustment.rationale,
    }));

    poolConnectMock.mockResolvedValue(lockedClient);
    drizzleMock.mockReturnValueOnce(appDb).mockReturnValueOnce(tenantDb);

    const { runEstimateGeneration } = await import("../../src/jobs/estimate-generation.js");

    await runEstimateGeneration(
      {
        documentId: "doc-1",
        dealId: "deal-1",
        parseRunId: "parse-run-1",
        rerunRequestId: "rerun-123",
      },
      "office-1"
    );

    expect(resolveMarketContextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dealId: "deal-1",
        dealZip: null,
        dealState: null,
        dealRegionId: "region-1",
        propertyZip: "76102",
        propertyState: "TX",
      })
    );
    expect(calculateMarketRateAdjustmentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pricingScopeType: "trade",
        pricingScopeKey: "roofing",
        baselinePrice: 10,
      })
    );

    const generationRunInsert = insertPayloads.find(({ payload }) => payload?.inputSnapshotJson)?.payload;
    const recommendationInsert = insertPayloads.find(
      ({ payload }) => payload && typeof payload === "object" && "recommendedUnitPrice" in payload
    )?.payload;

    expect(generationRunInsert.inputSnapshotJson.rerunRequestId).toBe("rerun-123");
    expect(recommendationInsert.recommendedUnitPrice).toBe("66.00");
    expect(recommendationInsert.recommendedTotalPrice).toBe("132.00");
    expect(recommendationInsert.assumptionsJson.marketRate.resolutionSource.key).toBe("76102");
    expect(recommendationInsert.evidenceJson.marketRate.resolvedMarket.slug).toBe("override");
    expect(lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("falls back to trade scope from legacy extraction text when pricing-scope metadata is absent", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionRows = [
      {
        id: "ext-legacy",
        dealId: "deal-1",
        projectId: null,
        documentId: "doc-1",
        extractionType: "scope_line",
        status: "pending",
        quantity: "2",
        unit: "ea",
        normalizedLabel: "Roofing tearoff",
        divisionHint: null,
        metadataJson: {
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
        },
      },
    ];
    const extractionWhere = vi.fn().mockResolvedValue(extractionRows);
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: sourceLimit,
          })),
        })),
      })),
    } as any;
    const lockedClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "doc-1", active_parse_run_id: "parse-run-1" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    } as any;
    let tenantSelectCallCount = 0;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          tenantSelectCallCount += 1;
          if (tenantSelectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (tenantSelectCallCount === 2) {
            return {
              where: extractionWhere,
            };
          }
          // Every later select is `stillPriceable`, the re-read the persist path does under the row
          // lock to confirm the quantity is still the one it priced. Answered from the snapshot itself,
          // so these tests exercise the pricing they are about; the drift paths have their own tests.
          return unchangedQuantityRead(extractionRows);
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "generated-id" }]),
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
    resolveActiveCatalogSnapshotVersionIdMock.mockResolvedValue("snapshot-1");
    listCatalogCandidatesForMatchingMock.mockResolvedValue([]);
    rankExtractionMatchesMock.mockImplementation(async ({ extraction }: any) => [
      {
        catalogItemId: `catalog-${extraction.id}`,
        matchScore: 99,
        reasons: { matched: extraction.id },
        historicalLineItemIds: [],
        catalogBaselinePrice: 100,
        historicalUnitPrices: [],
        vendorQuotePrice: null,
        awardedOutcomeAdjustmentPercent: 0,
        internalAdjustmentPercent: 0,
      },
    ]);
    buildPricingRecommendationMock.mockImplementation(() => ({
      quantity: 2,
      priceBasis: "mock",
      recommendedUnitPrice: 10,
      recommendedTotalPrice: 20,
      comparableHistoricalPrices: [],
      historicalMedianPrice: null,
      catalogBaselinePrice: null,
      marketAdjustmentPercent: 0,
      assumptions: {},
      confidence: 1,
    }));
    poolConnectMock.mockResolvedValue(lockedClient);
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

    expect(calculateMarketRateAdjustmentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pricingScopeType: "trade",
        pricingScopeKey: "roofing",
      })
    );
    expect(lockedClient.query).toHaveBeenLastCalledWith("COMMIT");
  });
});
