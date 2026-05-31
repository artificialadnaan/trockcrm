import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

// Product rule: a rep may VIEW any deal in their office (including a teammate's), but may only
// MUTATE their own. Global search returns office-level results, so opening a teammate's deal must
// not 403. The deal detail route (GET /:id, /:id/detail) already enforces this via the office-level
// collaborator gate; this test locks the SAME contract onto the per-deal sub-resource routes:
//   - every per-deal GET gates on assertDealCollaboratorAccess (office-level) -- NOT the owner-only
//     getDealById loader, which throws "You can only view your own deals" for a non-owner rep.
//   - every per-deal write stays owner-only (a non-owner rep is blocked).
// Mirrors the harness in routes-scope.test.ts (mount the real router, invoke a handler directly).

const dealServiceMocks = vi.hoisted(() => ({
  getDeals: vi.fn(),
  getDealsForPipeline: vi.fn(),
  listDealStagePage: vi.fn(),
  getDealById: vi.fn(),
  getDealDetail: vi.fn(),
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
  getDealById: dealServiceMocks.getDealById,
  getDealDetail: dealServiceMocks.getDealDetail,
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
vi.mock("../../../src/modules/admin/users-service.js", () => ({ listUsers: vi.fn(() => []) }));
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

function findRouteHandler(method: string, path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.find((entry: any) => entry.method === method).handle;
}

async function invoke(
  method: string,
  path: string,
  options: { params?: Record<string, string>; body?: any; user?: Partial<{ id: string; role: string }> } = {}
) {
  const handler = findRouteHandler(method, path);
  const req = {
    params: options.params ?? { id: "deal-1" },
    query: {},
    body: options.body ?? {},
    tenantDb: {},
    appDb: {},
    user: {
      id: options.user?.id ?? "rep-1",
      role: options.user?.role ?? "rep",
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
    send() {
      return this;
    },
  } as any;
  let nextErr: any;
  await handler(req, res, (err?: unknown) => {
    nextErr = err;
  });
  return { req, res, nextErr };
}

// Every per-deal sub-resource GET route. `deal` is used in each only as an access gate.
const READ_PATHS = [
  "/:id/estimating",
  "/:id/estimating/market-context",
  "/:id/estimating/markets",
  "/:id/approvals",
  "/:id/contacts",
  "/:id/team",
  "/:id/team/assignable-users",
  "/:id/estimates",
  "/:id/punch-list",
  "/:id/timers",
  "/:id/closeout",
];

// Representative per-deal write routes (each gates on getDealById first).
const WRITE_ROUTES = [
  { method: "post", path: "/:id/estimating/documents" },
  { method: "post", path: "/:id/estimates/sections" },
  { method: "post", path: "/:id/punch-list" },
  { method: "post", path: "/:id/timers" },
];

describe("deal sub-resource READ routes are office-level (a rep can view a teammate's deal)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.getCollaborativeReadRole.mockImplementation((role: string) => role);
    // Office access granted; the deal belongs to a teammate (rep is not the owner).
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "teammate-1" });
    // The owner-only loader would 403 a non-owner rep -- a read route must NOT depend on it.
    dealServiceMocks.getDealById.mockRejectedValue(new AppError(403, "You can only view your own deals"));
  });

  for (const path of READ_PATHS) {
    it(`GET ${path} gates on office collaborator access, not the owner-only loader`, async () => {
      const { nextErr } = await invoke("get", path, { user: { id: "rep-1", role: "rep" } });

      // Uses the office-level gate with the deal id + the requesting viewer.
      expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledWith(
        expect.anything(),
        "deal-1",
        expect.objectContaining({ id: "rep-1", role: "rep" })
      );
      // Does NOT use the owner-only loader as the gate (which would 403 a non-owner rep).
      expect(dealServiceMocks.getDealById).not.toHaveBeenCalled();
      // So a non-owner rep is never blocked with the owner-only 403.
      expect(nextErr?.statusCode).not.toBe(403);
    });
  }
});

describe("deal sub-resource WRITE routes stay owner-only (a rep cannot mutate a teammate's deal)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.getCollaborativeReadRole.mockImplementation((role: string) => role);
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "teammate-1" });
    accessMocks.assertDealOwnerAccess.mockRejectedValue(
      new AppError(403, "Only the assigned rep can modify this deal")
    );
    // A non-owner rep is rejected by the owner-only loader.
    dealServiceMocks.getDealById.mockRejectedValue(new AppError(403, "You can only view your own deals"));
  });

  for (const { method, path } of WRITE_ROUTES) {
    it(`${method.toUpperCase()} ${path} blocks a non-owner rep with 403`, async () => {
      const { nextErr } = await invoke(method, path, { user: { id: "rep-1", role: "rep" } });
      expect(nextErr?.statusCode).toBe(403);
    });
  }
});
