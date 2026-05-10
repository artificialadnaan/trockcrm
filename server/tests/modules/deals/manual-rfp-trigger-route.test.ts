import { beforeEach, describe, expect, it, vi } from "vitest";

const getDealByIdMock = vi.hoisted(() => vi.fn());
const evaluateReadinessMock = vi.hoisted(() => vi.fn());
const insertRfpJobMock = vi.hoisted(() => vi.fn());
const inferBidBoardOwnershipMock = vi.hoisted(() => vi.fn());
const isRfpEnabledMock = vi.hoisted(() => vi.fn());

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
  insertOpportunityRfpRequestJob: insertRfpJobMock,
}));

vi.mock("../../../src/config/feature-flags.js", () => ({
  isOpportunityRfpEventEnabled: isRfpEnabledMock,
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

function createRouteState(deal = makeDeal()) {
  return {
    deal,
    inserted: [] as any[],
    updatesAttempted: 0,
    adminOverride: false,
    beforeUpdate: null as null | (() => void),
  };
}

function makeSelectBuilder(state: ReturnType<typeof createRouteState>) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => state.deal ? [state.deal] : []),
      })),
    })),
  };
}

function makeUpdateBuilder(state: ReturnType<typeof createRouteState>, values: Record<string, unknown>) {
  return {
    where: vi.fn(() => ({
      returning: vi.fn(async () => {
        state.updatesAttempted += 1;
        if (state.beforeUpdate) {
          const beforeUpdate = state.beforeUpdate;
          state.beforeUpdate = null;
          beforeUpdate();
        }
        if (
          !state.deal ||
          state.deal.stageId !== "stage-opportunity" ||
          state.deal.rfpApprovalStatus != null ||
          state.deal.rfpApprovalRequestedAt != null ||
          state.deal.isBidBoardOwned === true ||
          Boolean(state.deal.bidBoardStageSlug) ||
          state.deal.isReadOnlyMirror === true ||
          state.deal.readOnlySyncedAt != null ||
          state.deal.bidBoardStageEnteredAt != null ||
          state.deal.bidBoardMirrorSourceEnteredAt != null ||
          (!state.adminOverride && state.deal.assignedRepId !== "rep-1")
        ) {
          return [];
        }

        state.deal = {
          ...state.deal,
          ...values,
        };
        return [state.deal];
      }),
    })),
  };
}

function makeReq(options: {
  role?: string;
  stageSlug?: string;
  deal?: Record<string, unknown>;
  readinessStatus?: "draft" | "ready" | "activated";
  state?: ReturnType<typeof createRouteState>;
} = {}) {
  const state = options.state ?? createRouteState(makeDeal(options.deal));
  state.adminOverride = options.role === "admin";
  const req = {
    params: { id: "deal-1" },
    tenantDb: {
      execute: vi.fn(async () => ({
        rows: [{
          slug:
            options.stageSlug ??
            (state.deal?.stageId === "stage-estimating" ? "estimating" : "opportunity"),
        }],
      })),
      select: vi.fn(() => makeSelectBuilder(state)),
      insert: vi.fn(() => ({
        values: vi.fn(async (value) => {
          state.inserted.push(value);
          return {};
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value) => {
          return makeUpdateBuilder(state, value);
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
  evaluateReadinessMock.mockResolvedValue({
    status: options.readinessStatus ?? "ready",
    errors: { sections: {}, attachments: {} },
  });
  return { req, state };
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
    isRfpEnabledMock.mockReturnValue(true);
    inferBidBoardOwnershipMock.mockReturnValue({ isBidBoardOwned: false });
    insertRfpJobMock.mockResolvedValue({ jobId: 123 });
  });

  it("enqueues an RFP request for an assigned rep when Opportunity scope is ready", async () => {
    const { req, state } = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      status: "pending_outbox",
      eventId: expect.any(String),
      jobId: 123,
    });
    expect(insertRfpJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deal: expect.objectContaining({ id: "deal-1" }),
        officeId: "office-1",
      })
    );
    expect(state.deal).toMatchObject({ rfpApprovalStatus: "pending_outbox" });
    expect(state.updatesAttempted).toBe(1);
    expect(state.inserted[0]).toMatchObject({
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
    expect(insertRfpJobMock).not.toHaveBeenCalled();
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
    expect(insertRfpJobMock).not.toHaveBeenCalled();
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
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("RFP_ALREADY_TRIGGERED");
    expect(insertRfpJobMock).not.toHaveBeenCalled();
  });

  it("rejects a non-assigned rep with the trigger-specific unauthorized code", async () => {
    const { req } = makeReq({ deal: { assignedRepId: "rep-2" } });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("RFP_UNAUTHORIZED");
    expect(insertRfpJobMock).not.toHaveBeenCalled();
  });

  it("rejects users who are neither admin nor the assigned rep", async () => {
    const { req } = makeReq({ role: "director" });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("RFP_UNAUTHORIZED");
    expect(insertRfpJobMock).not.toHaveBeenCalled();
  });

  it("returns feature-disabled before reserving or enqueueing", async () => {
    isRfpEnabledMock.mockReturnValue(false);
    const { req, state } = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("RFP_EVENT_DISABLED");
    expect(state.updatesAttempted).toBe(0);
    expect(insertRfpJobMock).not.toHaveBeenCalled();
  });

  it("allows admins to trigger eligible deals without assigned-rep guard", async () => {
    const { req, state } = makeReq({ role: "admin", deal: { assignedRepId: "rep-2" } });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(state.updatesAttempted).toBe(1);
    expect(insertRfpJobMock).toHaveBeenCalledTimes(1);
  });

  it("only enqueues once when two trigger requests race", async () => {
    const state = createRouteState();
    const first = makeReq({ state });
    const second = makeReq({ state });
    const firstRes = makeRes();
    const secondRes = makeRes();
    const firstNext = vi.fn();
    const secondNext = vi.fn();
    const handler = findRouteHandler("post", "/:id/trigger-rfp");

    await Promise.all([
      handler(first.req, firstRes, firstNext),
      handler(second.req, secondRes, secondNext),
    ]);

    const statuses = [firstRes.statusCode, secondRes.statusCode];
    const errors = [...firstNext.mock.calls, ...secondNext.mock.calls].map((call) => call[0]);
    expect(statuses).toContain(200);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ statusCode: 409, code: "RFP_ALREADY_TRIGGERED" });
    expect(insertRfpJobMock).toHaveBeenCalledTimes(1);
    expect(state.inserted.filter((job) => job.jobType === "domain_event")).toHaveLength(1);
  });

  it("returns a stage mismatch conflict if the deal leaves Opportunity before reservation", async () => {
    const state = createRouteState();
    state.beforeUpdate = () => {
      state.deal = { ...state.deal, stageId: "stage-estimating" };
    };
    const { req } = makeReq({ state });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("RFP_STAGE_MISMATCH");
    expect(insertRfpJobMock).not.toHaveBeenCalled();
  });

  it("returns a handoff conflict if Bid Board ownership lands before reservation", async () => {
    const state = createRouteState();
    state.beforeUpdate = () => {
      state.deal = { ...state.deal, isBidBoardOwned: true };
    };
    const { req } = makeReq({ state });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("RFP_ALREADY_HANDED_OFF");
    expect(insertRfpJobMock).not.toHaveBeenCalled();
  });

  it("returns a handoff conflict if inferred Bid Board mirror fields land before reservation", async () => {
    inferBidBoardOwnershipMock.mockImplementation((input: { bidBoardStageSlug?: string | null }) => ({
      isBidBoardOwned: Boolean(input.bidBoardStageSlug),
    }));
    const state = createRouteState();
    state.beforeUpdate = () => {
      state.deal = { ...state.deal, bidBoardStageSlug: "estimate_in_progress" };
    };
    const { req } = makeReq({ state });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string };
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("RFP_ALREADY_HANDED_OFF");
    expect(insertRfpJobMock).not.toHaveBeenCalled();
  });

  it("rechecks readiness after reservation and rolls back before enqueueing if scope regresses", async () => {
    const { req, state } = makeReq();
    evaluateReadinessMock
      .mockResolvedValueOnce({
        status: "ready",
        errors: { sections: {}, attachments: {} },
      })
      .mockResolvedValueOnce({
        status: "draft",
        errors: { sections: { project: ["name"] }, attachments: {} },
      });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string; message: string };
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("RFP_SCOPE_INCOMPLETE");
    expect(err.message).toContain("Missing sections: project");
    expect(state.updatesAttempted).toBe(1);
    expect(insertRfpJobMock).not.toHaveBeenCalled();
    expect(req.commitTransaction).not.toHaveBeenCalled();
  });
});
