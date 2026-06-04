import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.hoisted(() => vi.fn(async () => ({ jobId: 777 })));
const logActivityMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../src/modules/deals/rfp-enqueue.js", () => ({
  insertOpportunityRfpRequestJob: enqueueMock,
}));

vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: logActivityMock,
  buildAuditActorFromUser: (input: any) => ({ type: "user", ...input }),
}));

const { resubmitDeclinedRfp, reconfirmRfpDecline, getRfpReviewDetail } = await import(
  "../../../src/modules/deals/rfp-override-service.js"
);

const ACTOR = { userId: "rev-1", name: "Takashi", role: "director" };

/**
 * Mock tenantDb: update().set(captured).where().returning(resolves to `rows`), plus execute() capture.
 */
function makeTenantDb(rows: any[]) {
  const setArgs: any[] = [];
  const executed: any[] = [];
  const tenantDb = {
    update: vi.fn(() => ({
      set: vi.fn((value: any) => {
        setArgs.push(value);
        return { where: vi.fn(() => ({ returning: vi.fn(async () => rows) })) };
      }),
    })),
    execute: vi.fn(async (q: any) => {
      executed.push(q);
      return { rows: [] };
    }),
  };
  return { tenantDb: tenantDb as any, setArgs, executed };
}

describe("resubmitDeclinedRfp (approve / override → re-submit)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resets the RFP fields to pending_outbox and enqueues a fresh SyncHub delivery when the deal was declined", async () => {
    const resetDeal = { id: "deal-1", name: "Acme", dealNumber: "TR-1", projectNumber: "P-9", rfpApprovalStatus: "pending_outbox" };
    const { tenantDb, setArgs } = makeTenantDb([resetDeal]);

    const result = await resubmitDeclinedRfp({
      tenantDb,
      officeId: "office-1",
      dealId: "deal-1",
      actor: ACTOR,
      note: "Rescuing this one",
    });

    expect(result).toMatchObject({ ok: true, jobId: 777, status: "pending_outbox" });
    // the reset clears the declined cycle + any prior override markers and re-opens for a new cycle
    const set = setArgs[0];
    expect(set.rfpApprovalStatus).toBe("pending_outbox");
    expect(set.rfpApprovalRequestId).toBeNull();
    expect(set.rfpDeclinedReason).toBeNull();
    expect(set.rfpDeclinedAt).toBeNull();
    expect(set.rfpOverrideReviewedAt).toBeNull();
    expect(set.rfpOverrideDecision).toBeNull();
    expect(set.rfpApprovalRequestEventId).toEqual(expect.any(String));
    // the original requester is preserved (NOT reset), so a later re-decline still notifies the rep
    expect(set.rfpApprovalRequestedBy).toBeUndefined();
    // enqueues the delivery for the reset deal, threading the new event id
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantDb, deal: resetDeal, officeId: "office-1", eventId: set.rfpApprovalRequestEventId })
    );
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });

  it("is a graceful no-op (not_actionable) and does NOT enqueue when the deal is not a fresh declined RFP", async () => {
    const { tenantDb } = makeTenantDb([]); // guarded UPDATE matched 0 rows

    const result = await resubmitDeclinedRfp({
      tenantDb,
      officeId: "office-1",
      dealId: "deal-1",
      actor: ACTOR,
      note: null,
    });

    expect(result).toEqual({ ok: false, reason: "not_actionable" });
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(logActivityMock).not.toHaveBeenCalled();
  });
});

describe("reconfirmRfpDecline (re-confirm denial)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks the declined deal reviewed with decision 'denial_reconfirmed' and leaves the status declined", async () => {
    const reviewedDeal = { id: "deal-1", name: "Acme", dealNumber: "TR-1", projectNumber: "P-9" };
    const { tenantDb, setArgs } = makeTenantDb([reviewedDeal]);

    const result = await reconfirmRfpDecline({ tenantDb, dealId: "deal-1", actor: ACTOR, note: "Confirmed no-go" });

    expect(result).toMatchObject({ ok: true, decision: "denial_reconfirmed" });
    const set = setArgs[0];
    expect(set.rfpOverrideDecision).toBe("denial_reconfirmed");
    expect(set.rfpOverrideReviewedBy).toBe("rev-1");
    expect(set.rfpOverrideReviewedAt).toBeInstanceOf(Date);
    expect(set.rfpOverrideNote).toBe("Confirmed no-go");
    // it must NOT touch rfp_approval_status (so the decline-email trigger never fires)
    expect(set.rfpApprovalStatus).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });

  it("is a graceful no-op (not_actionable) when the deal is not a fresh declined RFP", async () => {
    const { tenantDb } = makeTenantDb([]);
    const result = await reconfirmRfpDecline({ tenantDb, dealId: "deal-1", actor: ACTOR, note: null });
    expect(result).toEqual({ ok: false, reason: "not_actionable" });
    expect(logActivityMock).not.toHaveBeenCalled();
  });
});

describe("getRfpReviewDetail (review-page data + actionable flag)", () => {
  function makeReadDb(row: any | null) {
    return { execute: vi.fn(async () => ({ rows: row ? [row] : [] })) } as any;
  }
  const baseRow = {
    dealId: "deal-1",
    dealName: "Acme",
    dealNumber: "TR-1",
    projectNumber: "P-9",
    rfpApprovalStatus: "declined",
    rfpApprovalRequestId: 5,
    requestedAt: null,
    requestedById: "u1",
    requestedByName: "Rep One",
    requestedByEmail: "rep@x.com",
    declinedReason: "Margins too thin",
    declinedAt: null,
    reviewedAt: null,
    reviewedById: null,
    reviewedByName: null,
    reviewDecision: null,
    reviewNote: null,
  };

  it("maps the joined requester fields and marks a freshly-declined, unreviewed RFP actionable", async () => {
    const detail = await getRfpReviewDetail(makeReadDb(baseRow), "deal-1");
    expect(detail).toMatchObject({
      dealId: "deal-1",
      requestedByName: "Rep One",
      requestedByEmail: "rep@x.com",
      declinedReason: "Margins too thin",
      actionable: true,
    });
  });

  it("is NOT actionable once the denial has been re-confirmed (reviewed)", async () => {
    const detail = await getRfpReviewDetail(
      makeReadDb({ ...baseRow, reviewedAt: "2026-06-04T00:00:00.000Z", reviewDecision: "denial_reconfirmed", reviewedByName: "Takashi" }),
      "deal-1"
    );
    expect(detail?.actionable).toBe(false);
    expect(detail?.reviewDecision).toBe("denial_reconfirmed");
  });

  it("is NOT actionable when the RFP is no longer declined (e.g. re-submitted)", async () => {
    const detail = await getRfpReviewDetail(makeReadDb({ ...baseRow, rfpApprovalStatus: "pending_outbox" }), "deal-1");
    expect(detail?.actionable).toBe(false);
  });

  it("returns null when the deal is not found", async () => {
    expect(await getRfpReviewDetail(makeReadDb(null), "missing")).toBeNull();
  });
});
