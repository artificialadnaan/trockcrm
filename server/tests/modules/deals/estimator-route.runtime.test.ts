import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors contract-signed-date-route.test.ts: the deals service is mocked so the route
// can be exercised in isolation, but `vi.importActual` is spread first so every OTHER
// export (notably the REAL `updateDeal`) is preserved for the generic-path lockout test.
const dealsServiceMocks = vi.hoisted(() => ({
  setDealEstimator: vi.fn(),
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
    setDealEstimator: dealsServiceMocks.setDealEstimator,
  };
});

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler, AppError } = await import("../../../src/middleware/error-handler.js");
const { updateDeal } = await import("../../../src/modules/deals/service.js");

type Role = "admin" | "director" | "rep" | "construction" | "field_contractor";

type TestUser = {
  id: string;
  role: Role;
  displayName: string;
  email: string;
  officeId: string;
  activeOfficeId: string;
};

function createUser(role: Role): TestUser {
  return {
    id: `${role}-1`,
    role,
    displayName: `${role} user`,
    email: `${role}@example.com`,
    officeId: "office-1",
    activeOfficeId: "office-1",
  };
}

function createApp(user: TestUser | null) {
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

const ESTIMATOR_ID = "11111111-1111-4111-8111-111111111111";

describe("PATCH /api/deals/:id/estimator — RBAC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealsServiceMocks.setDealEstimator.mockReset();
    dealsServiceMocks.setDealEstimator.mockResolvedValue({
      id: "deal-1",
      estimatorUserId: ESTIMATOR_ID,
    });
  });

  it("admin can set the estimator (200) and forwards the parsed args", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: ESTIMATOR_ID });
    expect(res.status).toBe(200);
    expect(res.body.deal.estimatorUserId).toBe(ESTIMATOR_ID);
    expect(dealsServiceMocks.setDealEstimator).toHaveBeenCalledWith(
      expect.any(Object),
      "deal-1",
      ESTIMATOR_ID,
      "admin-1",
      "office-1"
    );
  });

  it("director can set the estimator (200)", async () => {
    const app = createApp(createUser("director"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: ESTIMATOR_ID });
    expect(res.status).toBe(200);
    expect(dealsServiceMocks.setDealEstimator).toHaveBeenCalled();
  });

  // rep / construction / field_contractor are the non-leadership roles; none may touch
  // the estimator (it changes commission attribution).
  it.each<Role>(["rep", "construction", "field_contractor"])(
    "%s gets 403 and never reaches the service",
    async (role) => {
      const app = createApp(createUser(role));
      const res = await request(app)
        .patch("/api/deals/deal-1/estimator")
        .send({ estimatorUserId: ESTIMATOR_ID });
      expect(res.status).toBe(403);
      expect(dealsServiceMocks.setDealEstimator).not.toHaveBeenCalled();
    }
  );

  it("unauthenticated request gets 401", async () => {
    const app = createApp(null);
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: ESTIMATOR_ID });
    expect(res.status).toBe(401);
    expect(dealsServiceMocks.setDealEstimator).not.toHaveBeenCalled();
  });

  it("accepts null to clear the estimator (200)", async () => {
    dealsServiceMocks.setDealEstimator.mockResolvedValue({
      id: "deal-1",
      estimatorUserId: null,
    });
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: null });
    expect(res.status).toBe(200);
    expect(dealsServiceMocks.setDealEstimator).toHaveBeenCalledWith(
      expect.any(Object),
      "deal-1",
      null,
      "admin-1",
      "office-1"
    );
  });

  it("rejects a non-uuid estimatorUserId with 422 and never reaches the service", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: "not-a-uuid" });
    expect(res.status).toBe(422);
    expect(dealsServiceMocks.setDealEstimator).not.toHaveBeenCalled();
  });

  // FINDING 3: an OMITTED estimatorUserId key must NOT be treated as an explicit null/clear. A `{}`
  // body (or any body without the key) is a client bug, so it must 422 and NEVER reach the service —
  // otherwise a stray request would silently wipe the deal's estimator (and its commission row).
  it("rejects an empty {} body with 422 and never clears the estimator", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({});
    expect(res.status).toBe(422);
    expect(dealsServiceMocks.setDealEstimator).not.toHaveBeenCalled();
  });

  it("rejects a body that omits estimatorUserId (other keys present) with 422", async () => {
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ somethingElse: "x" });
    expect(res.status).toBe(422);
    expect(dealsServiceMocks.setDealEstimator).not.toHaveBeenCalled();
  });

  // The explicit-null clear path stays intact alongside the absent-key rejection above.
  it("still clears on an EXPLICIT estimatorUserId: null (200) — distinct from an omitted key", async () => {
    dealsServiceMocks.setDealEstimator.mockResolvedValue({ id: "deal-1", estimatorUserId: null });
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: null });
    expect(res.status).toBe(200);
    expect(dealsServiceMocks.setDealEstimator).toHaveBeenCalledWith(
      expect.any(Object),
      "deal-1",
      null,
      "admin-1",
      "office-1"
    );
  });

  it("maps the service 409 CHANGE_ORDER_FIELD_LOCKED through", async () => {
    dealsServiceMocks.setDealEstimator.mockRejectedValueOnce(
      new AppError(
        409,
        "A change order's estimator is inherited from the parent deal, not editable here.",
        "CHANGE_ORDER_FIELD_LOCKED"
      )
    );
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: ESTIMATOR_ID });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CHANGE_ORDER_FIELD_LOCKED");
  });

  it("returns 404 when the deal does not exist", async () => {
    dealsServiceMocks.setDealEstimator.mockResolvedValueOnce(null);
    const app = createApp(createUser("admin"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: ESTIMATOR_ID });
    expect(res.status).toBe(404);
    expect(dealsServiceMocks.setDealEstimator).toHaveBeenCalled();
  });
});

// The per-deal access gate: requireRole proves leadership in the abstract; this binds it to THIS deal's
// office/scope. Estimator is a commission-attribution mutation, so — like PATCH /:id and the change-order
// routes — the route must assert the caller can reach the deal before any read or write, for every
// request shape (set / no-op / explicit null-clear). assertDealCollaboratorAccess is mocked here (it has
// its own tests); these prove the route DELEGATES to it and rejects when it rejects.
describe("PATCH /api/deals/:id/estimator — per-deal access gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealsServiceMocks.setDealEstimator.mockReset();
    dealsServiceMocks.setDealEstimator.mockResolvedValue({
      id: "deal-1",
      estimatorUserId: ESTIMATOR_ID,
    });
  });

  it("asserts access for THIS deal before the service runs (within scope → allowed)", async () => {
    const app = createApp(createUser("director"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: ESTIMATOR_ID });
    expect(res.status).toBe(200);
    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledWith(
      expect.any(Object),
      "deal-1",
      expect.objectContaining({ id: "director-1", role: "director" })
    );
    // The gate must run BEFORE the mutation, never after.
    const gateOrder = accessMocks.assertDealCollaboratorAccess.mock.invocationCallOrder[0];
    const serviceOrder = dealsServiceMocks.setDealEstimator.mock.invocationCallOrder[0];
    expect(gateOrder).toBeLessThan(serviceOrder);
  });

  // A director acting on a deal OUTSIDE their accessible scope is rejected for EVERY shape — including
  // the null-CLEAR path, which inside the service skips the new-estimator office validation entirely.
  it.each([
    { label: "set", body: { estimatorUserId: ESTIMATOR_ID } as Record<string, unknown> },
    { label: "null-clear", body: { estimatorUserId: null } as Record<string, unknown> },
  ])(
    "rejects a director outside the deal's office with 403 ($label) and never reaches the service",
    async ({ body }) => {
      accessMocks.assertDealCollaboratorAccess.mockRejectedValueOnce(
        new AppError(403, "Access denied: deal is outside your office.")
      );
      const app = createApp(createUser("director"));
      const res = await request(app).patch("/api/deals/deal-1/estimator").send(body);
      expect(res.status).toBe(403);
      expect(dealsServiceMocks.setDealEstimator).not.toHaveBeenCalled();
    }
  );

  it("returns 404 from the access gate when the deal is not in the caller's scope and never reaches the service", async () => {
    accessMocks.assertDealCollaboratorAccess.mockRejectedValueOnce(
      new AppError(404, "Deal not found")
    );
    const app = createApp(createUser("director"));
    const res = await request(app)
      .patch("/api/deals/deal-1/estimator")
      .send({ estimatorUserId: ESTIMATOR_ID });
    expect(res.status).toBe(404);
    expect(dealsServiceMocks.setDealEstimator).not.toHaveBeenCalled();
  });
});

// The load-bearing guarantee: estimator is intentionally OUT of updateDeal's allowlist, so a
// caller cannot smuggle estimatorUserId through the generic PATCH /deals/:id (which the assigned
// rep can reach) — that would leak rep-level access to a commission-attribution field. This drives
// the REAL updateDeal with a capture-only fake db and asserts the persisted `.set()` excludes it.
describe("generic PATCH /deals/:id — estimator allowlist lockout", () => {
  function makeCaptureDb(
    existing: Record<string, unknown>,
    captured: { set?: Record<string, unknown> }
  ) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [existing],
            }),
          }),
        }),
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          captured.set = vals;
          return {
            where: () => ({
              returning: async () => [{ ...existing, ...vals }],
            }),
          };
        },
      }),
    };
  }

  it("updateDeal drops a smuggled estimatorUserId while writing the allowlisted field", async () => {
    const existing = {
      id: "deal-1",
      isChangeOrder: false,
      assignedRepId: "rep-1",
      estimatorUserId: "00000000-0000-4000-8000-000000000000",
      officeCode: "dfw",
      sourceLeadId: null,
      companyId: "company-1",
      propertyId: "property-1",
      awardedAmount: null,
      onHold: false,
      isBidBoardOwned: false,
      name: "Original",
    };
    const captured: { set?: Record<string, unknown> } = {};
    const fakeDb = makeCaptureDb(existing, captured);

    const result = await updateDeal(
      fakeDb as unknown as Parameters<typeof updateDeal>[0],
      "deal-1",
      { name: "Renamed", estimatorUserId: ESTIMATOR_ID } as unknown as Parameters<typeof updateDeal>[2],
      "admin",
      "admin-1",
      "office-1"
    );

    expect(captured.set).toBeDefined();
    expect(captured.set).toHaveProperty("name", "Renamed");
    expect(captured.set).not.toHaveProperty("estimatorUserId");
    // The persisted row keeps the original estimator untouched.
    expect((result as { estimatorUserId?: string }).estimatorUserId).toBe(
      "00000000-0000-4000-8000-000000000000"
    );
  });
});
