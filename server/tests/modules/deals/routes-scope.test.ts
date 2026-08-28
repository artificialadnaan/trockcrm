import { beforeEach, describe, expect, it, vi } from "vitest";

const dealServiceMocks = vi.hoisted(() => ({
  getDeals: vi.fn(),
  getDealsForPipeline: vi.fn(),
  listDealStagePage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "mine"),
}));

vi.mock("../../../src/modules/deals/service.js", () => ({
  BID_BOARD_STAGE_READ_ONLY_MESSAGE: "read only",
  buildBidBoardOwnershipState: vi.fn(),
  getDeals: dealServiceMocks.getDeals,
  getDealsForPipeline: dealServiceMocks.getDealsForPipeline,
  getDealById: vi.fn(),
  getDealDetail: vi.fn(),
  getEstimatingBoundaryStage: vi.fn(),
  getRequiredEstimatingBoundaryStage: vi.fn(),
  isBidBoardOwnedDownstreamStage: vi.fn(),
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  startProposalDraft: vi.fn(),
  deleteDeal: vi.fn(),
  listDealStagePage: dealServiceMocks.listDealStagePage,
  getDealSources: vi.fn(),
  setDealContractSignedDate: vi.fn(),
}));

vi.mock("../../../src/modules/deals/stage-change.js", () => ({
  activateServiceHandoff: vi.fn(),
  changeDealStage: vi.fn(),
}));
vi.mock("../../../src/modules/deals/stage-gate.js", () => ({ preflightStageCheck: vi.fn() }));
vi.mock("../../../src/modules/contacts/association-service.js", () => ({ getContactsForDeal: vi.fn() }));
vi.mock("../../../src/modules/admin/users-service.js", () => ({ listUsers: vi.fn() }));
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
  evaluateDealScopingReadiness: vi.fn(),
  getOrCreateDealScopingIntake: vi.fn(),
  linkDealFileToScopingRequirement: vi.fn(),
  routeRevisionToEstimating: vi.fn(),
  upsertDealScopingIntake: vi.fn(),
}));
vi.mock("../../../src/modules/deals/lineage-resolver.js", () => ({ writeResolvedDealFields: vi.fn() }));
vi.mock("../../../src/modules/deals/workflow-backfill.js", () => ({ inferDealBidBoardOwnership: vi.fn() }));
vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));
vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

function findRouteHandler(method: "get", path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.find((entry: any) => entry.method === method).handle;
}

async function invokeRoute(
  path: string,
  query: Record<string, string> = {},
  options: { params?: Record<string, string>; user?: Partial<{ id: string; role: string }> } = {}
) {
  const handler = findRouteHandler("get", path);
  const req = {
    params: options.params ?? {},
    query,
    tenantDb: {},
    user: {
      id: options.user?.id ?? "director-1",
      role: options.user?.role ?? "director",
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    commitTransaction: vi.fn(async () => {}),
  } as any;
  const res = {
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

  await handler(req, res, (err?: unknown) => {
    if (err) throw err;
  });

  return { req, res };
}

describe("deal routes scope defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealServiceMocks.getDeals.mockResolvedValue({
      deals: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
    });
    dealServiceMocks.getDealsForPipeline.mockResolvedValue({
      pipelineColumns: [],
      terminalStages: [],
    });
    dealServiceMocks.listDealStagePage.mockResolvedValue({
      rows: [],
      summary: {},
      pagination: {},
    });
  });

  it("defaults GET /api/deals to mine scope when scope is missing", async () => {
    const { req } = await invokeRoute("/");
    expect(dealServiceMocks.getDeals).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({ scope: "mine" }),
      "director",
      "director-1",
      "director"
    );
  });

  it("forwards the Pending RFP list-bucket flag to getDeals", async () => {
    const { req } = await invokeRoute("/", { pendingRfpOnly: "true", stageIds: "stage-estimating" });
    expect(dealServiceMocks.getDeals).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({ pendingRfpOnly: true, stageIds: ["stage-estimating"] }),
      "director",
      "director-1",
      "director"
    );
  });

  it("defaults GET /api/deals/pipeline to mine scope when scope is missing", async () => {
    const { req } = await invokeRoute("/pipeline", { includeDd: "true" });
    expect(dealServiceMocks.getDealsForPipeline).toHaveBeenCalledWith(
      req.tenantDb,
      "director",
      "director-1",
      expect.objectContaining({ scope: "mine", includeDd: true }),
      "director"
    );
  });

  it("forwards the board's search term to the service", async () => {
    // Without this the term never leaves the browser and the board falls back to filtering the card
    // slice it already holds — the 0/0 regression. The >= 2 char guard lives in the service, so the
    // route's job is only to hand the raw term over.
    const { req } = await invokeRoute("/pipeline", { includeDd: "true", search: "bellemont" });
    expect(dealServiceMocks.getDealsForPipeline).toHaveBeenCalledWith(
      req.tenantDb,
      "director",
      "director-1",
      expect.objectContaining({ search: "bellemont" }),
      "director"
    );
  });

  it("rejects a repeated ?search with a 400 instead of throwing a 500 downstream", async () => {
    // Express aggregates a repeated key into an array, and the service's `.trim()` on an array throws a
    // TypeError that surfaces as an opaque 500. readOptionalStringParam answers with a named 400.
    await expect(
      invokeRoute("/pipeline", { includeDd: "true", search: ["a", "b"] as unknown as string })
    ).rejects.toMatchObject({ statusCode: 400, message: "search must be a single value" });
  });

  it("leaves search undefined when the board sends no term", async () => {
    const { req } = await invokeRoute("/pipeline", { includeDd: "true" });
    expect(dealServiceMocks.getDealsForPipeline).toHaveBeenCalledWith(
      req.tenantDb,
      "director",
      "director-1",
      expect.objectContaining({ search: undefined }),
      "director"
    );
  });

  it("only opts into the board-aggregates contract when the caller asks for it", async () => {
    // Default OFF is load-bearing in two directions: an OLD web bundle carves its Pending RFP column out
    // of pipelineColumns and cannot start sending a flag, and mobile-crm never reads the summary but
    // would otherwise pay to materialize the whole open pipeline for 15 cards.
    const withoutFlag = await invokeRoute("/pipeline", { includeDd: "true" });
    expect(dealServiceMocks.getDealsForPipeline).toHaveBeenCalledWith(
      withoutFlag.req.tenantDb,
      "director",
      "director-1",
      expect.objectContaining({ includeBoardAggregates: false }),
      "director"
    );

    const withFlag = await invokeRoute("/pipeline", { includeDd: "true", boardAggregates: "true" });
    expect(dealServiceMocks.getDealsForPipeline).toHaveBeenCalledWith(
      withFlag.req.tenantDb,
      "director",
      "director-1",
      expect.objectContaining({ includeBoardAggregates: true }),
      "director"
    );
  });

  it("OMITS the gated fields from the SERIALIZED body a legacy caller receives", async () => {
    /**
     * Asserted on the JSON a client would actually parse, not on the object literal in the handler.
     *
     * The distinction is the whole finding: the route led its response with `...result`, which copied
     * `boardSummary: null` in BEFORE the conditional spread that was supposed to gate it — and a
     * conditional spread can only add a key, never remove one. So a legacy client received
     * `"boardSummary": null`: a determination ("no at-risk data") where the contract promised an absence
     * ("this response does not carry that"). Its fallbacks branch on the field being MISSING.
     *
     * `body.boardSummary == null` would pass in both the broken and the fixed state, which is exactly
     * how this survived. `'boardSummary' in body` is the assertion that discriminates.
     */
    dealServiceMocks.getDealsForPipeline.mockResolvedValue({
      pipelineColumns: [],
      terminalStages: [],
      // What the service returns for a caller that did not opt in.
      boardSummary: null,
      pendingRfpDeals: undefined,
    });

    const { res } = await invokeRoute("/pipeline", { includeDd: "true" });
    // Round-trip through JSON: this is the wire, where undefined-valued keys vanish and null survives.
    const wire = JSON.parse(JSON.stringify(res.body));

    expect("boardSummary" in wire).toBe(false);
    expect("pendingRfpDeals" in wire).toBe(false);
    // The pre-change shape, exactly — no more keys than a legacy client already handled.
    expect(Object.keys(wire).sort()).toEqual(["pipelineColumns", "terminalStages"]);
  });

  it("INCLUDES the gated fields in the serialized body once the caller opts in", async () => {
    const summary = {
      atRiskByStageSlug: { opportunity: { service: 1, nonService: 2 } },
      pendingRfp: { count: 3, totalCount: 4, totalValue: 5 },
    };
    dealServiceMocks.getDealsForPipeline.mockResolvedValue({
      pipelineColumns: [],
      terminalStages: [],
      boardSummary: summary,
      pendingRfpDeals: [],
    });

    const { res } = await invokeRoute("/pipeline", { includeDd: "true", boardAggregates: "true" });
    const wire = JSON.parse(JSON.stringify(res.body));

    expect(wire.boardSummary).toEqual(summary);
    // An EXPLICIT empty preview must still serialize as a present, empty array — the client reads that
    // as "the server looked and the bucket is empty", which is not the same as an absent field.
    expect("pendingRfpDeals" in wire).toBe(true);
    expect(wire.pendingRfpDeals).toEqual([]);
  });

  it("passes requester role separately from collaborative read role for stage At Risk results", async () => {
    accessMocks.getCollaborativeReadRole.mockReturnValueOnce("director");
    const { req } = await invokeRoute(
      "/stages/:stageId",
      { scope: "all" },
      { params: { stageId: "stage-opportunity" }, user: { id: "rep-1", role: "rep" } }
    );

    expect(dealServiceMocks.listDealStagePage).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        role: "director",
        atRiskViewerRole: "rep",
      })
    );
  });

  it("rejects malformed createdFrom with a 400 before querying deals", async () => {
    const handler = findRouteHandler("get", "/");
    const req = {
      query: { createdFrom: "not-a-date" },
      tenantDb: {},
      user: {
        id: "director-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      commitTransaction: vi.fn(async () => {}),
    } as any;
    const res = {} as any;
    const next = vi.fn();

    await handler(req, res, next);

    expect(dealServiceMocks.getDeals).not.toHaveBeenCalled();
    expect(req.commitTransaction).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: "createdFrom must be an ISO date in YYYY-MM-DD format",
      })
    );
  });

  it("passes validated createdFrom and createdTo through to getDeals", async () => {
    const { req } = await invokeRoute("/", {
      createdFrom: "2026-05-01",
      createdTo: "2026-05-31",
    });

    expect(dealServiceMocks.getDeals).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        createdFrom: "2026-05-01",
        createdTo: "2026-05-31",
      }),
      "director",
      "director-1",
      "director"
    );
  });

  it("passes validated wonClosedFrom and wonClosedTo through to getDeals", async () => {
    const { req } = await invokeRoute("/", {
      wonClosedFrom: "2026-01-01",
      wonClosedTo: "2026-12-31",
    });

    expect(dealServiceMocks.getDeals).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        wonClosedFrom: "2026-01-01",
        wonClosedTo: "2026-12-31",
      }),
      "director",
      "director-1",
      "director"
    );
  });

  it("rejects malformed wonClosedFrom with a 400 before querying deals", async () => {
    const handler = findRouteHandler("get", "/");
    const req = {
      query: { wonClosedFrom: "2026-99-99" },
      tenantDb: {},
      user: {
        id: "director-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      commitTransaction: vi.fn(async () => {}),
    } as any;
    const res = {} as any;
    const next = vi.fn();

    await handler(req, res, next);

    expect(dealServiceMocks.getDeals).not.toHaveBeenCalled();
    expect(req.commitTransaction).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: "wonClosedFrom must be an ISO date in YYYY-MM-DD format",
      })
    );
  });

  it("rejects malformed wonClosedTo with a 400 before querying deals", async () => {
    const handler = findRouteHandler("get", "/");
    const req = {
      query: { wonClosedTo: "January 31" },
      tenantDb: {},
      user: {
        id: "director-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      commitTransaction: vi.fn(async () => {}),
    } as any;
    const res = {} as any;
    const next = vi.fn();

    await handler(req, res, next);

    expect(dealServiceMocks.getDeals).not.toHaveBeenCalled();
    expect(req.commitTransaction).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: "wonClosedTo must be an ISO date in YYYY-MM-DD format",
      })
    );
  });

  it("passes validated Estimate Sent date filters through to deal list and pipeline routes", async () => {
    const list = await invokeRoute("/", {
      assignedRepId: "rep-1",
      estimateSentFrom: "2026-04-01",
      estimateSentTo: "2026-04-30",
      search: "roof",
    });
    const pipeline = await invokeRoute("/pipeline", {
      assignedRepId: "rep-1",
      estimateSentFrom: "2026-04-01",
      estimateSentTo: "2026-04-30",
    });

    expect(dealServiceMocks.getDeals).toHaveBeenCalledWith(
      list.req.tenantDb,
      expect.objectContaining({
        assignedRepId: "rep-1",
        estimateSentFrom: "2026-04-01",
        estimateSentTo: "2026-04-30",
        search: "roof",
      }),
      "director",
      "director-1",
      "director"
    );
    expect(dealServiceMocks.getDealsForPipeline).toHaveBeenCalledWith(
      pipeline.req.tenantDb,
      "director",
      "director-1",
      expect.objectContaining({
        assignedRepId: "rep-1",
        estimateSentFrom: "2026-04-01",
        estimateSentTo: "2026-04-30",
      }),
      "director"
    );
  });

  it("rejects malformed Estimate Sent date filters before querying deals", async () => {
    const handler = findRouteHandler("get", "/");
    const req = {
      query: { estimateSentFrom: "April 1" },
      tenantDb: {},
      user: {
        id: "director-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      commitTransaction: vi.fn(async () => {}),
    } as any;
    const res = {} as any;
    const next = vi.fn();

    await handler(req, res, next);

    expect(dealServiceMocks.getDeals).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: "estimateSentFrom must be an ISO date in YYYY-MM-DD format",
      })
    );
  });
});
