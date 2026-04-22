import { beforeEach, describe, expect, it, vi } from "vitest";

const dealsServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
  getDeals: vi.fn(),
  getDealDetail: vi.fn(),
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  deleteDeal: vi.fn(),
  getDealsForPipeline: vi.fn(),
  getDealSources: vi.fn(),
}));

vi.mock("../../../src/modules/deals/service.js", () => dealsServiceMocks);

const estimatingServiceMocks = vi.hoisted(() => ({
  buildEstimatingCopilotContext: vi.fn(),
  answerEstimatingCopilotQuestion: vi.fn(),
  getEstimatingWorkflowState: vi.fn(),
  listEstimateReviewEvents: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/copilot-service.js", () => estimatingServiceMocks);

const extractionReviewServiceMocks = vi.hoisted(() => ({
  updateEstimateExtraction: vi.fn(),
  approveEstimateExtraction: vi.fn(),
  rejectEstimateExtraction: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/extraction-review-service.js", () => extractionReviewServiceMocks);

const matchReviewServiceMocks = vi.hoisted(() => ({
  selectEstimateExtractionMatch: vi.fn(),
  rejectEstimateExtractionMatch: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/match-review-service.js", () => matchReviewServiceMocks);

const pricingReviewServiceMocks = vi.hoisted(() => ({
  approveEstimatePricingRecommendation: vi.fn(),
  rejectEstimatePricingRecommendation: vi.fn(),
  overrideEstimatePricingRecommendation: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/pricing-review-service.js", () => pricingReviewServiceMocks);

const draftEstimateServiceMocks = vi.hoisted(() => ({
  approveEstimateRecommendation: vi.fn(),
  listApprovedRecommendationIdsForRun: vi.fn(),
  promoteApprovedRecommendationsToEstimate: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/draft-estimate-service.js", () => draftEstimateServiceMocks);

const estimatingWorkbenchServiceMocks = vi.hoisted(() => ({
  updateEstimatePricingRecommendationReviewState: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/workbench-service.js", () => estimatingWorkbenchServiceMocks);

const dealMarketOverrideServiceMocks = vi.hoisted(() => ({
  getDealEffectiveMarketContext: vi.fn(),
  listEstimateMarkets: vi.fn(),
  setDealMarketOverride: vi.fn(),
  clearDealMarketOverride: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/deal-market-override-service.js", () => ({
  getDealEffectiveMarketContext: dealMarketOverrideServiceMocks.getDealEffectiveMarketContext,
  listEstimateMarkets: dealMarketOverrideServiceMocks.listEstimateMarkets,
  setDealMarketOverride: dealMarketOverrideServiceMocks.setDealMarketOverride,
  clearDealMarketOverride: dealMarketOverrideServiceMocks.clearDealMarketOverride,
}));

const marketRateProviderMocks = vi.hoisted(() => ({
  createMarketRateProvider: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/market-rate-provider.js", () => marketRateProviderMocks);

const marketResolutionServiceMocks = vi.hoisted(() => ({
  resolveMarketContext: vi.fn(),
  resolveDealMarketLocation: vi.fn((input: any) => ({
    zip: input.dealZip ?? input.propertyZip ?? null,
    state: input.dealState ?? input.propertyState ?? null,
    regionId: input.dealRegionId ?? input.propertyRegionId ?? null,
  })),
}));

vi.mock("../../../src/modules/estimating/market-resolution-service.js", () => marketResolutionServiceMocks);

const manualRowServiceMocks = vi.hoisted(() => ({
  createManualEstimateRow: vi.fn(),
  updateManualEstimateRow: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/manual-row-service.js", () => manualRowServiceMocks);

const localCatalogServiceMocks = vi.hoisted(() => ({
  promoteManualRowToLocalCatalog: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/local-catalog-service.js", () => localCatalogServiceMocks);

const documentServiceMocks = vi.hoisted(() => ({
  createEstimateSourceDocument: vi.fn(),
  enqueueEstimateDocumentOcrJob: vi.fn(),
  reprocessEstimateSourceDocument: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/document-service.js", () => documentServiceMocks);

const fileServiceMocks = vi.hoisted(() => ({
  confirmUpload: vi.fn(),
  getFileById: vi.fn(),
}));

vi.mock("../../../src/modules/files/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/files/service.js")>(
    "../../../src/modules/files/service.js"
  );

  return {
    ...actual,
    confirmUpload: fileServiceMocks.confirmUpload,
    getFileById: fileServiceMocks.getFileById,
  };
});

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

function findRouteHandler(method: "get" | "post" | "patch" | "put" | "delete", path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  return routeLayer.handle;
}

async function invokeRoute(
  method: "get" | "post" | "patch" | "put" | "delete",
  path: string,
  options?: { params?: Record<string, string>; body?: any; query?: Record<string, any> }
) {
  const handler = findRouteHandler(method, path);
  const req = {
    params: options?.params ?? {},
    body: options?.body ?? {},
    query: options?.query ?? {},
    tenantDb: {},
    appDb: {},
    officeSlug: "office-a",
    user: {
      id: "user-1",
      role: "director",
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    commitTransaction: vi.fn(async () => {}),
  } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as any;
  const next = vi.fn((err?: unknown) => {
    if (err) throw err;
  });

  await handler(req, res, next);
  return { req, res };
}

function createMarketOverrideTenantDb() {
  const insertCalls: Array<{ table: any; payload: any }> = [];
  const marketRow = {
    id: "market-1",
    name: "Default Market",
    slug: "default",
    type: "global",
    stateCode: null,
    regionId: null,
    isActive: true,
    createdAt: new Date("2026-04-21T00:00:00Z"),
    updatedAt: new Date("2026-04-21T00:00:00Z"),
  };
  const dealRow = {
    id: "deal-1",
    dealZip: "76102",
    dealState: "TX",
    dealRegionId: null,
    propertyId: null,
  };
  let overrideRow: any = null;
  const tableLabel = (table: any) =>
    table?.[Symbol.for("drizzle:Name")] ?? table?.tableName ?? table?.name ?? "";
  const isDealsTable = (table: any) => tableLabel(table) === "deals";
  const isOverrideTable = (table: any) =>
    tableLabel(table) === "estimate_deal_market_overrides" ||
    tableLabel(table).endsWith(".estimate_deal_market_overrides");
  const isMarketsTable = (table: any) =>
    tableLabel(table) === "estimate_markets" || tableLabel(table).endsWith(".estimate_markets");

  const selectRows = (table: any) => {
    if (isDealsTable(table)) return [dealRow];
    if (isOverrideTable(table)) {
      return overrideRow
        ? [
            {
              id: "override-1",
              marketId: overrideRow.marketId,
              overriddenByUserId: overrideRow.overriddenByUserId,
              overrideReason: overrideRow.overrideReason,
              createdAt: overrideRow.createdAt,
              updatedAt: overrideRow.updatedAt,
              marketName: marketRow.name,
              marketSlug: marketRow.slug,
            },
        ]
        : [];
    }
    if (isMarketsTable(table)) return [marketRow];
    return [];
  };

  const tenantDb = {
    select: vi.fn(() => {
      let selectedTable: any = null;
      const chain: any = {
        from(table: any) {
          selectedTable = table;
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          return Promise.resolve(selectRows(selectedTable));
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(selectRows(selectedTable)).then(resolve, reject);
        },
      };
      return chain;
    }),
    insert: vi.fn((table: any) => ({
      values: vi.fn((payload: any) => {
        insertCalls.push({ table, payload });
        if (isOverrideTable(table)) {
          overrideRow = payload;
          (tenantDb as any).__overrideRow = overrideRow;
        }
        const chain: any = {
          onConflictDoUpdate() {
            if (isOverrideTable(table)) {
              overrideRow = payload;
              (tenantDb as any).__overrideRow = overrideRow;
            }
            return chain;
          },
          returning: vi.fn(async () => [payload]),
        };
        return chain;
      }),
    })),
    delete: vi.fn((table: any) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          if (!isOverrideTable(table)) return [];
          const deleted = overrideRow ? [{ ...overrideRow }] : [];
          overrideRow = null;
          (tenantDb as any).__overrideRow = overrideRow;
          return deleted;
        }),
      })),
    })),
  } as any;
  tenantDb.__overrideRow = overrideRow;

  return { tenantDb, insertCalls, marketRow };
}

function installMarketContextMocksForOverrideFlow() {
  marketRateProviderMocks.createMarketRateProvider.mockImplementation((tenantDb: any) => ({ tenantDb }));
  marketResolutionServiceMocks.resolveMarketContext.mockImplementation(async (provider: any, input: any) => {
    const overrideRow = provider?.tenantDb?.__overrideRow ?? null;
    const location = {
      zip: input.dealZip ?? input.propertyZip ?? null,
      state: input.dealState ?? input.propertyState ?? null,
      regionId: input.dealRegionId ?? input.propertyRegionId ?? null,
    };

    if (overrideRow) {
      return {
        market: {
          id: overrideRow.marketId,
          name: "Override Market",
          slug: "override-market",
          type: "state",
          stateCode: "TX",
          regionId: null,
          isActive: true,
          createdAt: new Date("2026-04-21T00:00:00Z"),
          updatedAt: new Date("2026-04-21T00:00:00Z"),
        },
        resolutionLevel: "override",
        resolutionSource: {
          type: "override",
          key: input.dealId,
          marketId: overrideRow.marketId,
        },
        location,
      };
    }

    return {
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
      resolutionSource: {
        type: "global",
        key: "default",
        marketId: "market-1",
      },
      location,
    };
  });
}

describe("estimating workflow routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    marketRateProviderMocks.createMarketRateProvider.mockReturnValue({});
    marketResolutionServiceMocks.resolveMarketContext.mockResolvedValue({
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
      resolutionSource: {
        type: "global",
        key: "default",
        marketId: "market-1",
      },
      location: {
        zip: null,
        state: null,
        regionId: null,
      },
    });
    dealsServiceMocks.getDealById.mockResolvedValue({ id: "deal-1" });
    dealMarketOverrideServiceMocks.getDealEffectiveMarketContext.mockResolvedValue({
      effectiveMarket: {
        id: "market-1",
        name: "Default Market",
        slug: "default",
        type: "global",
      },
      resolutionLevel: "global_default",
      resolutionSource: {
        type: "global",
        key: "default",
        marketId: "market-1",
      },
      location: {
        zip: null,
        state: null,
        regionId: null,
      },
      override: null,
    });
    dealMarketOverrideServiceMocks.listEstimateMarkets.mockResolvedValue([]);
    dealMarketOverrideServiceMocks.setDealMarketOverride.mockResolvedValue({
      rerunRequestId: "rerun-default-set",
      effectiveMarket: {
        id: "market-override",
        name: "Override Market",
        slug: "override-market",
        type: "state",
      },
      reviewEvent: { id: "evt-set", eventType: "market_override_set" },
    });
    dealMarketOverrideServiceMocks.clearDealMarketOverride.mockResolvedValue({
      rerunRequestId: "rerun-default-clear",
      effectiveMarket: {
        id: "market-1",
        name: "Default Market",
        slug: "default",
        type: "global",
      },
      reviewEvent: { id: "evt-clear", eventType: "market_override_cleared" },
    });
    fileServiceMocks.confirmUpload.mockResolvedValue({
      id: "file-1",
      dealId: "deal-1",
      parentFileId: null,
      originalFilename: "plans.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1024,
      r2Key: "r2/doc-1.pdf",
    });
    fileServiceMocks.getFileById.mockResolvedValue({
      id: "file-2",
      dealId: "deal-1",
      parentFileId: null,
      originalFilename: "uploaded-plan.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 2048,
      r2Key: "r2/doc-2.pdf",
    });
  });

  it("returns workflow state for the estimating shell", async () => {
    estimatingServiceMocks.getEstimatingWorkflowState.mockResolvedValue({
      documents: [
        {
          id: "doc-1",
          parseStatus: "completed",
          parseProvider: "default",
          parseProfile: "measurement-heavy",
          parseMeasurementsEnabled: true,
          ocrStatus: "completed",
        },
      ],
      extractionRows: [
        {
          id: "ext-1",
          metadataJson: {
            measurementConfirmationState: "pending",
          },
        },
      ],
      matchRows: [],
      pricingRows: [],
      reviewEvents: [],
      summary: {
        documents: {
          total: 0,
          queued: 0,
          failed: 0,
        },
        extractions: {
          total: 0,
          pending: 0,
          approved: 0,
          rejected: 0,
          unmatched: 0,
        },
        matches: {
          total: 0,
          suggested: 0,
          selected: 0,
          rejected: 0,
        },
        pricing: {
          total: 2,
          pending: 0,
          approved: 1,
          overridden: 1,
          rejected: 0,
          readyToPromote: 2,
        },
      },
      promotionReadiness: {
        canPromote: false,
        generationRunIds: [],
      },
      marketContext: {
        effectiveMarket: {
          id: "market-1",
          name: "Texas Market",
          slug: "tx-market",
          type: "state",
        },
        resolutionLevel: "state",
        resolutionSource: {
          type: "state",
          key: "TX",
          marketId: "market-1",
        },
        location: {
          zip: "76102",
          state: "TX",
          regionId: "region-1",
        },
        isOverridden: false,
        override: null,
        fallbackSource: {
          type: "state",
          key: "TX",
          marketId: "market-1",
        },
      },
      rerunStatus: {
        status: "queued",
        rerunRequestId: "rerun-1",
        queueJobId: 71,
        generationRunId: null,
        source: "job_queue",
        errorSummary: null,
      },
      activePricingRunId: "run-completed",
      manualAddContext: {
        generationRunId: "run-completed",
        extractionMatchId: null,
        estimateSectionName: "Roofing",
      },
    });

    const { res } = await invokeRoute("get", "/:id/estimating", {
      params: { id: "deal-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(estimatingServiceMocks.getEstimatingWorkflowState).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({
        appDb: expect.anything(),
        officeId: "office-1",
      })
    );
    expect(res.body.summary).toEqual({
      documents: {
        total: 0,
        queued: 0,
        failed: 0,
      },
      extractions: {
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
        unmatched: 0,
      },
      matches: {
        total: 0,
        suggested: 0,
        selected: 0,
        rejected: 0,
      },
      pricing: {
        total: 2,
        pending: 0,
        approved: 1,
        overridden: 1,
        rejected: 0,
        readyToPromote: 2,
      },
    });
    expect(res.body.promotionReadiness).toEqual({
      canPromote: false,
      generationRunIds: [],
    });
    expect(res.body.marketContext).toEqual(
      expect.objectContaining({
        effectiveMarket: expect.objectContaining({
          id: "market-1",
        }),
        resolutionLevel: "state",
        fallbackSource: expect.objectContaining({
          key: "TX",
        }),
      })
    );
    expect(res.body.rerunStatus).toEqual({
      status: "queued",
      rerunRequestId: "rerun-1",
      queueJobId: 71,
      generationRunId: null,
      source: "job_queue",
      errorSummary: null,
    });
    expect(res.body.activePricingRunId).toBe("run-completed");
    expect(res.body.manualAddContext).toEqual({
      generationRunId: "run-completed",
      extractionMatchId: null,
      estimateSectionName: "Roofing",
    });
    expect(res.body.documents[0]).toEqual(
      expect.objectContaining({
        parseStatus: "completed",
        parseProvider: "default",
        parseProfile: "measurement-heavy",
        parseMeasurementsEnabled: true,
      })
    );
    expect(res.body.extractionRows[0]).toEqual(
      expect.objectContaining({
        metadataJson: expect.objectContaining({
          measurementConfirmationState: "pending",
        }),
      })
    );
  });

  it("returns 404 when a reprocess target document is missing", async () => {
    documentServiceMocks.reprocessEstimateSourceDocument.mockResolvedValue(null);

    await expect(
      invokeRoute("post", "/:id/estimating/documents/:documentId/reprocess", {
        params: { id: "deal-1", documentId: "missing-doc" },
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(documentServiceMocks.reprocessEstimateSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          dealId: "deal-1",
          documentId: "missing-doc",
          userId: "user-1",
          officeId: "office-1",
          parseProvider: undefined,
          parseProfile: undefined,
          parseMeasurementsEnabled: undefined,
        }),
      })
    );
  });

  it("passes parse measurement options through document upload and reprocess routes", async () => {
    documentServiceMocks.createEstimateSourceDocument.mockResolvedValue({
      id: "doc-1",
    });
    documentServiceMocks.reprocessEstimateSourceDocument.mockResolvedValue({
      id: "doc-1",
    });

    await invokeRoute("post", "/:id/estimating/documents", {
      params: { id: "deal-1" },
      body: {
        uploadToken: "upload-1",
        parseMeasurementsEnabled: true,
      },
    });

    await invokeRoute("post", "/:id/estimating/documents/:documentId/reprocess", {
      params: { id: "deal-1", documentId: "doc-1" },
      body: {
        parseProvider: "default",
        parseProfile: "measurement-heavy",
        parseMeasurementsEnabled: false,
      },
    });

    expect(documentServiceMocks.createEstimateSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          parseMeasurementsEnabled: true,
        }),
      })
    );
    expect(documentServiceMocks.reprocessEstimateSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          parseProvider: "default",
          parseProfile: "measurement-heavy",
          parseMeasurementsEnabled: false,
        }),
      })
    );
  });

  it("accepts a pre-uploaded deal file when creating an estimate source document", async () => {
    documentServiceMocks.createEstimateSourceDocument.mockResolvedValue({
      id: "doc-2",
    });

    await invokeRoute("post", "/:id/estimating/documents", {
      params: { id: "deal-1" },
      body: {
        fileId: "file-2",
        parseMeasurementsEnabled: true,
      },
    });

    expect(fileServiceMocks.getFileById).toHaveBeenCalledWith({}, "file-2");
    expect(fileServiceMocks.confirmUpload).not.toHaveBeenCalled();
    expect(documentServiceMocks.createEstimateSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          dealId: "deal-1",
          fileId: "file-2",
          filename: "uploaded-plan.pdf",
          parseMeasurementsEnabled: true,
        }),
      })
    );
  });

  it("returns copilot answers using server-built context", async () => {
    estimatingServiceMocks.buildEstimatingCopilotContext.mockResolvedValue({ pricingRecommendation: { id: "rec-1" } });
    estimatingServiceMocks.answerEstimatingCopilotQuestion.mockResolvedValue({
      answer: "Recommended unit price: 121.54",
      evidence: [{ type: "pricing_recommendation", id: "rec-1" }],
    });

    const { res } = await invokeRoute("post", "/:id/estimating/copilot", {
      params: { id: "deal-1" },
      body: { question: "What should this line item price be?" },
    });

    expect(res.statusCode).toBe(200);
    expect(estimatingServiceMocks.buildEstimatingCopilotContext).toHaveBeenCalled();
    expect(estimatingServiceMocks.answerEstimatingCopilotQuestion).toHaveBeenCalled();
  });

  it("requires generationRunId before promotion", async () => {
    await expect(
      invokeRoute("post", "/:id/estimating/promote", {
        params: { id: "deal-1" },
        body: {},
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("updates an extraction row for the workbench", async () => {
    extractionReviewServiceMocks.updateEstimateExtraction.mockResolvedValue({
      extraction: { id: "ext-1", status: "pending", normalizedLabel: "Updated label" },
      reviewEvent: { id: "evt-1", eventType: "edited" },
    });

    const { res } = await invokeRoute("patch", "/:id/estimating/extractions/:extractionId", {
      params: { id: "deal-1", extractionId: "ext-1" },
      body: { normalizedLabel: "Updated label" },
    });

    expect(res.statusCode).toBe(200);
    expect(extractionReviewServiceMocks.updateEstimateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        extractionId: "ext-1",
        userId: "user-1",
        input: { normalizedLabel: "Updated label" },
      })
    );
    expect(res.body.extraction.normalizedLabel).toBe("Updated label");
  });

  it("approves an extraction row for the workbench", async () => {
    extractionReviewServiceMocks.approveEstimateExtraction.mockResolvedValue({
      extraction: { id: "ext-2", status: "approved" },
      reviewEvent: { id: "evt-2", eventType: "approved" },
    });

    const { res } = await invokeRoute("post", "/:id/estimating/extractions/:extractionId/approve", {
      params: { id: "deal-1", extractionId: "ext-2" },
      body: {},
    });

    expect(res.statusCode).toBe(200);
    expect(extractionReviewServiceMocks.approveEstimateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        extractionId: "ext-2",
        userId: "user-1",
      })
    );
    expect(res.body.extraction.status).toBe("approved");
  });

  it("rejects an extraction row for the workbench", async () => {
    extractionReviewServiceMocks.rejectEstimateExtraction.mockResolvedValue({
      extraction: { id: "ext-3", status: "rejected" },
      reviewEvent: { id: "evt-3", eventType: "rejected" },
    });

    const { res } = await invokeRoute("post", "/:id/estimating/extractions/:extractionId/reject", {
      params: { id: "deal-1", extractionId: "ext-3" },
      body: { reason: "duplicate" },
    });

    expect(res.statusCode).toBe(200);
    expect(extractionReviewServiceMocks.rejectEstimateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        extractionId: "ext-3",
        userId: "user-1",
        reason: "duplicate",
      })
    );
    expect(res.body.extraction.status).toBe("rejected");
  });

  it("selects a catalog match for the workbench", async () => {
    matchReviewServiceMocks.selectEstimateExtractionMatch.mockResolvedValue({
      match: { id: "match-1", status: "selected" },
      reviewEvent: { id: "evt-4", eventType: "selected" },
    });

    const { res } = await invokeRoute("post", "/:id/estimating/matches/:matchId/select", {
      params: { id: "deal-1", matchId: "match-1" },
      body: {},
    });

    expect(res.statusCode).toBe(200);
    expect(matchReviewServiceMocks.selectEstimateExtractionMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        matchId: "match-1",
        userId: "user-1",
      })
    );
    expect(res.body.match.status).toBe("selected");
  });

  it("rejects a catalog match for the workbench", async () => {
    matchReviewServiceMocks.rejectEstimateExtractionMatch.mockResolvedValue({
      match: { id: "match-2", status: "rejected" },
      reviewEvent: { id: "evt-5", eventType: "rejected" },
    });

    const { res } = await invokeRoute("post", "/:id/estimating/matches/:matchId/reject", {
      params: { id: "deal-1", matchId: "match-2" },
      body: { reason: "wrong code" },
    });

    expect(res.statusCode).toBe(200);
    expect(matchReviewServiceMocks.rejectEstimateExtractionMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        matchId: "match-2",
        userId: "user-1",
        reason: "wrong code",
      })
    );
    expect(res.body.match.status).toBe("rejected");
  });

  it("approves a pricing recommendation for the workbench", async () => {
    pricingReviewServiceMocks.approveEstimatePricingRecommendation.mockResolvedValue({
      recommendation: { id: "rec-1", status: "approved" },
      reviewEvent: { id: "evt-6", eventType: "approved" },
    });

    const { res } = await invokeRoute("post", "/:id/estimating/pricing-recommendations/:recommendationId/approve", {
      params: { id: "deal-1", recommendationId: "rec-1" },
      body: {},
    });

    expect(res.statusCode).toBe(200);
    expect(pricingReviewServiceMocks.approveEstimatePricingRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        recommendationId: "rec-1",
        userId: "user-1",
      })
    );
    expect(res.body.recommendation.status).toBe("approved");
  });

  it("rejects a pricing recommendation for the workbench", async () => {
    pricingReviewServiceMocks.rejectEstimatePricingRecommendation.mockResolvedValue({
      recommendation: { id: "rec-2", status: "rejected" },
      reviewEvent: { id: "evt-7", eventType: "rejected" },
    });

    const { res } = await invokeRoute("post", "/:id/estimating/pricing-recommendations/:recommendationId/reject", {
      params: { id: "deal-1", recommendationId: "rec-2" },
      body: { reason: "not competitive" },
    });

    expect(res.statusCode).toBe(200);
    expect(pricingReviewServiceMocks.rejectEstimatePricingRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        recommendationId: "rec-2",
        userId: "user-1",
        reason: "not competitive",
      })
    );
    expect(res.body.recommendation.status).toBe("rejected");
  });

  it("overrides a pricing recommendation for the workbench", async () => {
    pricingReviewServiceMocks.overrideEstimatePricingRecommendation.mockResolvedValue({
      recommendation: { id: "rec-3", status: "overridden" },
      reviewEvent: { id: "evt-8", eventType: "overridden" },
    });

    const { res } = await invokeRoute("patch", "/:id/estimating/pricing-recommendations/:recommendationId/override", {
      params: { id: "deal-1", recommendationId: "rec-3" },
      body: {
        recommendedUnitPrice: "95.00",
        recommendedTotalPrice: "285.00",
        reason: "field conditions changed",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(pricingReviewServiceMocks.overrideEstimatePricingRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        recommendationId: "rec-3",
        userId: "user-1",
        input: {
          recommendedUnitPrice: "95.00",
          recommendedTotalPrice: "285.00",
          reason: "field conditions changed",
        },
      })
    );
    expect(res.body.recommendation.status).toBe("overridden");
  });

  it("returns the effective market context for a deal", async () => {
    dealMarketOverrideServiceMocks.getDealEffectiveMarketContext.mockResolvedValueOnce({
      effectiveMarket: {
        id: "market-2",
        name: "North Texas",
        slug: "north-texas",
        type: "state",
      },
      resolutionLevel: "state",
      resolutionSource: { type: "state", key: "TX", marketId: "market-2" },
      location: { zip: "76102", state: "TX", regionId: null },
      override: {
        id: "override-1",
        marketId: "market-2",
        marketName: "North Texas",
        marketSlug: "north-texas",
        overrideReason: "storm area",
        overriddenByUserId: "user-1",
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
    });

    const { res } = await invokeRoute("get", "/:id/estimating/market-context", {
      params: { id: "deal-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(dealMarketOverrideServiceMocks.getDealEffectiveMarketContext).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1"
    );
    expect(res.body.marketContext.effectiveMarket.id).toBe("market-2");
    expect(res.body.marketContext.override.marketId).toBe("market-2");
  });

  it("lists active market choices for override selection", async () => {
    dealMarketOverrideServiceMocks.listEstimateMarkets.mockResolvedValueOnce([
      {
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
    ]);

    const { res } = await invokeRoute("get", "/:id/estimating/markets", {
      params: { id: "deal-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(dealMarketOverrideServiceMocks.listEstimateMarkets).toHaveBeenCalledWith(expect.anything());
    expect(res.body.markets).toHaveLength(1);
    expect(res.body.markets[0].slug).toBe("default");
  });

  it("sets a market override, writes an audit event, and enqueues an estimate generation rerun", async () => {
    const setResult = {
      override: {
        id: "override-1",
        marketId: "market-override",
        marketName: "North Texas",
        marketSlug: "north-texas",
        overrideReason: "storm area",
        overriddenByUserId: "user-1",
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      reviewEvent: { id: "evt-set", eventType: "market_override_set" },
      effectiveMarket: {
        effectiveMarket: {
          id: "market-override",
          name: "North Texas",
          slug: "north-texas",
          type: "state",
        },
        resolutionLevel: "override",
        resolutionSource: { type: "override", key: "deal-1", marketId: "market-override" },
        location: { zip: null, state: null, regionId: null },
        override: {
          id: "override-1",
          marketId: "market-override",
          marketName: "North Texas",
          marketSlug: "north-texas",
          overrideReason: "storm area",
          overriddenByUserId: "user-1",
          createdAt: new Date("2026-04-21T00:00:00Z"),
          updatedAt: new Date("2026-04-21T00:00:00Z"),
        },
      },
      rerunRequestId: "rerun-1",
    };
    dealMarketOverrideServiceMocks.setDealMarketOverride.mockResolvedValueOnce(setResult);

    const { res } = await invokeRoute("put", "/:id/estimating/market-override", {
      params: { id: "deal-1" },
      body: { marketId: "market-override", reason: "storm area" },
    });

    expect(res.statusCode).toBe(200);
    expect(dealMarketOverrideServiceMocks.setDealMarketOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        marketId: "market-override",
        userId: "user-1",
        officeId: "office-1",
        reason: "storm area",
      })
    );
    expect(res.body).toEqual(setResult);
  });

  it("clears a market override, writes an audit event, and enqueues an estimate generation rerun", async () => {
    const clearResult = {
      cleared: {
        id: "override-1",
        dealId: "deal-1",
        marketId: "market-override",
        overriddenByUserId: "user-1",
        overrideReason: "seasonal reset",
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      reviewEvent: { id: "evt-clear", eventType: "market_override_cleared" },
      effectiveMarket: {
        effectiveMarket: {
          id: "market-1",
          name: "Default Market",
          slug: "default",
          type: "global",
        },
        resolutionLevel: "global_default",
        resolutionSource: { type: "global", key: "default", marketId: "market-1" },
        location: { zip: null, state: null, regionId: null },
        override: null,
      },
      rerunRequestId: "rerun-2",
    };
    dealMarketOverrideServiceMocks.clearDealMarketOverride.mockResolvedValueOnce(clearResult);

    const { res } = await invokeRoute("delete", "/:id/estimating/market-override", {
      params: { id: "deal-1" },
      body: { reason: "seasonal reset" },
    });

    expect(res.statusCode).toBe(200);
    expect(dealMarketOverrideServiceMocks.clearDealMarketOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        userId: "user-1",
        officeId: "office-1",
        reason: "seasonal reset",
      })
    );
    expect(res.body).toEqual(clearResult);
  });

  it("service path writes the audit event and rerun job when setting a market override", async () => {
    await vi.resetModules();
    vi.doUnmock("../../../src/modules/estimating/deal-market-override-service.js");
    vi.doMock("@trock-crm/shared/schema", () => {
      const makeTable = (name: string, columns: string[] = []) => {
        const table: Record<string, unknown> = {
          name,
          tableName: name,
          [Symbol.for("drizzle:Name")]: name,
        };
        for (const column of columns) {
          table[column] = { table: name, column };
        }
        return table;
      };

      return {
        deals: makeTable("deals", ["id", "propertyZip", "propertyState", "regionId", "propertyId"]),
        estimateDealMarketOverrides: makeTable("estimate_deal_market_overrides", [
          "id",
          "dealId",
          "marketId",
          "overriddenByUserId",
          "overrideReason",
          "createdAt",
          "updatedAt",
        ]),
        estimateMarkets: makeTable("estimate_markets", [
          "id",
          "name",
          "slug",
          "type",
          "stateCode",
          "regionId",
          "isActive",
          "createdAt",
          "updatedAt",
        ]),
        estimateReviewEvents: makeTable("estimate_review_events"),
        jobQueue: makeTable("job_queue"),
        properties: makeTable("properties", ["id", "zip", "state"]),
      };
    });
    installMarketContextMocksForOverrideFlow();
    vi.doMock("../../../src/modules/estimating/market-rate-provider.js", () => marketRateProviderMocks);
    vi.doMock("../../../src/modules/estimating/market-resolution-service.js", () => marketResolutionServiceMocks);
    const actualService = await import("../../../src/modules/estimating/deal-market-override-service.js");
    const { tenantDb, insertCalls } = createMarketOverrideTenantDb();

    const result = await actualService.setDealMarketOverride({
      tenantDb,
      dealId: "deal-1",
      marketId: "market-override",
      userId: "user-1",
      officeId: "office-1",
      reason: "storm area",
    });

    expect(result.rerunRequestId).toEqual(expect.any(String));
    const isTable = (table: any, name: string) =>
      table?.tableName === name || table?.name === name || table?.[Symbol.for("drizzle:Name")] === name;
    expect(insertCalls.some((call) => isTable(call.table, "estimate_review_events"))).toBe(true);
    expect(insertCalls.some((call) => isTable(call.table, "job_queue"))).toBe(true);
    const reviewInsert = insertCalls.find((call) => isTable(call.table, "estimate_review_events"));
    const jobInsert = insertCalls.find((call) => isTable(call.table, "job_queue"));
    expect(reviewInsert?.payload).toMatchObject({
      dealId: "deal-1",
      subjectType: "deal_market_override",
      subjectId: "deal-1",
      eventType: "market_override_set",
      userId: "user-1",
      reason: "storm area",
    });
    expect(reviewInsert?.payload.beforeJson).toMatchObject({
      effectiveMarket: { id: "market-1" },
      resolutionLevel: "global_default",
      resolutionSource: { type: "global" },
      override: null,
    });
    expect(reviewInsert?.payload.afterJson).toMatchObject({
      effectiveMarket: { id: "market-override" },
      resolutionLevel: "override",
      resolutionSource: { type: "override" },
      override: expect.objectContaining({
        marketId: "market-override",
      }),
    });
    expect(jobInsert?.payload).toMatchObject({
      jobType: "estimate_generation",
      officeId: "office-1",
      payload: expect.objectContaining({
        dealId: "deal-1",
        officeId: "office-1",
        rerunRequestId: result.rerunRequestId,
        trigger: "deal_market_override",
        reason: "market_override_set",
      }),
    });
  });

  it("service path writes the audit event and rerun job when clearing a market override", async () => {
    await vi.resetModules();
    vi.doUnmock("../../../src/modules/estimating/deal-market-override-service.js");
    vi.doMock("@trock-crm/shared/schema", () => {
      const makeTable = (name: string, columns: string[] = []) => {
        const table: Record<string, unknown> = {
          name,
          tableName: name,
          [Symbol.for("drizzle:Name")]: name,
        };
        for (const column of columns) {
          table[column] = { table: name, column };
        }
        return table;
      };

      return {
        deals: makeTable("deals", ["id", "propertyZip", "propertyState", "regionId", "propertyId"]),
        estimateDealMarketOverrides: makeTable("estimate_deal_market_overrides", [
          "id",
          "dealId",
          "marketId",
          "overriddenByUserId",
          "overrideReason",
          "createdAt",
          "updatedAt",
        ]),
        estimateMarkets: makeTable("estimate_markets", [
          "id",
          "name",
          "slug",
          "type",
          "stateCode",
          "regionId",
          "isActive",
          "createdAt",
          "updatedAt",
        ]),
        estimateReviewEvents: makeTable("estimate_review_events"),
        jobQueue: makeTable("job_queue"),
        properties: makeTable("properties", ["id", "zip", "state"]),
      };
    });
    installMarketContextMocksForOverrideFlow();
    vi.doMock("../../../src/modules/estimating/market-rate-provider.js", () => marketRateProviderMocks);
    vi.doMock("../../../src/modules/estimating/market-resolution-service.js", () => marketResolutionServiceMocks);
    const actualService = await import("../../../src/modules/estimating/deal-market-override-service.js");
    const { tenantDb, insertCalls } = createMarketOverrideTenantDb();

    await actualService.setDealMarketOverride({
      tenantDb,
      dealId: "deal-1",
      marketId: "market-override",
      userId: "user-1",
      officeId: "office-1",
      reason: "storm area",
    });
    insertCalls.length = 0;

    const result = await actualService.clearDealMarketOverride({
      tenantDb,
      dealId: "deal-1",
      userId: "user-1",
      officeId: "office-1",
      reason: "seasonal reset",
    });

    expect(result.rerunRequestId).toEqual(expect.any(String));
    const isTable = (table: any, name: string) =>
      table?.tableName === name || table?.name === name || table?.[Symbol.for("drizzle:Name")] === name;
    const reviewInsert = insertCalls.find((call) => isTable(call.table, "estimate_review_events"));
    const jobInsert = insertCalls.find((call) => isTable(call.table, "job_queue"));
    expect(reviewInsert?.payload).toMatchObject({
      dealId: "deal-1",
      subjectType: "deal_market_override",
      subjectId: "deal-1",
      eventType: "market_override_cleared",
      userId: "user-1",
      reason: "seasonal reset",
    });
    expect(reviewInsert?.payload.beforeJson).toMatchObject({
      effectiveMarket: { id: "market-override" },
      resolutionLevel: "override",
      resolutionSource: { type: "override" },
      override: expect.objectContaining({
        marketId: "market-override",
      }),
    });
    expect(reviewInsert?.payload.afterJson).toMatchObject({
      effectiveMarket: { id: "market-1" },
      resolutionLevel: "global_default",
      resolutionSource: { type: "global" },
      override: null,
    });
    expect(jobInsert?.payload).toMatchObject({
      jobType: "estimate_generation",
      officeId: "office-1",
      payload: expect.objectContaining({
        dealId: "deal-1",
        officeId: "office-1",
        rerunRequestId: result.rerunRequestId,
        trigger: "deal_market_override",
        reason: "market_override_cleared",
      }),
    });
  });

  it.each([
    {
      action: "accept_recommended",
      body: {},
      eventType: "accepted_recommended",
      status: "approved",
    },
    {
      action: "accept_manual_row",
      body: {},
      eventType: "accepted_manual_row",
      status: "approved",
    },
    {
      action: "switch_to_alternate",
      body: { alternateOptionId: "option-2" },
      eventType: "switched_to_alternate",
      status: "approved",
    },
    {
      action: "override",
      body: {
        recommendedUnitPrice: "95.00",
        recommendedTotalPrice: "285.00",
        reason: "field conditions changed",
      },
      eventType: "overridden",
      status: "overridden",
    },
    {
      action: "reject",
      body: { reason: "not viable" },
      eventType: "rejected",
      status: "rejected",
    },
    {
      action: "pending_review",
      body: {},
      eventType: "pending_review",
      status: "pending_review",
    },
  ])("updates review state for $action", async ({ action, body, eventType, status }) => {
    estimatingWorkbenchServiceMocks.updateEstimatePricingRecommendationReviewState.mockResolvedValue({
      recommendation: { id: "rec-9", status },
      reviewEvent: { id: "evt-9", eventType },
    });

    const { res } = await invokeRoute("post", "/:id/estimating/pricing-recommendations/:recommendationId/review-state", {
      params: { id: "deal-1", recommendationId: "rec-9" },
      body: {
        action,
        ...body,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(estimatingWorkbenchServiceMocks.updateEstimatePricingRecommendationReviewState).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        recommendationId: "rec-9",
        userId: "user-1",
        input: expect.objectContaining({
          action,
          ...body,
        }),
      })
    );
    expect(res.body.recommendation.status).toBe(status);
  });

  it("returns row-level promotion errors when duplicate recommendations are blocked", async () => {
    const rowErrors = [{ recommendationId: "rec-dup-1", code: "duplicate_blocked", message: "Blocked by a duplicate group" }];
    draftEstimateServiceMocks.listApprovedRecommendationIdsForRun.mockResolvedValue(["rec-ovr"]);
    draftEstimateServiceMocks.promoteApprovedRecommendationsToEstimate.mockResolvedValue({
      promotedRecommendationIds: [],
      rowErrors,
    });

    const { res } = await invokeRoute("post", "/:id/estimating/promote", {
      params: { id: "deal-1" },
      body: { generationRunId: "run-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(draftEstimateServiceMocks.promoteApprovedRecommendationsToEstimate).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        generationRunId: "run-1",
        approvedRecommendationIds: ["rec-ovr"],
      })
    );
    expect(res.body.rowErrors).toEqual(rowErrors);
  });

  it("creates a pending-review manual row from free text when no catalog item is selected", async () => {
    manualRowServiceMocks.createManualEstimateRow.mockResolvedValue({
      recommendation: {
        id: "rec-manual-1",
        status: "pending_review",
        sourceType: "manual",
        selectedSourceType: null,
        selectedOptionId: null,
        catalogBacking: "estimate_only",
        promotedLocalCatalogItemId: null,
        manualIdentityKey: "manual-key-1",
      },
      optionRows: [],
    });

    const { res } = await invokeRoute("post", "/:id/estimating/manual-rows", {
      params: { id: "deal-1" },
      body: {
        generationRunId: "run-1",
        extractionMatchId: "match-1",
        estimateSectionName: "Roofing",
        manualLabel: "Custom flashing",
        manualQuantity: "2",
        manualUnit: "ea",
        manualUnitPrice: "75.00",
        manualNotes: "field measured",
        catalogQuery: "flashing",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(manualRowServiceMocks.createManualEstimateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        userId: "user-1",
        input: expect.objectContaining({
          generationRunId: "run-1",
          extractionMatchId: "match-1",
          estimateSectionName: "Roofing",
          manualLabel: "Custom flashing",
          catalogQuery: "flashing",
        }),
      })
    );
    expect(res.body.recommendation).toEqual(
      expect.objectContaining({
        status: "pending_review",
        sourceType: "manual",
        catalogBacking: "estimate_only",
      })
    );
  });

  it("keeps an immutable manual identity when a manual row is edited into a catalog-backed selection", async () => {
    manualRowServiceMocks.updateManualEstimateRow.mockResolvedValue({
      recommendation: {
        id: "rec-manual-2",
        status: "pending_review",
        sourceType: "manual",
        selectedSourceType: "catalog_option",
        selectedOptionId: "child-option-1",
        catalogBacking: "local_promoted",
        promotedLocalCatalogItemId: null,
        manualIdentityKey: "manual-key-2",
      },
      optionRows: [{ id: "child-option-1", optionKind: "manual_custom" }],
    });

    const { res } = await invokeRoute("patch", "/:id/estimating/manual-rows/:recommendationId", {
      params: { id: "deal-1", recommendationId: "rec-manual-2" },
      body: {
        manualIdentityKey: "attempted-change",
        selectedSourceType: "catalog_option",
        selectedOptionId: "child-option-1",
        catalogBacking: "local_promoted",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(manualRowServiceMocks.updateManualEstimateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        recommendationId: "rec-manual-2",
        userId: "user-1",
        input: expect.objectContaining({
          manualIdentityKey: "attempted-change",
          selectedSourceType: "catalog_option",
          selectedOptionId: "child-option-1",
          catalogBacking: "local_promoted",
        }),
      })
    );
    expect(res.body.recommendation).toEqual(
      expect.objectContaining({
        selectedSourceType: "catalog_option",
        selectedOptionId: "child-option-1",
        promotedLocalCatalogItemId: null,
        manualIdentityKey: "manual-key-2",
      })
    );
  });

  it("promotes only free-text manual rows into the local catalog and seeds override values", async () => {
    localCatalogServiceMocks.promoteManualRowToLocalCatalog.mockResolvedValue({
      recommendation: {
        id: "rec-manual-3",
        promotedLocalCatalogItemId: "local-cat-1",
        catalogBacking: "local_promoted",
      },
      localCatalogItem: {
        id: "local-cat-1",
        name: "Custom flashing",
        unit: "lf",
      },
    });

    const { res } = await invokeRoute("post", "/:id/estimating/manual-rows/:recommendationId/promote-local-catalog", {
      params: { id: "deal-1", recommendationId: "rec-manual-3" },
      body: {
        overrideQuantity: "4",
        overrideUnit: "lf",
        overrideUnitPrice: "18.00",
        overrideNotes: "use adjusted field measure",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(localCatalogServiceMocks.promoteManualRowToLocalCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        recommendationId: "rec-manual-3",
        userId: "user-1",
        input: expect.objectContaining({
          overrideQuantity: "4",
          overrideUnit: "lf",
          overrideUnitPrice: "18.00",
          overrideNotes: "use adjusted field measure",
        }),
      })
    );
    expect(res.body.recommendation).toEqual(
      expect.objectContaining({
        promotedLocalCatalogItemId: "local-cat-1",
        catalogBacking: "local_promoted",
      })
    );
  });
});
