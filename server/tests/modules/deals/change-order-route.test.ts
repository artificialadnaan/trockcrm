import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coServiceMocks = vi.hoisted(() => ({
  addDealChangeOrder: vi.fn(),
  getDealChangeOrderById: vi.fn(),
  listDealChangeOrders: vi.fn(),
  sumDealChangeOrders: vi.fn(),
  updateDealChangeOrder: vi.fn(),
  deleteDealChangeOrder: vi.fn(),
}));
const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
}));
const auditMocks = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));
vi.mock("../../../src/modules/deals/change-order-service.js", () => coServiceMocks);
vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));
vi.mock("../../../src/lib/audit-log.js", () => ({ writeAuditLog: auditMocks.writeAuditLog }));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");
const { AppError } = await import("../../../src/middleware/error-handler.js");

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

describe("deal change-order routes — RBAC + wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
      officeId: "office-1",
    });
    accessMocks.assertDealOwnerAccess.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
      officeId: "office-1",
    });
    coServiceMocks.addDealChangeOrder.mockResolvedValue({
      id: "co-1",
      dealId: "deal-1",
      signedDate: "2026-03-15",
      amount: "1500.00",
      description: "extra flashing",
    });
    coServiceMocks.getDealChangeOrderById.mockResolvedValue({
      id: "co-1",
      dealId: "deal-1",
      signedDate: "2026-03-15",
      amount: "1500.00",
      description: "extra flashing",
    });
    coServiceMocks.updateDealChangeOrder.mockResolvedValue({
      id: "co-1",
      dealId: "deal-1",
      signedDate: "2026-06-01",
      amount: "250.00",
      description: "revised",
    });
    coServiceMocks.deleteDealChangeOrder.mockResolvedValue({
      id: "co-1",
      dealId: "deal-1",
      signedDate: "2026-03-15",
      amount: "1500.00",
      description: "extra flashing",
    });
    coServiceMocks.listDealChangeOrders.mockResolvedValue([
      { id: "co-1", dealId: "deal-1", signedDate: "2026-03-15", amount: "1500.00", description: null },
    ]);
    coServiceMocks.sumDealChangeOrders.mockResolvedValue("1500.00");
  });

  it("admin can add a change order (201) and the service receives createdBy = admin id", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .post("/api/deals/deal-1/change-orders")
      .send({ signedDate: "2026-03-15", amount: "1500", description: "extra flashing" });
    expect(res.status).toBe(201);
    expect(res.body.changeOrder.id).toBe("co-1");
    expect(coServiceMocks.addDealChangeOrder).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        dealId: "deal-1",
        signedDate: "2026-03-15",
        amount: "1500",
        description: "extra flashing",
        createdBy: "admin-1",
      }),
    );
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ tableName: "deal_change_orders", recordId: "co-1", action: "insert" }),
    );
  });

  it("a rep cannot add a change order (403) and the service is not called", async () => {
    const app = createApp(createUser("rep"));
    const res = await request(app)
      .post("/api/deals/deal-1/change-orders")
      .send({ signedDate: "2026-03-15", amount: "1500" });
    expect(res.status).toBe(403);
    expect(coServiceMocks.addDealChangeOrder).not.toHaveBeenCalled();
  });

  it("a director cannot add a change order (admin-only, 403)", async () => {
    const app = createApp(createUser("director"));
    const res = await request(app)
      .post("/api/deals/deal-1/change-orders")
      .send({ signedDate: "2026-03-15", amount: "1500" });
    expect(res.status).toBe(403);
    expect(coServiceMocks.addDealChangeOrder).not.toHaveBeenCalled();
  });

  it("propagates the eligibility 409 from the service", async () => {
    coServiceMocks.addDealChangeOrder.mockRejectedValueOnce(
      new AppError(409, "Change orders can only be added to Won or Bid-Board-owned deals.", "DEAL_NOT_CHANGE_ORDER_ELIGIBLE"),
    );
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .post("/api/deals/deal-1/change-orders")
      .send({ signedDate: "2026-03-15", amount: "1500" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEAL_NOT_CHANGE_ORDER_ELIGIBLE");
  });

  it("propagates the positive-amount 400 from the service", async () => {
    coServiceMocks.addDealChangeOrder.mockRejectedValueOnce(
      new AppError(400, "Change order amount must be a positive number.", "CHANGE_ORDER_AMOUNT_INVALID"),
    );
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .post("/api/deals/deal-1/change-orders")
      .send({ signedDate: "2026-03-15", amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CHANGE_ORDER_AMOUNT_INVALID");
  });

  it("anyone with deal access can list change orders (rep, 200)", async () => {
    const app = createApp(createUser("rep"));
    const res = await request(app).get("/api/deals/deal-1/change-orders");
    expect(res.status).toBe(200);
    expect(res.body.changeOrders).toHaveLength(1);
    expect(res.body.total).toBe("1500.00");
    expect(coServiceMocks.listDealChangeOrders).toHaveBeenCalled();
  });

  it("admin can edit a change order (200) with updatedBy = admin id", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/change-orders/co-1")
      .send({ amount: "250", signedDate: "2026-06-01", description: "revised" });
    expect(res.status).toBe(200);
    expect(coServiceMocks.updateDealChangeOrder).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: "co-1", dealId: "deal-1", amount: "250", updatedBy: "admin-1" }),
    );
    // Audit captures the true before -> after for every field the request sent.
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        tableName: "deal_change_orders",
        action: "update",
        changes: {
          amount: { from: "1500.00", to: "250.00" },
          signedDate: { from: "2026-03-15", to: "2026-06-01" },
          description: { from: "extra flashing", to: "revised" },
        },
      }),
    );
  });

  it("audits only the fields a partial edit actually changed", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/change-orders/co-1")
      .send({ amount: "250" });
    expect(res.status).toBe(200);
    const auditEntry = auditMocks.writeAuditLog.mock.calls[0][1];
    expect(auditEntry.changes).toEqual({ amount: { from: "1500.00", to: "250.00" } });
    expect(auditEntry.changes).not.toHaveProperty("signedDate");
    expect(auditEntry.changes).not.toHaveProperty("description");
  });

  it("a rep cannot edit a change order (403)", async () => {
    const app = createApp(createUser("rep"));
    const res = await request(app)
      .patch("/api/deals/deal-1/change-orders/co-1")
      .send({ amount: "250" });
    expect(res.status).toBe(403);
    expect(coServiceMocks.updateDealChangeOrder).not.toHaveBeenCalled();
  });

  it("admin can delete a change order (200) and an audit row is written", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app).delete("/api/deals/deal-1/change-orders/co-1");
    expect(res.status).toBe(200);
    expect(coServiceMocks.deleteDealChangeOrder).toHaveBeenCalledWith(
      expect.any(Object),
      { id: "co-1", dealId: "deal-1", deletedBy: "admin-1" },
    );
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        tableName: "deal_change_orders",
        recordId: "co-1",
        action: "delete",
        changes: {
          amount: { from: "1500.00", to: null },
          signedDate: { from: "2026-03-15", to: null },
          description: { from: "extra flashing", to: null },
        },
      }),
    );
  });

  it("a rep cannot delete a change order (403)", async () => {
    const app = createApp(createUser("rep"));
    const res = await request(app).delete("/api/deals/deal-1/change-orders/co-1");
    expect(res.status).toBe(403);
    expect(coServiceMocks.deleteDealChangeOrder).not.toHaveBeenCalled();
  });
});
