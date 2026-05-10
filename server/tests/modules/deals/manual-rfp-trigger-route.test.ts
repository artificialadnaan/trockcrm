import { beforeEach, describe, expect, it, vi } from "vitest";

const getDealByIdMock = vi.hoisted(() => vi.fn());
const evaluateReadinessMock = vi.hoisted(() => vi.fn());
const enqueueRfpMock = vi.hoisted(() => vi.fn());
const inferBidBoardOwnershipMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

vi.mock("../../../src/modules/deals/service.js", () => ({
  BID_BOARD_STAGE_READ_ONLY_MESSAGE: "read only",
  buildBidBoardOwnershipState: vi.fn(),
  getDeals: vi.fn(),
  getDealById: getDealByIdMock,
  getDealDetail: vi.fn(),
  getEstimatingBoundaryStage: vi.fn(),
  getRequiredEstimatingBoundaryStage: vi.fn(),
  isBidBoardOwnedDownstreamStage: vi.fn(),
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  startProposalDraft: vi.fn(),
  deleteDeal: vi.fn(),
  getDealsForPipeline: vi.fn(),
  listDealStagePage: vi.fn(),
  getDealSources: vi.fn(),
  setDealContractSignedDate: vi.fn(),
}));

vi.mock("../../../src/modules/deals/stage-change.js", () => ({
  activateServiceHandoff: vi.fn(),
  changeDealStage: vi.fn(),
}));

vi.mock("../../../src/modules/deals/stage-gate.js", () => ({
  preflightStageCheck: vi.fn(),
}));

vi.mock("../../../src/modules/contacts/association-service.js", () => ({
  getContactsForDeal: vi.fn(),
}));

vi.mock("../../../src/modules/admin/users-service.js", () => ({
  listUsers: vi.fn(),
}));

vi.mock("../../../src/modules/deals/estimate-service.js", () => ({
  getEstimate: vi.fn(),
  createSection: vi.fn(),
  updateSection: vi.fn(),
  deleteSection: vi.fn(),
  createLineItem: vi.fn(),
  updateLineItem: vi.fn(),
  deleteLineItem: vi.fn(),
}));

vi.mock("../../../src/modules/deals/punch-list-service.js", () => ({
  getPunchList: vi.fn(),
  createPunchListItem: vi.fn(),
  updatePunchListItem: vi.fn(),
  deletePunchListItem: vi.fn(),
  completePunchListItem: vi.fn(),
}));

vi.mock("../../../src/modules/deals/timer-service.js", () => ({
  getTimers: vi.fn(),
  createTimer: vi.fn(),
  completeTimer: vi.fn(),
  cancelTimer: vi.fn(),
}));

vi.mock("../../../src/modules/deals/closeout-service.js", () => ({
  getCloseoutChecklist: vi.fn(),
  initializeCloseoutChecklist: vi.fn(),
  toggleChecklistItem: vi.fn(),
  updateChecklistItem: vi.fn(),
}));

vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  evaluateDealScopingReadiness: evaluateReadinessMock,
  getOrCreateDealScopingIntake: vi.fn(),
  linkDealFileToScopingRequirement: vi.fn(),
  routeRevisionToEstimating: vi.fn(),
  upsertDealScopingIntake: vi.fn(),
}));

vi.mock("../../../src/modules/deals/lineage-resolver.js", () => ({
  writeResolvedDealFields: vi.fn(),
}));

vi.mock("../../../src/modules/deals/workflow-backfill.js", () => ({
  inferDealBidBoardOwnership: inferBidBoardOwnershipMock,
}));

vi.mock("../../../src/modules/deals/rfp-enqueue.js", () => ({
  enqueueOpportunityRfpIfNeeded: enqueueRfpMock,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

function findRouteHandler(method: "post", path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  return routeLayer.handle;
}

function makeDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "TR-2026-0001",
    name: "Palm Villas",
    stageId: "stage-opportunity",
    assignedRepId: "rep-1",
    workflowRoute: "normal",
    pipelineTypeSnapshot: null,
    ddEstimate: null,
    bidEstimate: "125000",
    awardedAmount: null,
    sourceLeadId: "lead-1",
    stageEnteredAt: new Date("2026-05-10T12:00:00.000Z"),
    isBidBoardOwned: false,
    bidBoardStageSlug: null,
    bidBoardStageEnteredAt: null,
    bidBoardMirrorSourceEnteredAt: null,
    isReadOnlyMirror: false,
    readOnlySyncedAt: null,
    rfpApprovalRequestedAt: null,
    rfpApprovalStatus: null,
    ...overrides,
  };
}

function makeReq(options: {
  role?: string;
  stageSlug?: string;
  deal?: Record<string, unknown>;
  readinessStatus?: "draft" | "ready" | "activated";
} = {}) {
  const inserted: any[] = [];
  const updated: any[] = [];
  const req = {
    params: { id: "deal-1" },
    tenantDb: {
      execute: vi.fn(async () => ({
        rows: [{ slug: options.stageSlug ?? "opportunity" }],
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value) => {
          inserted.push(value);
          return {};
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value) => {
          updated.push(value);
          return { where: vi.fn(async () => ({})) };
        }),
      })),
    },
    user: {
      id: options.role === "admin" ? "admin-1" : "rep-1",
      role: options.role ?? "rep",
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    commitTransaction: vi.fn(async () => {}),
  } as any;
  getDealByIdMock.mockResolvedValue(makeDeal(options.deal));
  evaluateReadinessMock.mockResolvedValue({
    status: options.readinessStatus ?? "ready",
    errors: { sections: {}, attachments: {} },
  });
  return { req, inserted, updated };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as any;
}

describe("POST /api/deals/:id/trigger-rfp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inferBidBoardOwnershipMock.mockReturnValue({ isBidBoardOwned: false });
    enqueueRfpMock.mockResolvedValue({
      enqueued: true,
      eventId: "11111111-1111-4111-8111-111111111111",
      jobId: 123,
      dealUpdates: {
        rfpApprovalRequestedAt: new Date("2026-05-10T12:30:00.000Z"),
        rfpApprovalRequestEventId: "11111111-1111-4111-8111-111111111111",
        rfpApprovalRequestedBy: "rep-1",
        rfpApprovalStatus: "pending_outbox",
      },
    });
  });

  it("enqueues an RFP request for an assigned rep when Opportunity scope is ready", async () => {
    const { req, inserted, updated } = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      status: "pending_outbox",
      eventId: "11111111-1111-4111-8111-111111111111",
      jobId: 123,
    });
    expect(enqueueRfpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deal: expect.objectContaining({ id: "deal-1" }),
        userId: "rep-1",
        officeId: "office-1",
        transitioningFrom: null,
      })
    );
    expect(updated[0]).toMatchObject({ rfpApprovalStatus: "pending_outbox" });
    expect(inserted[0]).toMatchObject({
      jobType: "domain_event",
      officeId: "office-1",
      status: "pending",
      payload: expect.objectContaining({
        eventName: "deal.opportunity.entered",
        dealId: "deal-1",
        source: "manual_trigger",
      }),
    });
    expect(req.commitTransaction).toHaveBeenCalled();
  });

  it("rejects deals outside Opportunity stage", async () => {
    const { req } = makeReq({ stageSlug: "estimating" });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("RFP_WRONG_STAGE");
    expect(enqueueRfpMock).not.toHaveBeenCalled();
  });

  it("rejects incomplete Opportunity scope", async () => {
    const { req } = makeReq({ readinessStatus: "draft" });
    evaluateReadinessMock.mockResolvedValueOnce({
      status: "draft",
      errors: { sections: { project: ["name"] }, attachments: { rfp: ["Upload RFP"] } },
    });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string; message: string };
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("RFP_SCOPE_INCOMPLETE");
    expect(err.message).toContain("Missing sections: project");
    expect(enqueueRfpMock).not.toHaveBeenCalled();
  });

  it("rejects an already-triggered deal", async () => {
    const { req } = makeReq({
      deal: {
        rfpApprovalRequestedAt: new Date("2026-05-09T12:00:00.000Z"),
        rfpApprovalStatus: "pending",
      },
    });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("RFP_ALREADY_TRIGGERED");
    expect(enqueueRfpMock).not.toHaveBeenCalled();
  });

  it("rejects users who are neither admin nor the assigned rep", async () => {
    const { req } = makeReq({ role: "director" });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("RFP_UNAUTHORIZED");
    expect(enqueueRfpMock).not.toHaveBeenCalled();
  });
});
