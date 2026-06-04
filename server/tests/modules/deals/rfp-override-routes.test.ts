import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const overrideMocks = vi.hoisted(() => ({
  resubmitDeclinedRfp: vi.fn(),
  reconfirmRfpDecline: vi.fn(),
  getRfpReviewDetail: vi.fn(),
}));

// --- mocks so importing deals/routes.ts (and its many service deps) is side-effect free ---
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
vi.mock("../../../src/modules/deals/rfp-override-service.js", () => overrideMocks);

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

const TAKASHI = "takashi@trockgc.com";
const ADAM = "ashaw@trockgc.com";

function reviewer() {
  return { id: "rev-1", email: TAKASHI, displayName: "Takashi", role: "director", officeId: "office-1", activeOfficeId: "office-1" };
}
function nonReviewer() {
  return { id: "adm-1", email: "someadmin@trockgc.com", displayName: "Admin", role: "admin", officeId: "office-1", activeOfficeId: "office-1" };
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

/** Runs the full route stack (middleware THEN handler) so the real requireRfpReviewer gate is exercised. */
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

describe("RFP override-review routes", () => {
  const original = process.env.RFP_REJECTION_EMAIL_RECIPIENTS;
  const originalFlag = process.env.ENABLE_OPPORTUNITY_RFP_EVENT;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RFP_REJECTION_EMAIL_RECIPIENTS = `${TAKASHI}, ${ADAM}`;
    process.env.ENABLE_OPPORTUNITY_RFP_EVENT = "true";
  });
  afterEach(() => {
    process.env.RFP_REJECTION_EMAIL_RECIPIENTS = original;
    process.env.ENABLE_OPPORTUNITY_RFP_EVENT = originalFlag;
  });

  describe("POST /:id/rfp-override/approve", () => {
    it("re-submits and returns the new status + job when a reviewer approves an actionable RFP", async () => {
      overrideMocks.resubmitDeclinedRfp.mockResolvedValue({ ok: true, jobId: 42, eventId: "evt", status: "pending_outbox" });
      const commit = vi.fn(async () => {});
      const req = { params: { id: "deal-1" }, body: { note: "rescue" }, tenantDb: {}, user: reviewer(), commitTransaction: commit } as any;
      const res = makeRes();

      const err = await runRoute("post", "/:id/rfp-override/approve", req, res);

      expect(err).toBeUndefined();
      expect(overrideMocks.resubmitDeclinedRfp).toHaveBeenCalledWith(
        expect.objectContaining({ dealId: "deal-1", officeId: "office-1", note: "rescue", actor: expect.objectContaining({ userId: "rev-1" }) })
      );
      expect(res.body).toMatchObject({ success: true, status: "pending_outbox", jobId: 42 });
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it("returns 409 (and does not commit) when the RFP is no longer actionable", async () => {
      overrideMocks.resubmitDeclinedRfp.mockResolvedValue({ ok: false, reason: "not_actionable" });
      const commit = vi.fn(async () => {});
      const req = { params: { id: "deal-1" }, body: {}, tenantDb: {}, user: reviewer(), commitTransaction: commit } as any;
      const res = makeRes();

      const err = await runRoute("post", "/:id/rfp-override/approve", req, res);

      expect(err).toMatchObject({ statusCode: 409 });
      expect(commit).not.toHaveBeenCalled();
    });

    it("403s a non-reviewer admin and never calls the service", async () => {
      const req = { params: { id: "deal-1" }, body: {}, tenantDb: {}, user: nonReviewer(), commitTransaction: vi.fn() } as any;
      const res = makeRes();

      const err = await runRoute("post", "/:id/rfp-override/approve", req, res);

      expect(err).toMatchObject({ statusCode: 403 });
      expect(overrideMocks.resubmitDeclinedRfp).not.toHaveBeenCalled();
    });

    it("503s (and never calls the service) when the RFP delivery pipeline is disabled", async () => {
      process.env.ENABLE_OPPORTUNITY_RFP_EVENT = "false";
      const req = { params: { id: "deal-1" }, body: {}, tenantDb: {}, user: reviewer(), commitTransaction: vi.fn() } as any;
      const res = makeRes();

      const err = await runRoute("post", "/:id/rfp-override/approve", req, res);

      expect(err).toMatchObject({ statusCode: 503, code: "RFP_EVENT_DISABLED" });
      expect(overrideMocks.resubmitDeclinedRfp).not.toHaveBeenCalled();
    });
  });

  describe("POST /:id/rfp-override/reconfirm-decline", () => {
    it("records the re-confirmed denial when a reviewer acts", async () => {
      overrideMocks.reconfirmRfpDecline.mockResolvedValue({ ok: true, status: "declined", decision: "denial_reconfirmed" });
      const commit = vi.fn(async () => {});
      const req = { params: { id: "deal-1" }, body: { note: "confirmed" }, tenantDb: {}, user: reviewer(), commitTransaction: commit } as any;
      const res = makeRes();

      const err = await runRoute("post", "/:id/rfp-override/reconfirm-decline", req, res);

      expect(err).toBeUndefined();
      expect(res.body).toMatchObject({ success: true, status: "declined", decision: "denial_reconfirmed" });
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it("returns 409 when not actionable", async () => {
      overrideMocks.reconfirmRfpDecline.mockResolvedValue({ ok: false, reason: "not_actionable" });
      const req = { params: { id: "deal-1" }, body: {}, tenantDb: {}, user: reviewer(), commitTransaction: vi.fn() } as any;
      const res = makeRes();
      const err = await runRoute("post", "/:id/rfp-override/reconfirm-decline", req, res);
      expect(err).toMatchObject({ statusCode: 409 });
    });

    it("403s a non-reviewer", async () => {
      const req = { params: { id: "deal-1" }, body: {}, tenantDb: {}, user: nonReviewer(), commitTransaction: vi.fn() } as any;
      const res = makeRes();
      const err = await runRoute("post", "/:id/rfp-override/reconfirm-decline", req, res);
      expect(err).toMatchObject({ statusCode: 403 });
      expect(overrideMocks.reconfirmRfpDecline).not.toHaveBeenCalled();
    });
  });

  describe("GET /:id/rfp-review", () => {
    it("returns the review detail for a reviewer", async () => {
      const detail = { dealId: "deal-1", dealName: "Acme", actionable: true };
      overrideMocks.getRfpReviewDetail.mockResolvedValue(detail);
      const req = { params: { id: "deal-1" }, tenantDb: {}, user: reviewer() } as any;
      const res = makeRes();
      const err = await runRoute("get", "/:id/rfp-review", req, res);
      expect(err).toBeUndefined();
      expect(res.body).toEqual({ review: detail });
    });

    it("404s when the deal is missing", async () => {
      overrideMocks.getRfpReviewDetail.mockResolvedValue(null);
      const req = { params: { id: "missing" }, tenantDb: {}, user: reviewer() } as any;
      const res = makeRes();
      const err = await runRoute("get", "/:id/rfp-review", req, res);
      expect(err).toMatchObject({ statusCode: 404 });
    });

    it("403s a non-reviewer", async () => {
      const req = { params: { id: "deal-1" }, tenantDb: {}, user: nonReviewer() } as any;
      const res = makeRes();
      const err = await runRoute("get", "/:id/rfp-review", req, res);
      expect(err).toMatchObject({ statusCode: 403 });
      expect(overrideMocks.getRfpReviewDetail).not.toHaveBeenCalled();
    });
  });
});
