import { beforeEach, describe, expect, it, vi } from "vitest";

const getDealByIdMock = vi.hoisted(() => vi.fn());
const loadRfpAttachmentsForDealMock = vi.hoisted(() =>
  vi.fn(async () => [] as Array<{ name: string; url: string; contentType: string }>)
);
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

vi.mock("../../../src/modules/deals/rfp-enqueue.js", () => ({
  insertOpportunityRfpRequestJob: vi.fn(),
  loadRfpAttachmentsForDeal: loadRfpAttachmentsForDealMock,
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
    expect(accessMocks.assertDealOwnerAccess).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({ id: "user-1", role: "director" }),
      expect.objectContaining({ allowAdmin: true, allowDirector: true })
    );
  });

  it("regenerates attachment URLs on retry instead of reusing the dead payload's stale links", async () => {
    loadRfpAttachmentsForDealMock.mockResolvedValueOnce([
      { name: "Plan.pdf", url: "https://fresh.example/plan", contentType: "application/pdf" },
    ]);
    const inserted: any[] = [];
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
                body: {
                  sourceDealId: "deal-1",
                  attachments: [
                    { name: "Plan.pdf", url: "https://expired.example/plan", contentType: "application/pdf" },
                  ],
                },
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
          set: vi.fn(() => ({ where: vi.fn(async () => ({})) })),
        })),
      },
      user: { id: "user-1", role: "director", officeId: "office-1", activeOfficeId: "office-1" },
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
    expect(loadRfpAttachmentsForDealMock).toHaveBeenCalledWith(req.tenantDb, "deal-1");
    expect(inserted[0].payload.body.attachments).toEqual([
      { name: "Plan.pdf", url: "https://fresh.example/plan", contentType: "application/pdf" },
    ]);
  });

  it("rejects retries when owner/admin access is denied before loading the deal", async () => {
    accessMocks.assertDealOwnerAccess.mockRejectedValueOnce({ statusCode: 403, message: "forbidden" });
    const req = {
      params: { id: "deal-1" },
      tenantDb: { execute: vi.fn(), insert: vi.fn(), update: vi.fn() },
      user: {
        id: "rep-2",
        role: "rep",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      commitTransaction: vi.fn(async () => {}),
    } as any;
    const res = { status: vi.fn(), json: vi.fn() } as any;
    const next = vi.fn();

    await findRouteHandler("post", "/:id/rfp-retry")(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(getDealByIdMock).not.toHaveBeenCalled();
  });

  it("keeps admin retry support for deals outside the acting office", async () => {
    accessMocks.assertDealOwnerAccess.mockResolvedValueOnce({
      id: "deal-1",
      assignedRepId: "rep-9",
      officeId: "office-9",
    });
    const inserted: any[] = [];
    const req = {
      params: { id: "deal-1" },
      tenantDb: {
        execute: vi.fn(async () => ({
          rows: [{ id: 10, payload: { dealId: "deal-1", body: { sourceDealId: "deal-1" } } }],
        })),
        insert: vi.fn(() => ({
          values: vi.fn(async (value) => {
            inserted.push(value);
            return {};
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({ where: vi.fn(async () => ({})) })),
        })),
      },
      user: {
        id: "admin-1",
        role: "admin",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      commitTransaction: vi.fn(async () => {}),
    } as any;
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json: vi.fn(),
    } as any;
    const next = vi.fn((err?: unknown) => {
      if (err) throw err;
    });

    await findRouteHandler("post", "/:id/rfp-retry")(req, res, next);

    expect(res.statusCode).toBe(202);
    expect(inserted).toHaveLength(1);
  });
});
