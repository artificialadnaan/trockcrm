import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dealsServiceMocks = vi.hoisted(() => ({
  createDeal: vi.fn(),
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
    createDeal: dealsServiceMocks.createDeal,
  };
});

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");
const { AppError } = await import("../../../src/middleware/error-handler.js");

function createApp(officeSlug: string | null = "dallas") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: "admin-1",
      role: "admin",
      displayName: "Admin",
      email: "admin@example.com",
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
    };
    (req as any).officeSlug = officeSlug ?? undefined;
    (req as any).tenantDb = {};
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "SMOKE TEST DELETE direct-create officecode",
    stageId: "stage-opportunity",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    ...overrides,
  };
}

describe("POST /api/deals create context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealsServiceMocks.createDeal.mockImplementation(async (_tenantDb, input) => {
      if (input.officeCode !== "dfw" && input.officeCode !== "atl") {
        throw new AppError(400, "officeCode must be 'dfw' or 'atl'");
      }

      return {
        id: "deal-1",
        name: "SMOKE TEST DELETE direct-create officecode",
        officeCode: input.officeCode,
        hubspotDealId: null,
      };
    });
  });

  it("auto-resolves missing officeCode from the active office slug", async () => {
    const res = await request(createApp("dallas"))
      .post("/api/deals")
      .send(validBody());

    expect(res.status).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeCode: "dfw",
        officeId: "office-dallas",
        actorUserId: "admin-1",
        creationContext: "direct",
      })
    );
  });

  it.each([null, 123, {}])("rejects malformed explicit officeCode %j instead of inferring", async (officeCode) => {
    const res = await request(createApp("dallas"))
      .post("/api/deals")
      .send(validBody({ officeCode }));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("officeCode must be 'dfw' or 'atl'");
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeCode: String(officeCode ?? ""),
      })
    );
  });
});
