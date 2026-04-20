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
  });

  it("returns workflow state for the estimating shell", async () => {
    estimatingServiceMocks.getEstimatingWorkflowState.mockResolvedValue({
      documents: [],
      extractionRows: [],
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
});
