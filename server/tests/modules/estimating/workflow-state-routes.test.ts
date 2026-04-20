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

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

function findRouteHandler(method: "get" | "post", path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  return routeLayer.handle;
}

async function invokeRoute(
  method: "get" | "post",
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
        documentCount: 0,
        extractionCount: 0,
        matchCount: 0,
        recommendationCount: 0,
        approvedRecommendationCount: 0,
        reviewEventCount: 0,
      },
      promotionReady: false,
    });

    const { res } = await invokeRoute("get", "/:id/estimating", {
      params: { id: "deal-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(estimatingServiceMocks.getEstimatingWorkflowState).toHaveBeenCalled();
    expect(res.body.summary).toEqual({
      documentCount: 0,
      extractionCount: 0,
      matchCount: 0,
      recommendationCount: 0,
      approvedRecommendationCount: 0,
      reviewEventCount: 0,
    });
    expect(res.body.promotionReady).toBe(false);
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
});
