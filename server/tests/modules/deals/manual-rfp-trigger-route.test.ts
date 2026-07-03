import { beforeEach, describe, expect, it, vi } from "vitest";

const getDealByIdMock = vi.hoisted(() => vi.fn());
const evaluateReadinessMock = vi.hoisted(() => vi.fn());
const insertRfpJobMock = vi.hoisted(() => vi.fn());
const inferBidBoardOwnershipMock = vi.hoisted(() => vi.fn());
const isRfpEnabledMock = vi.hoisted(() => vi.fn());
const isRfpVotingEnabledMock = vi.hoisted(() => vi.fn(() => false));
const resolveRfpVoterEmailsMock = vi.hoisted(() => vi.fn(() => [] as string[]));
const openRfpVoteRoundMock = vi.hoisted(() => vi.fn());
const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
}));

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
  // rfp-vote-service.js (in the module graph via routes.js) imports these; stub them so a future flag flip
  // in this suite can't hit an undefined enqueue helper.
  enqueueRfpVoteInvitation: vi.fn(),
  enqueueRfpBidBoardCreate: vi.fn(),
  enqueueRfpVoteOutcome: vi.fn(),
}));

vi.mock("../../../src/config/feature-flags.js", () => ({
  isOpportunityRfpEventEnabled: isRfpEnabledMock,
  // Voting defaults OFF (existing SyncHub-path tests); the no-voters-fallback tests flip it on per-case.
  isRfpVotingEnabled: isRfpVotingEnabledMock,
}));

// resolveRfpVoterEmails gates the voting branch (finding #5). Default [] so an accidental voting-enabled path
// still degrades to SyncHub; the voting-branch test overrides it. isRfpVoterEmail is stubbed for the rbac graph.
vi.mock("@trock-crm/shared/lib/rfpVoterEmails", () => ({
  resolveRfpVoterEmails: resolveRfpVoterEmailsMock,
  isRfpVoterEmail: vi.fn(() => false),
}));

// Mock rfp-vote-service so the voting branch is observable without a real round: isServiceRfp mirrors the
// prod predicate for these normal-route deals; openRfpVoteRound is a spy (asserted called / not-called).
// hasSufficientRfpVoters mirrors the real predicate (full RFP_VOTER_COUNT trio, finding F2) off the same
// resolveRfpVoterEmailsMock the tests already drive, so a partial config falls back to SyncHub.
vi.mock("../../../src/modules/deals/rfp-vote-service.js", () => ({
  isServiceRfp: (deal: any) => deal?.workflowRoute === "service",
  openRfpVoteRound: openRfpVoteRoundMock,
  hasSufficientRfpVoters: (env: any) => resolveRfpVoterEmailsMock(env).length >= 3,
  castRfpVote: vi.fn(),
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
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
    // True when the caller bypasses the rep owner-scope on the reservation UPDATE — admins AND directors
    // (the route only owner-scopes reps via updateConditions).
    bypassOwnerScope: false,
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
          (!state.bypassOwnerScope && state.deal.assignedRepId !== "rep-1")
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
  state.bypassOwnerScope = options.role === "admin" || options.role === "director";
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
      id:
        options.role === "admin"
          ? "admin-1"
          : options.role === "director"
            ? "director-1"
            : "rep-1",
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
    isRfpEnabledMock.mockReturnValue(true);
    inferBidBoardOwnershipMock.mockReturnValue({ isBidBoardOwned: false });
    insertRfpJobMock.mockResolvedValue({ jobId: 123 });
    // Voting off + no voters by default; the two fallback tests below override these.
    isRfpVotingEnabledMock.mockReturnValue(false);
    resolveRfpVoterEmailsMock.mockReturnValue([]);
    openRfpVoteRoundMock.mockReset();
    openRfpVoteRoundMock.mockResolvedValue(undefined);
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

  it("does not block attachment-only scoping gaps when triggering RFP", async () => {
    const { req, state } = makeReq({ readinessStatus: "draft" });
    evaluateReadinessMock.mockResolvedValueOnce({
      status: "draft",
      errors: { sections: {}, attachments: { scope_docs: ["scope_docs"], site_photos: ["site_photos"] } },
    });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        status: "pending_outbox",
      })
    );
    expect(state.updatesAttempted).toBe(1);
    expect(insertRfpJobMock).toHaveBeenCalledTimes(1);
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

  it("allows a director to trigger an eligible deal owned by another rep (office-wide), stamping who requested it", async () => {
    const { req, state } = makeReq({ role: "director", deal: { assignedRepId: "rep-2" } });
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(state.updatesAttempted).toBe(1);
    expect(insertRfpJobMock).toHaveBeenCalledTimes(1);
    // Audit trail: the deal records the director (not the owning rep) as the requester.
    expect(state.deal).toMatchObject({
      rfpApprovalStatus: "pending_outbox",
      rfpApprovalRequestedBy: "director-1",
    });
  });

  it("rejects a rep who owns no claim to the deal with the trigger-specific unauthorized code", async () => {
    const { req } = makeReq({ role: "rep", deal: { assignedRepId: "rep-2" } });
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

  it("voting ENABLED but NO voters configured falls back to the SyncHub path (no vote round opened)", async () => {
    // [#5] With RFP_VOTER_EMAILS unset, resolveRfpVoterEmails() is empty in prod. Opening a round would
    // strand the deal (nobody can cast, can't return to Opportunity), so a misconfigured flag must degrade
    // to the existing SyncHub delivery instead of opening an unreachable vote round.
    isRfpVotingEnabledMock.mockReturnValue(true);
    resolveRfpVoterEmailsMock.mockReturnValue([]);
    const { req, state } = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: "pending_outbox" });
    // Fell through to SyncHub: the reserve UPDATE ran + a delivery job was inserted; NO vote round opened.
    expect(openRfpVoteRoundMock).not.toHaveBeenCalled();
    expect(insertRfpJobMock).toHaveBeenCalledTimes(1);
    expect(state.updatesAttempted).toBe(1);
  });

  it("voting ENABLED with a PARTIAL voter list (< the trio) falls back to SyncHub (finding F2)", async () => {
    // A dropped-comma typo leaves < RFP_VOTER_COUNT voters: the 2-of-3 tally is unreachable, so the round would
    // strand 'pending'. Must degrade to SyncHub instead of opening an undecidable round.
    isRfpVotingEnabledMock.mockReturnValue(true);
    resolveRfpVoterEmailsMock.mockReturnValue(["sidney@x.com", "tim@x.com"]);
    const { req, state } = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: "pending_outbox" });
    expect(openRfpVoteRoundMock).not.toHaveBeenCalled();
    expect(insertRfpJobMock).toHaveBeenCalledTimes(1);
    expect(state.updatesAttempted).toBe(1);
  });

  it("voting ENABLED WITH the full trio configured opens a vote round (no SyncHub delivery)", async () => {
    isRfpVotingEnabledMock.mockReturnValue(true);
    resolveRfpVoterEmailsMock.mockReturnValue(["sidney@x.com", "tim@x.com", "james@x.com"]);
    const { req, state } = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await findRouteHandler("post", "/:id/trigger-rfp")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, mode: "vote" });
    expect(openRfpVoteRoundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        officeId: "office-1",
        requestedByUserId: "rep-1",
        deal: expect.objectContaining({ id: "deal-1" }),
        // finding F3: a rep-triggered round re-binds ownership in the reserve.
        enforceAssignedRepId: "rep-1",
      })
    );
    // Voting branch does NOT run the SyncHub reserve/enqueue.
    expect(insertRfpJobMock).not.toHaveBeenCalled();
    expect(state.updatesAttempted).toBe(0);
  });
});
