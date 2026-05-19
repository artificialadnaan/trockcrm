import { beforeEach, describe, expect, it, vi } from "vitest";

const getDealByIdMock = vi.hoisted(() => vi.fn());
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
  evaluateDealScopingReadiness: vi.fn(),
  getOrCreateDealScopingIntake: vi.fn(),
  linkDealFileToScopingRequirement: vi.fn(),
  routeRevisionToEstimating: vi.fn(),
  upsertDealScopingIntake: vi.fn(),
}));

vi.mock("../../../src/modules/deals/lineage-resolver.js", () => ({
  writeResolvedDealFields: vi.fn(),
}));

vi.mock("../../../src/modules/deals/workflow-backfill.js", () => ({
  inferDealBidBoardOwnership: vi.fn(),
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

describe("POST /api/deals/:id/rfp-retry", () => {
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
    process.env.SYNCHUB_BASE_URL = "https://new.example.com";
    getDealByIdMock.mockResolvedValue({
      id: "deal-1",
    });
  });

  it("rebuilds the SyncHub URL from current env instead of cloning the dead payload URL", async () => {
    const inserted: any[] = [];
    const updated: any[] = [];
    const req = {
      params: { id: "deal-1" },
      tenantDb: {
        execute: vi.fn(async () => ({
          rows: [
            {
              id: 10,
              payload: {
                dealId: "deal-1",
                syncHubUrl: "https://old.example.com/api/rfp-requests",
                dealHandled: true,
                body: { sourceSystem: "trock_crm", sourceDealId: "deal-1" },
              },
            },
          ],
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
        id: "user-1",
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
    const next = vi.fn((err?: unknown) => {
      if (err) throw err;
    });

    await findRouteHandler("post", "/:id/rfp-retry")(req, res, next);

    expect(res.statusCode).toBe(202);
    expect(inserted[0].payload.syncHubUrl).toBe("https://new.example.com/api/rfp-requests");
    expect(inserted[0].payload.dealHandled).toBeUndefined();
    expect(updated[0]).toMatchObject({ rfpApprovalStatus: "pending_outbox" });
  });
});
