import { beforeEach, describe, expect, it, vi } from "vitest";

const drizzleMock = vi.fn();
const poolQueryMock = vi.fn();
const poolConnectMock = vi.fn();
const getHistoricalPricingSignalsMock = vi.fn();
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

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: drizzleMock,
}));

vi.mock("../../src/db.js", () => ({
  pool: {
    query: poolQueryMock,
    connect: poolConnectMock,
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
  isInferredRecommendationRowEligible: isInferredRecommendationRowEligibleMock,
  isConfirmedMeasurementCandidateForPricing: isConfirmedMeasurementCandidateForPricingMock,
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
    const extractionWhere = vi.fn().mockResolvedValue([
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
    ]);
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
              where: extractionWhere,
            };
          }
          throw new Error(`Unexpected tenant select call: ${tenantSelectCallCount}`);
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

  it("assigns distinct source row identities to inferred rows that share section and normalized intent", async () => {
    const sourceLimit = vi.fn().mockResolvedValue([{ id: "source-1" }]);
    const extractionWhere = vi.fn().mockResolvedValue([
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
    ]);
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
              where: extractionWhere,
            };
          }
          throw new Error(`Unexpected tenant select call: ${tenantSelectCallCount}`);
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
});
