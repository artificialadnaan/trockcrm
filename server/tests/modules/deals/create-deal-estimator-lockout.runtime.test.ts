import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Gate-executed (`*.runtime.test.ts`) sibling of the per-deal estimator access gate: estimator is a
// commission-attribution field writable ONLY through the dedicated, leadership-gated PATCH /:id/estimator
// route. This proves the create path (POST /deals) is a STRICT no-write path for estimator — the route
// strips estimatorUserId/estimatorUserName out of the forwarded `...rest`, so createDeal never receives
// them, even though the client WritableDealFields Omit already type-bars them. Defense in depth: a raw
// HTTP client (no client types) cannot smuggle estimator in at create.
const dealsServiceMocks = vi.hoisted(() => ({
  createDeal: vi.fn(),
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
    createDeal: dealsServiceMocks.createDeal,
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

function createApp() {
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
    (req as any).officeSlug = "dallas";
    (req as any).tenantDb = {};
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

describe("POST /api/deals — estimator create-side lockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealsServiceMocks.createDeal.mockResolvedValue({
      id: "deal-1",
      name: "Created",
      officeCode: "dfw",
      hubspotDealId: null,
    });
  });

  it.each([
    { label: "estimatorUserId only", payload: { estimatorUserId: "11111111-1111-4111-8111-111111111111" } },
    {
      label: "estimatorUserId + estimatorUserName",
      payload: {
        estimatorUserId: "11111111-1111-4111-8111-111111111111",
        estimatorUserName: "Smuggled Estimator",
      },
    },
  ])("strips smuggled estimator fields ($label) before forwarding to createDeal", async ({ payload }) => {
    const res = await request(createApp())
      .post("/api/deals")
      .send({
        name: "SMOKE TEST DELETE create-estimator-lockout",
        stageId: "stage-opportunity",
        assignedRepId: "rep-1",
        ...payload,
      });

    expect(res.status).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledTimes(1);
    const forwarded = dealsServiceMocks.createDeal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("estimatorUserId");
    expect(forwarded).not.toHaveProperty("estimatorUserName");
    // The allowlisted fields still flow through, so the strip is surgical (not a wholesale drop).
    expect(forwarded).toMatchObject({ name: "SMOKE TEST DELETE create-estimator-lockout", stageId: "stage-opportunity" });
  });
});
