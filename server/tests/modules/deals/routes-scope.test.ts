import { beforeEach, describe, expect, it, vi } from "vitest";

const dealServiceMocks = vi.hoisted(() => ({
  getDeals: vi.fn(),
  getDealsForPipeline: vi.fn(),
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
  listDealStagePage: vi.fn(),
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

async function invokeRoute(path: string, query: Record<string, string> = {}) {
  const handler = findRouteHandler("get", path);
  const req = {
    query,
    tenantDb: {},
    user: {
      id: "director-1",
      role: "director",
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
  });

  it("defaults GET /api/deals to mine scope when scope is missing", async () => {
    const { req } = await invokeRoute("/");
    expect(dealServiceMocks.getDeals).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({ scope: "mine" }),
      "director",
      "director-1"
    );
  });

  it("defaults GET /api/deals/pipeline to mine scope when scope is missing", async () => {
    const { req } = await invokeRoute("/pipeline", { includeDd: "true" });
    expect(dealServiceMocks.getDealsForPipeline).toHaveBeenCalledWith(
      req.tenantDb,
      "director",
      "director-1",
      expect.objectContaining({ scope: "mine", includeDd: true })
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
      "director-1"
    );
  });
});
