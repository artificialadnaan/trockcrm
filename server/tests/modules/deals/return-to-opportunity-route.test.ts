// Route-level wiring for "Move back to Opportunity": RBAC, the required reason, the acknowledged
// commission total pass-through, and the copilot refresh. The DESTRUCTIVE behaviour itself (what the
// detach clears, the commission void, the audit trail) is proven against real SQL in
// return-to-opportunity.runtime.test.ts; this file only proves the route hands the right things to it
// and refuses the wrong callers before it ever gets there.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  previewReturnToOpportunity: vi.fn(),
  returnDealToOpportunity: vi.fn(),
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

vi.mock("../../../src/modules/deals/return-to-opportunity-service.js", () => ({
  previewReturnToOpportunity: serviceMocks.previewReturnToOpportunity,
  returnDealToOpportunity: serviceMocks.returnDealToOpportunity,
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

type Role = "admin" | "director" | "rep";

const insertedJobs: unknown[] = [];

function createApp(role: Role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: `${role}-1`,
      role,
      displayName: `${role} user`,
      email: `${role}@example.com`,
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    (req as any).tenantDb = {
      insert: () => ({
        values: async (rows: unknown) => {
          insertedJobs.push(rows);
        },
      }),
    };
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedJobs.length = 0;
  accessMocks.assertDealOwnerAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "rep-1" });
  accessMocks.assertDealCollaboratorAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "rep-1" });
  serviceMocks.returnDealToOpportunity.mockResolvedValue({
    deal: { id: "deal-1", name: "Palm Villas", hubspotDealId: null },
    stageChange: { stageHistory: { id: "hist-1" }, _eventsToEmit: [] },
    commissionRowsVoided: 0,
    commissionTotalVoided: "0",
    contractSignedDateCleared: null,
    wasBidBoardLinked: true,
    _eventsToEmit: [],
  });
  serviceMocks.previewReturnToOpportunity.mockResolvedValue({
    dealId: "deal-1",
    dealName: "Palm Villas",
    allowed: true,
    commissionTotal: "0",
    commissionRowCount: 0,
  });
});

describe("POST /api/deals/:id/return-to-opportunity — RBAC", () => {
  it("403s a rep before the service is ever reached", async () => {
    const response = await request(createApp("rep"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "not ready" });

    expect(response.status).toBe(403);
    expect(serviceMocks.returnDealToOpportunity).not.toHaveBeenCalled();
  });

  it("allows a director (the service then narrows the commission-voiding case to admin)", async () => {
    const response = await request(createApp("director"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "needs re-scoping" });

    expect(response.status).toBe(200);
    expect(serviceMocks.returnDealToOpportunity).toHaveBeenCalledTimes(1);
    expect(serviceMocks.returnDealToOpportunity.mock.calls[0][1]).toMatchObject({
      dealId: "deal-1",
      userId: "director-1",
      userRole: "director",
      reason: "needs re-scoping",
    });
  });

  it("allows an admin", async () => {
    const response = await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "award rescinded", acknowledgedCommissionTotal: "12340.50" });

    expect(response.status).toBe(200);
    expect(serviceMocks.returnDealToOpportunity.mock.calls[0][1]).toMatchObject({
      acknowledgedCommissionTotal: "12340.50",
    });
  });
});

describe("POST /api/deals/:id/return-to-opportunity — input handling", () => {
  it("400s an empty/whitespace reason without touching the service", async () => {
    const response = await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "   " });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("MOVE_BACK_REASON_REQUIRED");
    expect(serviceMocks.returnDealToOpportunity).not.toHaveBeenCalled();
  });

  it("400s a missing reason", async () => {
    const response = await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({});
    expect(response.status).toBe(400);
  });

  it("normalizes a numeric acknowledged total to a string so the server-side compare is like-for-like", async () => {
    await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "x", acknowledgedCommissionTotal: 12340.5 });

    expect(serviceMocks.returnDealToOpportunity.mock.calls[0][1].acknowledgedCommissionTotal).toBe("12340.5");
  });

  it("passes the acknowledged ROW COUNT through, and nulls a non-integer rather than guessing", async () => {
    await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "x", acknowledgedCommissionTotal: "1.00", acknowledgedCommissionRowCount: "2" });
    expect(serviceMocks.returnDealToOpportunity.mock.calls[0][1].acknowledgedCommissionRowCount).toBe(2);

    serviceMocks.returnDealToOpportunity.mockClear();
    await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "x", acknowledgedCommissionTotal: "1.00", acknowledgedCommissionRowCount: "two" });
    // Null, not NaN or 0 — the service must refuse an unparseable acknowledgement, not treat it as "0 rows".
    expect(serviceMocks.returnDealToOpportunity.mock.calls[0][1].acknowledgedCommissionRowCount).toBeNull();
  });

  it("returns the void summary so the client can word its toast accurately", async () => {
    serviceMocks.returnDealToOpportunity.mockResolvedValueOnce({
      deal: { id: "deal-1", name: "Palm Villas", hubspotDealId: null },
      stageChange: { stageHistory: null, _eventsToEmit: [] },
      commissionRowsVoided: 2,
      commissionTotalVoided: "26250.00",
      contractSignedDateCleared: "2026-03-01",
      wasBidBoardLinked: true,
      _eventsToEmit: [],
    });

    const response = await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "award rescinded", acknowledgedCommissionTotal: "26250.00" });

    expect(response.body).toMatchObject({
      commissionRowsVoided: 2,
      commissionTotalVoided: "26250.00",
      contractSignedDateCleared: "2026-03-01",
      wasBidBoardLinked: true,
    });
  });

  // The dialog branches on the STATUS: a 403 is "you may not", a 409 is "the state moved under you,
  // re-read the amount and try again". That contract only holds if AppError's statusCode and code
  // survive errorHandler untouched, so pin both shapes here rather than assuming it.
  it.each([
    {
      label: "the acknowledged commission total no longer matches",
      statusCode: 409,
      code: "MOVE_BACK_COMMISSION_ACK_REQUIRED",
    },
    {
      label: "a commission row appeared after the acknowledgement",
      statusCode: 409,
      code: "MOVE_BACK_COMMISSION_CHANGED",
    },
    {
      label: "a director tried the commission-voiding variant",
      statusCode: 403,
      code: "MOVE_BACK_COMMISSION_ROLE_NOT_ALLOWED",
    },
  ])("propagates the service's $statusCode/$code when $label", async ({ statusCode, code }) => {
    const { AppError } = await import("../../../src/middleware/error-handler.js");
    serviceMocks.returnDealToOpportunity.mockRejectedValueOnce(
      new AppError(statusCode, "nope", code)
    );

    const response = await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "x", acknowledgedCommissionTotal: "1.00" });

    expect(response.status).toBe(statusCode);
    expect(response.body.error.code).toBe(code);
    // A failed move must not leave the copilot refresh enqueued as if it had happened.
    expect(insertedJobs).toHaveLength(0);
  });

  it("enqueues the copilot refresh, like the ordinary stage change does", async () => {
    await request(createApp("admin"))
      .post("/api/deals/deal-1/return-to-opportunity")
      .send({ reason: "x" });

    expect(insertedJobs).toHaveLength(1);
    expect(insertedJobs[0]).toMatchObject({
      jobType: "ai_refresh_copilot",
      payload: { dealId: "deal-1", reason: "deal_returned_to_opportunity" },
    });
  });
});

describe("GET /api/deals/:id/return-to-opportunity/preview — RBAC", () => {
  it("403s a rep", async () => {
    const response = await request(createApp("rep")).get(
      "/api/deals/deal-1/return-to-opportunity/preview"
    );
    expect(response.status).toBe(403);
    expect(serviceMocks.previewReturnToOpportunity).not.toHaveBeenCalled();
  });

  it("serves the preview to a director so the dialog can explain an admin-only block", async () => {
    const response = await request(createApp("director")).get(
      "/api/deals/deal-1/return-to-opportunity/preview"
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ dealId: "deal-1", allowed: true });
    expect(serviceMocks.previewReturnToOpportunity.mock.calls[0][1]).toMatchObject({
      dealId: "deal-1",
      userRole: "director",
    });
  });
});
