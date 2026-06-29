import { describe, expect, it, vi } from "vitest";

// --- mocks so importing deals/routes.ts has no side effects ---
vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));
vi.mock("../../../src/modules/deals/service.js", () => ({
  BID_BOARD_STAGE_READ_ONLY_MESSAGE: "read only",
  buildBidBoardOwnershipState: vi.fn(),
  getDeals: vi.fn(),
  getDealById: vi.fn(),
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
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: any) => scope ?? "all"),
}));
vi.mock("../../../src/modules/deals/rfp-override-service.js", () => ({
  requestOverrideApproval: vi.fn(),
  reconfirmRfpDecline: vi.fn(),
  getRfpReviewDetail: vi.fn(),
}));
vi.mock("../../../src/modules/deals/pending-rfp-service.js", () => ({
  getPendingRfpDeals: vi.fn().mockResolvedValue([{ id: "d1", name: "X", subState: "awaiting" }]),
  cancelPendingRfp: vi.fn(),
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

function makeRes() {
  return {
    statusCode: 200,
    json: vi.fn().mockReturnThis(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  } as any;
}

async function runRoute(method: "get" | "post", path: string, req: any, res: any) {
  const routeLayer = (dealRoutes as any).stack.find(
    (e: any) => e.route?.path === path && e.route?.methods?.[method]
  );
  if (!routeLayer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const handlers = routeLayer.route.stack
    .filter((e: any) => e.method === method)
    .map((e: any) => e.handle);
  let capturedErr: any;
  for (const handler of handlers) {
    let advanced = false;
    const next = (err?: unknown) => {
      if (err) capturedErr = err;
      else advanced = true;
    };
    await handler(req, res, next);
    if (capturedErr) break;
    if (!advanced) break;
  }
  return capturedErr;
}

describe("GET /pending-rfp", () => {
  it("returns the bucket and commits", async () => {
    const res = makeRes();
    const commitTransaction = vi.fn().mockResolvedValue(undefined);
    const err = await runRoute("get", "/pending-rfp", {
      user: { id: "u1", role: "rep", officeId: "o1" },
      tenantDb: {},
      commitTransaction,
    }, res);
    expect(err).toBeUndefined();
    expect(commitTransaction).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ deals: [{ id: "d1", name: "X", subState: "awaiting" }] });
  });
});
