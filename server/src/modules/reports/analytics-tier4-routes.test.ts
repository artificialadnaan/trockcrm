import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMarketMixReport: vi.fn(),
}));

vi.mock("./analytics-tier4-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./analytics-tier4-service.js")>();
  return {
    ...actual,
    getMarketMixReport: mocks.getMarketMixReport,
  };
});

import { reportRoutes } from "./routes.js";

function createApp() {
  const app = express();
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "director@example.com",
      displayName: "Director",
      role: "director",
      officeId: "22222222-2222-4222-8222-222222222222",
      activeOfficeId: "22222222-2222-4222-8222-222222222222",
    } as any;
    req.tenantDb = { execute: vi.fn() } as any;
    req.commitTransaction = vi.fn().mockResolvedValue(undefined) as any;
    next();
  });
  app.use("/api/reports", reportRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as any).statusCode ?? 500).json({
      error: { message: err instanceof Error ? err.message : "Internal server error" },
    });
  });
  return app;
}

describe("analytics tier 4 report routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMarketMixReport.mockResolvedValue({ kpis: {}, verticalMix: [] });
  });

  it("returns 400 for malformed ownerIds instead of calling the service", async () => {
    const response = await request(createApp()).get("/api/reports/market-mix?ownerIds=not-a-uuid");

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("ownerIds");
    expect(mocks.getMarketMixReport).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed from instead of calling the service", async () => {
    const response = await request(createApp()).get("/api/reports/market-mix?from=invalid");

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("dateFrom");
    expect(mocks.getMarketMixReport).not.toHaveBeenCalled();
  });
});
