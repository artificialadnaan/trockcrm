import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors estimator-route.runtime.test.ts. `vi.importActual` is spread first so every OTHER export
// stays real — the point of the last test here is that the GENERIC path is still ownership-gated.
const dealsServiceMocks = vi.hoisted(() => ({
  setDealAwardedAmount: vi.fn(),
}));
const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn(
    (_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"
  ),
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));

vi.mock("../../../src/modules/deals/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/deals/service.js");
  return {
    ...(actual as Record<string, unknown>),
    setDealAwardedAmount: dealsServiceMocks.setDealAwardedAmount,
  };
});

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

type Role = "admin" | "director" | "rep";

function createUser(role: Role) {
  return {
    id: `${role}-1`,
    role,
    displayName: `${role} user`,
    email: `${role}@example.com`,
    officeId: "office-1",
    activeOfficeId: "office-1",
  };
}

function createApp(user: ReturnType<typeof createUser> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as any).user = user;
    (req as any).tenantDb = {};
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/deals/:id/awarded-amount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealsServiceMocks.setDealAwardedAmount.mockReset();
    dealsServiceMocks.setDealAwardedAmount.mockResolvedValue({ id: "deal-1", awardedAmount: "439120.68" });
  });

  // The whole point of the route: a leader can set it on a deal they do NOT own. Before it, the owning
  // rep failed the awarded RBAC and the leader failed the ownership check, so nobody could.
  it.each(["admin", "director"] as const)("%s can set the awarded amount on any reachable deal", async (role) => {
    const res = await request(createApp(createUser(role)))
      .patch("/api/deals/deal-1/awarded-amount")
      .send({ awardedAmount: "439120.68" });

    expect(res.status).toBe(200);
    expect(dealsServiceMocks.setDealAwardedAmount).toHaveBeenCalledWith(
      expect.any(Object),
      "deal-1",
      "439120.68",
      `${role}-1`,
      expect.objectContaining({ actor: expect.anything() })
    );
    // Office/scope is still proven for THIS deal — requireRole alone is leadership in the abstract.
    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalled();
    // ...but ownership is deliberately NOT required; that is the gate this route exists to bypass.
    expect(accessMocks.assertDealOwnerAccess).not.toHaveBeenCalled();
  });

  it("a rep is rejected — awarded amount stays leadership-only", async () => {
    const res = await request(createApp(createUser("rep")))
      .patch("/api/deals/deal-1/awarded-amount")
      .send({ awardedAmount: "1000" });

    expect(res.status).toBe(403);
    expect(dealsServiceMocks.setDealAwardedAmount).not.toHaveBeenCalled();
  });

  // An absent key must never be read as "clear it": a `{}` body wiping a money field would be silent
  // data loss. Clearing is explicit.
  it("rejects a body with no awardedAmount key rather than clearing the field", async () => {
    const res = await request(createApp(createUser("admin")))
      .patch("/api/deals/deal-1/awarded-amount")
      .send({});

    expect(res.status).toBe(422);
    expect(dealsServiceMocks.setDealAwardedAmount).not.toHaveBeenCalled();
  });

  it.each([null, ""])("treats an explicit %j as a clear", async (value) => {
    const res = await request(createApp(createUser("admin")))
      .patch("/api/deals/deal-1/awarded-amount")
      .send({ awardedAmount: value });

    expect(res.status).toBe(200);
    expect(dealsServiceMocks.setDealAwardedAmount).toHaveBeenCalledWith(
      expect.any(Object),
      "deal-1",
      null,
      "admin-1",
      expect.objectContaining({ actor: expect.anything() })
    );
  });

  // Codex P2: Number(true)===1 and Number([1])===1 are finite, so a boolean or array slipped past a
  // bare Number() check and `String(raw)` then sent "true" to a numeric(14,2) column — a 500, not the
  // documented 422. Only a number or a numeric STRING is a money value.
  it.each([true, false, [1], [], {}, "12abc"])("rejects the non-numeric JSON value %j", async (value) => {
    const res = await request(createApp(createUser("admin")))
      .patch("/api/deals/deal-1/awarded-amount")
      .send({ awardedAmount: value });

    expect(res.status).toBe(422);
    expect(dealsServiceMocks.setDealAwardedAmount).not.toHaveBeenCalled();
  });

  it("accepts a numeric string and a JSON number alike", async () => {
    for (const value of ["439120.68", 439120.68]) {
      dealsServiceMocks.setDealAwardedAmount.mockClear();
      const res = await request(createApp(createUser("admin")))
        .patch("/api/deals/deal-1/awarded-amount")
        .send({ awardedAmount: value });
      expect(res.status).toBe(200);
      expect(dealsServiceMocks.setDealAwardedAmount).toHaveBeenCalled();
    }
  });

  it("forwards the route audit context so a money edit is legible in the activity feed", async () => {
    await request(createApp(createUser("admin")))
      .patch("/api/deals/deal-1/awarded-amount")
      .send({ awardedAmount: "500" });

    // 5th arg — without it the service takes the legacy writeAuditLog path, which records no
    // field_changes_jsonb / entity / role / IP, so the feed shows an uninformative "update".
    const call = dealsServiceMocks.setDealAwardedAmount.mock.calls[0];
    expect(call?.[4]).toBeTruthy();
    expect(call?.[4]).toHaveProperty("actor");
  });

  it.each(["abc", -1, 1_000_000_000])("rejects %j", async (value) => {
    const res = await request(createApp(createUser("admin")))
      .patch("/api/deals/deal-1/awarded-amount")
      .send({ awardedAmount: value });

    expect(res.status).toBe(422);
    expect(dealsServiceMocks.setDealAwardedAmount).not.toHaveBeenCalled();
  });

  it("404s when the deal does not exist or is soft-deleted", async () => {
    dealsServiceMocks.setDealAwardedAmount.mockResolvedValue(null);
    const res = await request(createApp(createUser("admin")))
      .patch("/api/deals/deal-1/awarded-amount")
      .send({ awardedAmount: "500" });

    expect(res.status).toBe(404);
  });
});
