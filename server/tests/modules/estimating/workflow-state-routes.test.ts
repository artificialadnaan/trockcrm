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

const documentServiceMocks = vi.hoisted(() => ({
  createEstimateSourceDocument: vi.fn(),
  enqueueEstimateDocumentOcrJob: vi.fn(),
  reprocessEstimateSourceDocument: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/document-service.js", () => documentServiceMocks);

const fileServiceMocks = vi.hoisted(() => ({
  confirmUpload: vi.fn(),
}));

vi.mock("../../../src/modules/files/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/files/service.js")>(
    "../../../src/modules/files/service.js"
  );

  return {
    ...actual,
    confirmUpload: fileServiceMocks.confirmUpload,
  };
});

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

function findRouteHandler(method: "get" | "post" | "patch", path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  return routeLayer.handle;
}

async function invokeRoute(
  method: "get" | "post" | "patch",
  path: string,
  options?: { params?: Record<string, string>; body?: any }
) {
  const handler = findRouteHandler(method, path);
  const req = {
    params: options?.params ?? {},
    body: options?.body ?? {},
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

describe("estimating workflow routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealsServiceMocks.getDealById.mockResolvedValue({ id: "deal-1" });
    fileServiceMocks.confirmUpload.mockResolvedValue({
      id: "file-1",
      parentFileId: null,
      originalFilename: "plans.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1024,
      r2Key: "r2/doc-1.pdf",
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
    });

    const { res } = await invokeRoute("get", "/:id/estimating", {
      params: { id: "deal-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(estimatingServiceMocks.getEstimatingWorkflowState).toHaveBeenCalled();
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
});
