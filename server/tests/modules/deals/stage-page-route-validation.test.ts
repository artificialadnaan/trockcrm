import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dealsServiceMocks = vi.hoisted(() => ({
  listDealStagePage: vi.fn(),
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

vi.mock("../../../src/modules/deals/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/deals/service.js");
  return {
    ...(actual as Record<string, unknown>),
    listDealStagePage: dealsServiceMocks.listDealStagePage,
  };
});

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: "admin-1",
      role: "admin",
      displayName: "Admin",
      email: "admin@example.com",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    (req as any).tenantDb = {};
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

describe("GET /api/deals/stages/:stageId — query validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealsServiceMocks.listDealStagePage.mockResolvedValue({
      stage: { id: "stage-1", slug: "estimating", name: "Estimating" },
      scope: "all",
      summary: { count: 0, activeCount: 0, totalCount: 0, totalValue: 0, averageDaysInStage: null },
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
      rows: [],
    });
  });

  it("rejects a repeated (array) source param with 400 instead of 500", async () => {
    const app = createApp();
    const res = await request(app).get("/api/deals/stages/stage-1?source=a&source=b");
    expect(res.status).toBe(400);
    expect(dealsServiceMocks.listDealStagePage).not.toHaveBeenCalled();
  });

  it("passes a single source and staleOnly through to the service", async () => {
    const app = createApp();
    const res = await request(app).get("/api/deals/stages/stage-1?source=referral&staleOnly=true");
    expect(res.status).toBe(200);
    expect(dealsServiceMocks.listDealStagePage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: "referral", staleOnly: true })
    );
  });
});
