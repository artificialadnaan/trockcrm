import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/deals/service.js", () => ({
  getDealById: vi.fn(async () => ({
    id: "deal-1",
    assignedRepId: "user-1",
    workflowRoute: "normal",
    stageEnteredAt: new Date("2026-04-21T12:00:00.000Z"),
    pipelineTypeSnapshot: "normal",
    ddEstimate: null,
    bidEstimate: null,
    awardedAmount: null,
    sourceLeadId: null,
    isBidBoardOwned: false,
    bidBoardStageSlug: null,
    bidBoardStageEnteredAt: null,
    bidBoardMirrorSourceEnteredAt: null,
    isReadOnlyMirror: false,
    readOnlySyncedAt: null,
  })),
  getDeals: vi.fn(),
  getDealDetail: vi.fn(),
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  deleteDeal: vi.fn(),
  getDealsForPipeline: vi.fn(),
  getDealSources: vi.fn(),
  buildBidBoardOwnershipState: vi.fn((deal) => ({
    isOwned: deal.isBidBoardOwned,
    sourceOfTruth: deal.isBidBoardOwned ? "bid_board" : "crm",
    handoffStageSlug: "estimate_in_progress",
    downstreamStagesReadOnly: deal.isBidBoardOwned,
    canEditInCrm: ["deal details"],
    mirroredInCrm: ["stage progression"],
    reason: "stubbed",
    message: "stubbed",
  })),
  getEstimatingBoundaryStage: vi.fn(async () => ({
    id: "stage-estimate-in-progress",
    slug: "estimate_in_progress",
    displayOrder: 1,
  })),
  getRequiredEstimatingBoundaryStage: vi.fn(async () => ({
    id: "stage-estimate-in-progress",
    slug: "estimate_in_progress",
    displayOrder: 1,
  })),
  isBidBoardOwnedDownstreamStage: vi.fn(
    (stage, boundary) => Boolean(boundary) && stage.displayOrder > boundary.displayOrder
  ),
  BID_BOARD_STAGE_READ_ONLY_MESSAGE:
    "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages.",
}));

vi.mock("../../../src/modules/deals/stage-change.js", () => ({
  changeDealStage: vi.fn(),
  activateServiceHandoff: vi.fn(),
}));

vi.mock("../../../src/modules/deals/stage-gate.js", () => ({
  preflightStageCheck: vi.fn(),
}));

vi.mock("../../../src/modules/contacts/association-service.js", () => ({
  getContactsForDeal: vi.fn(),
}));

vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  getOrCreateDealScopingIntake: vi.fn(),
  upsertDealScopingIntake: vi.fn(),
  evaluateDealScopingReadiness: vi.fn(),
  linkDealFileToScopingRequirement: vi.fn(),
}));

vi.mock("../../../src/modules/deals/workflow-backfill.js", () => ({
  inferDealBidBoardOwnership: vi.fn(() => ({
    isBidBoardOwned: false,
  })),
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const scopingService = await import("../../../src/modules/deals/scoping-service.js");
const stageChange = await import("../../../src/modules/deals/stage-change.js");
const dealService = await import("../../../src/modules/deals/service.js");
const workflowBackfill = await import("../../../src/modules/deals/workflow-backfill.js");

function findRouteHandler(method: "get" | "patch" | "post", path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) {
    throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  }

  return routeLayer.handle;
}

async function invokeRoute(
  method: "get" | "patch" | "post",
  path: string,
  options?: { params?: Record<string, string>; body?: any }
) {
  const handler = findRouteHandler(method, path);
  const req = {
    params: options?.params ?? {},
    body: options?.body ?? {},
    tenantDb: {
      insert: vi.fn(() => ({
        values: vi.fn(async () => ({})),
      })),
    },
    officeSlug: "office-a",
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
    if (err) {
      throw err;
    }
  });

  await handler(req, res, next);
  return { req, res, next };
}

describe("Deal Scoping Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads or initializes the scoping intake for a deal", async () => {
    vi.mocked(scopingService.getOrCreateDealScopingIntake).mockResolvedValueOnce({
      intake: { id: "intake-1", status: "draft" },
      readiness: { status: "draft", errors: { sections: {}, attachments: {} }, completionState: {}, requiredSections: [], requiredAttachmentKeys: [] },
    } as never);

    const { req, res } = await invokeRoute("get", "/:id/scoping-intake", { params: { id: "deal-1" } });

    expect(scopingService.getOrCreateDealScopingIntake).toHaveBeenCalledWith(req.tenantDb, "deal-1", "user-1");
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.intake.status).toBe("draft");
  });

  it("patches the scoping intake for a deal", async () => {
    vi.mocked(scopingService.upsertDealScopingIntake).mockResolvedValueOnce({
      intake: { id: "intake-1", status: "ready" },
      readiness: { status: "ready", errors: { sections: {}, attachments: {} }, completionState: {}, requiredSections: [], requiredAttachmentKeys: [] },
    } as never);

    const { req, res } = await invokeRoute("patch", "/:id/scoping-intake", {
      params: { id: "deal-1" },
      body: { workflowRoute: "normal", sectionData: { scopeSummary: { summary: "Refresh" } } },
    });

    expect(scopingService.upsertDealScopingIntake).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { sectionData: { scopeSummary: { summary: "Refresh" } } },
      "user-1"
    );
    expect(res.body.readiness.status).toBe("ready");
  });

  it("returns readiness for the current scoping intake", async () => {
    vi.mocked(scopingService.evaluateDealScopingReadiness).mockResolvedValueOnce({
      status: "draft",
      errors: { sections: { projectOverview: ["bidDueDate"] }, attachments: {} },
      completionState: {},
      requiredSections: ["projectOverview"],
      requiredAttachmentKeys: [],
    } as never);

    const { res } = await invokeRoute("get", "/:id/scoping-intake/readiness", { params: { id: "deal-1" } });

    expect(res.statusCode).toBe(200);
    expect(res.body.readiness.errors.sections.projectOverview).toEqual(["bidDueDate"]);
  });

  it("links an existing deal file into an intake requirement without duplicating the file row", async () => {
    vi.mocked(scopingService.linkDealFileToScopingRequirement).mockResolvedValueOnce({
      id: "file-1",
      intakeSection: "attachments",
      intakeRequirementKey: "site_photos",
    } as never);

    const { req, res } = await invokeRoute("post", "/:id/scoping-intake/attachments/link-existing", {
      params: { id: "deal-1" },
      body: { fileId: "file-1", intakeSection: "attachments", intakeRequirementKey: "site_photos" },
    });

    expect(scopingService.linkDealFileToScopingRequirement).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { fileId: "file-1", intakeSection: "attachments", intakeRequirementKey: "site_photos" },
      "user-1"
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.file.id).toBe("file-1");
  });

  it("activates service handoff through the deal route", async () => {
    vi.mocked(stageChange.activateServiceHandoff).mockResolvedValueOnce({ activated: true } as never);

    const { req, res } = await invokeRoute("post", "/:id/service-handoff/activate", {
      params: { id: "deal-1" },
    });

    expect(stageChange.activateServiceHandoff).toHaveBeenCalledWith(req.tenantDb, {
      dealId: "deal-1",
      userId: "user-1",
      userRole: "director",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.activated).toBe(true);
  });

  it("keeps preflight aligned with the Bid Board boundary lock even before the ownership flag backfills", async () => {
    const preflight = await import("../../../src/modules/deals/stage-gate.js");
    vi.mocked(preflight.preflightStageCheck).mockResolvedValueOnce({
      allowed: true,
      blockReason: null,
      currentStage: {
        id: "stage-estimate-in-progress",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        displayOrder: 1,
      },
      targetStage: {
        id: "stage-estimate-in-progress-clone",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        displayOrder: 1,
      },
    } as never);
    vi.mocked(workflowBackfill.inferDealBidBoardOwnership).mockReturnValueOnce({
      isBidBoardOwned: false,
    } as never);

    const { res } = await invokeRoute("post", "/:id/stage/preflight", {
      params: { id: "deal-1" },
      body: { targetStageId: "stage-estimate-in-progress-clone" },
    });

    expect(dealService.getEstimatingBoundaryStage).toHaveBeenCalledWith("normal");
    expect(res.statusCode).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.bidBoardLocked).toBe(true);
    expect(res.body.blockReason).toBe(
      "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages."
    );
  });

  it("allows the CRM-owned handoff move into estimate in progress", async () => {
    const preflight = await import("../../../src/modules/deals/stage-gate.js");
    vi.mocked(preflight.preflightStageCheck).mockResolvedValueOnce({
      allowed: true,
      blockReason: null,
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        displayOrder: 0,
      },
      targetStage: {
        id: "stage-estimate-in-progress",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        displayOrder: 1,
      },
    } as never);
    vi.mocked(workflowBackfill.inferDealBidBoardOwnership).mockReturnValueOnce({
      isBidBoardOwned: false,
    } as never);

    const { res } = await invokeRoute("post", "/:id/stage/preflight", {
      params: { id: "deal-1" },
      body: { targetStageId: "stage-estimate-in-progress" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.bidBoardLocked).toBe(false);
    expect(res.body.blockReason).toBeNull();
  });

  it("treats legacy estimating as the Bid Board boundary when canonical boundary config exists", async () => {
    const preflight = await import("../../../src/modules/deals/stage-gate.js");
    vi.mocked(preflight.preflightStageCheck).mockResolvedValueOnce({
      allowed: true,
      blockReason: null,
      currentStage: {
        id: "stage-estimating",
        name: "Estimating",
        slug: "estimating",
        isTerminal: false,
        displayOrder: 1,
      },
      targetStage: {
        id: "stage-bid-sent",
        name: "Estimate Sent to Client",
        slug: "estimate_sent_to_client",
        isTerminal: false,
        displayOrder: 2,
      },
    } as never);
    vi.mocked(workflowBackfill.inferDealBidBoardOwnership).mockReturnValueOnce({
      isBidBoardOwned: false,
    } as never);

    const { res } = await invokeRoute("post", "/:id/stage/preflight", {
      params: { id: "deal-1" },
      body: { targetStageId: "stage-bid-sent" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.bidBoardLocked).toBe(true);
    expect(res.body.blockReason).toBe(
      "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages."
    );
  });
});
