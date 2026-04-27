import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dealsServiceMocks = vi.hoisted(() => ({
  setDealContractSignedDate: vi.fn(),
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
    setDealContractSignedDate: dealsServiceMocks.setDealContractSignedDate,
  };
});

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

type TestUser = {
  id: string;
  role: "admin" | "director" | "rep";
  displayName: string;
  email: string;
  officeId: string;
  activeOfficeId: string;
};

function createUser(role: TestUser["role"]): TestUser {
  return {
    id: `${role}-1`,
    role,
    displayName: `${role} user`,
    email: `${role}@example.com`,
    officeId: "office-1",
    activeOfficeId: "office-1",
  };
}

function createApp(user: TestUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).tenantDb = {};
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/deals/:id/contract-signed-date — RBAC", () => {
  beforeEach(() => {
    dealsServiceMocks.setDealContractSignedDate.mockReset();
    dealsServiceMocks.setDealContractSignedDate.mockResolvedValue({
      id: "deal-1",
      contractSignedDate: "2026-09-15",
    });
  });

  it("admin can set contract_signed_date (200)", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/contract-signed-date")
      .send({ date: "2026-09-15" });
    expect(res.status).toBe(200);
    expect(res.body.deal.contractSignedDate).toBe("2026-09-15");
    expect(dealsServiceMocks.setDealContractSignedDate).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      "2026-09-15",
      "admin-1"
    );
  });

  it("director can set contract_signed_date (200)", async () => {
    const app = createApp(createUser("director"));
    const res = await request(app)
      .patch("/api/deals/deal-1/contract-signed-date")
      .send({ date: "2026-09-15" });
    expect(res.status).toBe(200);
    expect(dealsServiceMocks.setDealContractSignedDate).toHaveBeenCalled();
  });

  // USER_ROLES = ["admin", "director", "rep"] — there is no separate
  // "sales_rep" or "project_manager" role enum value. "rep" is the
  // catch-all for everyone non-admin / non-director, so a single 403
  // assertion against "rep" covers both the sales-rep and
  // project-manager cases the spec called out.
  it("rep (sales / project manager equivalent) gets 403", async () => {
    const app = createApp(createUser("rep"));
    const res = await request(app)
      .patch("/api/deals/deal-1/contract-signed-date")
      .send({ date: "2026-09-15" });
    expect(res.status).toBe(403);
    expect(dealsServiceMocks.setDealContractSignedDate).not.toHaveBeenCalled();
  });

  it("rejects malformed date with 422", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/contract-signed-date")
      .send({ date: "Q1 2026" });
    expect(res.status).toBe(422);
    expect(dealsServiceMocks.setDealContractSignedDate).not.toHaveBeenCalled();
  });

  it("accepts null to clear the date (200)", async () => {
    dealsServiceMocks.setDealContractSignedDate.mockResolvedValue({
      id: "deal-1",
      contractSignedDate: null,
    });
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/contract-signed-date")
      .send({ date: null });
    expect(res.status).toBe(200);
    expect(dealsServiceMocks.setDealContractSignedDate).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      null,
      "admin-1"
    );
  });
});
