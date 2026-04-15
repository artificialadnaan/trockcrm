import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  globalSearch: vi.fn(),
  naturalLanguageSearch: vi.fn(),
}));

vi.mock("../../../src/modules/search/service.js", () => ({
  globalSearch: serviceMocks.globalSearch,
  naturalLanguageSearch: serviceMocks.naturalLanguageSearch,
}));

const { searchRoutes } = await import("../../../src/modules/search/routes.js");

function createApp() {
  const app = express();
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
      summary: "Found a matching deal and indexed email evidence.",
      structured: {
        deals: [],
        contacts: [],
        files: [],
        total: 0,
        query: "revision scope",
      },
      evidence: [
        {
          id: "chunk-1",
          sourceType: "email_message",
          sourceId: "email-1",
          dealId: "deal-1",
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
    expect(res.body.evidence).toHaveLength(1);
  });
});
