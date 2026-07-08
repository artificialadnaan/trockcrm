import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist service mock — only deleteDeal needs to be controlled; spread the real module for everything else.
const dealsServiceMocks = vi.hoisted(() => ({
  deleteDeal: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
}));

const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  logActivity: vi.fn().mockResolvedValue(undefined),
  buildAuditActorFromUser: vi.fn((u: { id: string; role: string; displayName: string }) => ({
    userId: u.id,
    role: u.role,
    displayName: u.displayName,
  })),
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));

// Partial mock of deals service — spread actual so every other import the route needs still works.
vi.mock("../../../src/modules/deals/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/deals/service.js");
  return {
    ...(actual as Record<string, unknown>),
    deleteDeal: dealsServiceMocks.deleteDeal,
  };
});

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

vi.mock("../../../src/lib/audit-log.js", () => ({ writeAuditLog: auditMocks.writeAuditLog }));

vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: auditMocks.logActivity,
  buildAuditActorFromUser: auditMocks.buildAuditActorFromUser,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler, AppError } = await import("../../../src/middleware/error-handler.js");

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

// tenantDb stub whose select().from().where().limit() chain resolves to the given rows —
// used by the CO-child check in DELETE /:id.
function tenantDbReturning(rows: unknown[]) {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) }),
  };
}

function createApp(user: TestUser, tenantDb: unknown = tenantDbReturning([])) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).tenantDb = tenantDb;
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

describe("DELETE /api/deals/:id — archive deal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // By default the owner-access check passes (owner rep).
    accessMocks.assertDealOwnerAccess.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
      officeId: "office-1",
    });
    // By default the CO check returns a non-CO deal (empty rows) so the route proceeds.
    // Success stub — route calls deleteDeal then 204s.
    dealsServiceMocks.deleteDeal.mockResolvedValue({
      id: "deal-1",
      name: "Test Deal",
      projectNumber: "DFW-1-00001",
      dealNumber: "TR-001",
    });
  });

  // ── Case 1: empty reason ──────────────────────────────────────────────────────

  it("returns 400 DEAL_ARCHIVE_REASON_REQUIRED when reason is an empty string", async () => {
    const app = createApp(createUser("rep"));
    const res = await request(app)
      .delete("/api/deals/deal-1")
      .send({ reason: "" });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("DEAL_ARCHIVE_REASON_REQUIRED");
    // deleteDeal must NOT have been called — the 400 fires before service invocation.
    expect(dealsServiceMocks.deleteDeal).not.toHaveBeenCalled();
  });

  // ── Case 2: missing reason (no body) ─────────────────────────────────────────

  it("returns 400 DEAL_ARCHIVE_REASON_REQUIRED when no body is sent", async () => {
    const app = createApp(createUser("rep"));
    const res = await request(app).delete("/api/deals/deal-1");
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("DEAL_ARCHIVE_REASON_REQUIRED");
    expect(dealsServiceMocks.deleteDeal).not.toHaveBeenCalled();
  });

  // ── Case 3: non-owner → 403 from ownership guard ──────────────────────────────

  it("returns 403 when assertDealOwnerAccess rejects (non-owner rep)", async () => {
    accessMocks.assertDealOwnerAccess.mockRejectedValueOnce(
      new AppError(403, "Only the assigned rep or an admin can delete this deal", "DEAL_ACCESS_FORBIDDEN"),
    );
    const app = createApp(createUser("rep"));
    const res = await request(app)
      .delete("/api/deals/deal-1")
      .send({ reason: "Lost the bid" });
    expect(res.status).toBe(403);
    expect(dealsServiceMocks.deleteDeal).not.toHaveBeenCalled();
  });

  // ── Case 4: owner + valid reason → 204 + deleteDeal called with correct args ──

  it("returns 204 and calls deleteDeal with actorRole and reason for an owner rep with a valid reason", async () => {
    const app = createApp(createUser("rep"));
    const res = await request(app)
      .delete("/api/deals/deal-1")
      .send({ reason: "Lost the bid" });
    expect(res.status).toBe(204);
    expect(dealsServiceMocks.deleteDeal).toHaveBeenCalledWith(
      expect.anything(), // tenantDb
      "deal-1",
      expect.objectContaining({
        actorRole: "rep",
        actorId: "rep-1",
        reason: "Lost the bid",
      }),
    );
  });
});
