import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  globalSearch: vi.fn(),
  naturalLanguageSearch: vi.fn(),
}));

const aiCopilotMocks = vi.hoisted(() => ({
  recordAiFeedback: vi.fn(),
}));

vi.mock("../../../src/modules/search/service.js", () => ({
  globalSearch: serviceMocks.globalSearch,
  naturalLanguageSearch: serviceMocks.naturalLanguageSearch,
}));

vi.mock("../../../src/modules/ai-copilot/service.js", () => ({
  recordAiFeedback: aiCopilotMocks.recordAiFeedback,
}));

const { searchRoutes } = await import("../../../src/modules/search/routes.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "director-1", role: "director" };
    req.tenantDb = {};
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/search", searchRoutes);
  return app;
}

describe("search routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns structured search results", async () => {
    serviceMocks.globalSearch.mockResolvedValue({
      deals: [{ id: "deal-1", entityType: "deal", primaryLabel: "Alpha Plaza", secondaryLabel: "D-1001", deepLink: "/deals/deal-1", rank: 0.9 }],
      contacts: [],
      files: [],
      total: 1,
      query: "alpha",
    });

    const app = createApp();
    const res = await request(app).get("/api/search?q=alpha");

    expect(res.status).toBe(200);
    expect(serviceMocks.globalSearch).toHaveBeenCalledWith(expect.anything(), "alpha", ["deals", "contacts", "files"], "director", "director-1");
    expect(res.body.total).toBe(1);
  });

  it("returns AI search results", async () => {
    serviceMocks.naturalLanguageSearch.mockResolvedValue({
      query: "revision scope",
      intent: "deal_lookup",
      summary: "Found a matching deal and indexed email evidence.",
      structured: {
        deals: [],
        contacts: [],
        files: [],
        total: 0,
        query: "revision scope",
      },
      topEntities: [
        {
          entityType: "deal",
          id: "deal-1",
          label: "Alpha Plaza",
          deepLink: "/deals/deal-1",
        },
      ],
      recommendedActions: [
        {
          actionType: "open_best_match",
          label: "Open Best Deal Match",
          rationale: "Jump to the strongest deal result.",
          deepLink: "/deals/deal-1",
        },
      ],
      evidence: [
        {
          id: "chunk-1",
          sourceType: "email_message",
          sourceId: "email-1",
          dealId: "deal-1",
          entityType: "deal",
          entityLabel: "Alpha Plaza",
          title: "Revision follow-up",
          snippet: "Customer asked for a revision.",
          deepLink: "/deals/deal-1",
        },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/api/search/ai?q=revision%20scope");

    expect(res.status).toBe(200);
    expect(serviceMocks.naturalLanguageSearch).toHaveBeenCalledWith(
      expect.anything(),
      "revision scope",
      ["deals", "contacts", "files"],
      "director",
      "director-1"
    );
    expect(res.body.summary).toContain("indexed email evidence");
    expect(res.body.intent).toBe("deal_lookup");
    expect(res.body.topEntities).toHaveLength(1);
    expect(res.body.recommendedActions).toHaveLength(1);
    expect(res.body.evidence).toHaveLength(1);
  });

  it("tracks AI search interactions", async () => {
    aiCopilotMocks.recordAiFeedback.mockResolvedValueOnce({ id: "feedback-1" });

    const app = createApp();
    const res = await request(app)
      .post("/api/search/ai/interaction")
      .send({
        queryId: "11111111-1111-1111-1111-111111111111",
        interactionType: "recommended_action_click",
        targetValue: "open_best_match",
        deepLink: "/deals/deal-1",
      });

    expect(res.status).toBe(201);
    expect(aiCopilotMocks.recordAiFeedback).toHaveBeenCalledWith(expect.anything(), {
      targetType: "search_query",
      targetId: "11111111-1111-1111-1111-111111111111",
      userId: "director-1",
      feedbackType: "search_interaction",
      feedbackValue: "recommended_action_click",
      comment: JSON.stringify({
        targetValue: "open_best_match",
        deepLink: "/deals/deal-1",
      }),
    });
  });

  it("tracks executed AI search workflows separately from clicks", async () => {
    aiCopilotMocks.recordAiFeedback.mockResolvedValueOnce({ id: "feedback-2" });

    const app = createApp();
    const res = await request(app)
      .post("/api/search/ai/interaction")
      .send({
        queryId: "22222222-2222-2222-2222-222222222222",
        interactionType: "recommended_action_executed",
        targetValue: "refresh_deal_copilot",
        deepLink: "/deals/deal-1?tab=overview&focus=copilot",
        executionMode: "api_then_navigate",
        apiEndpoint: "/ai/deals/deal-1/regenerate",
      });

    expect(res.status).toBe(201);
    expect(aiCopilotMocks.recordAiFeedback).toHaveBeenCalledWith(expect.anything(), {
      targetType: "search_query",
      targetId: "22222222-2222-2222-2222-222222222222",
      userId: "director-1",
      feedbackType: "search_interaction",
      feedbackValue: "recommended_action_executed",
      comment: JSON.stringify({
        targetValue: "refresh_deal_copilot",
        deepLink: "/deals/deal-1?tab=overview&focus=copilot",
        executionMode: "api_then_navigate",
        apiEndpoint: "/ai/deals/deal-1/regenerate",
      }),
    });
  });

  it("tracks AI search impressions with query context", async () => {
    aiCopilotMocks.recordAiFeedback.mockResolvedValueOnce({ id: "feedback-3" });

    const app = createApp();
    const res = await request(app)
      .post("/api/search/ai/interaction")
      .send({
        queryId: "33333333-3333-3333-3333-333333333333",
        interactionType: "search_impression",
        targetValue: "deal_lookup",
        deepLink: "/search?q=alpha%20revision",
        queryContext: {
          query: "alpha revision",
          intent: "deal_lookup",
          structuredTotal: 2,
          topEntityTypes: ["deal"],
          recommendedActionTypes: ["refresh_deal_copilot", "review_deal_emails"],
          hasEvidence: true,
        },
      });

    expect(res.status).toBe(201);
    expect(aiCopilotMocks.recordAiFeedback).toHaveBeenCalledWith(expect.anything(), {
      targetType: "search_query",
      targetId: "33333333-3333-3333-3333-333333333333",
      userId: "director-1",
      feedbackType: "search_interaction",
      feedbackValue: "search_impression",
      comment: JSON.stringify({
        targetValue: "deal_lookup",
        deepLink: "/search?q=alpha%20revision",
        queryContext: {
          query: "alpha revision",
          intent: "deal_lookup",
          structuredTotal: 2,
          topEntityTypes: ["deal"],
          recommendedActionTypes: ["refresh_deal_copilot", "review_deal_emails"],
          hasEvidence: true,
        },
      }),
    });
  });
});
