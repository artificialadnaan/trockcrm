import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.hoisted(() => vi.fn(async () => {}));
const enqueueMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: logActivityMock,
  buildAuditActorFromUser: (input: any) => ({ type: "user", ...input }),
}));
vi.mock("../../../src/modules/deals/rfp-enqueue.js", async (orig) => ({
  ...((await orig()) as object),
  enqueueRfpBidBoardCreate: enqueueMock,
}));

const { requestOverrideApproval, reconfirmRfpDecline, getRfpReviewDetail } = await import(
  "../../../src/modules/deals/rfp-override-service.js"
);

const ACTOR = { userId: "rev-1", name: "Takashi", role: "director" };
const APPROVER = "ashaw@trockgc.com";
const ENV = { SYNCHUB_SHARED_SECRET: "s3cret", SYNCHUB_BASE_URL: "https://synchub.example.com" } as NodeJS.ProcessEnv;

function makeTenantDb(rows: any[], priorOverrideState: string | null = null) {
  const setArgs: any[] = [];
  const executed: any[] = [];
  const tenantDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ state: priorOverrideState }]) })) })),
    })),
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

function fetchReturning(status: number, body: any = {}) {
  return vi.fn(async () => ({ status, json: async () => body, text: async () => JSON.stringify(body) }) as any);
}

describe("requestOverrideApproval (approve override → call SyncHub override-approve)", () => {
  beforeEach(() => vi.clearAllMocks());

  const DEAL = { id: "deal-1", name: "Acme", dealNumber: "TR-1", projectNumber: "P-9", rfpApprovalRequestId: 77 };

  it("parks the deal in 'approving' and POSTs an HMAC-signed override-approve to SyncHub on 202", async () => {
    const { tenantDb, setArgs } = makeTenantDb([DEAL]);
    const fetchImpl = fetchReturning(202, { success: true, queued: true });

    const result = await requestOverrideApproval(
      { tenantDb, dealId: "deal-1", officeId: null, actor: ACTOR, approverEmail: APPROVER, note: "rescue" },
      { fetchImpl, env: ENV }
    );

    expect(result).toMatchObject({ ok: true, status: "approving", requestId: 77 });
    const set = setArgs[0];
    expect(set.rfpOverrideState).toBe("approving");
    expect(set.rfpOverrideDecision).toBe("override_approved");
    expect(set.rfpOverrideReviewedBy).toBe("rev-1");
    expect(set.rfpOverrideError).toBeNull();
    // deal stays declined while SyncHub works — status is NOT touched here
    expect(set.rfpApprovalStatus).toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://synchub.example.com/api/rfp-requests/77/override-approve");
    expect(opts.method).toBe("POST");
    // the signature is a CORRECT HMAC-SHA256 of the EXACT sent body under SYNCHUB_SHARED_SECRET (not just shape)
    const expectedSig = `sha256=${crypto.createHmac("sha256", "s3cret").update(opts.body).digest("hex")}`;
    expect(opts.headers["x-rfp-request-signature"]).toBe(expectedSig);
    expect(JSON.parse(opts.body)).toEqual({ approverEmail: APPROVER });
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });

  it("records the real prior override state in the retry audit ('failed' -> approving)", async () => {
    const { tenantDb } = makeTenantDb([DEAL], "failed"); // prior state = failed (a retry)
    const fetchImpl = fetchReturning(202);
    await requestOverrideApproval(
      { tenantDb, dealId: "deal-1", officeId: null, actor: ACTOR, approverEmail: APPROVER, note: null },
      { fetchImpl, env: ENV }
    );
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    const auditArg = logActivityMock.mock.calls[0][0] as any;
    expect(auditArg.fieldChanges.rfpOverrideState).toEqual({ from: "failed", to: "approving" });
  });

  it("is a graceful no-op (not_actionable) and does NOT call SyncHub when the deal isn't override-actionable", async () => {
    const { tenantDb } = makeTenantDb([]);
    const fetchImpl = fetchReturning(202);
    const result = await requestOverrideApproval(
      { tenantDb, dealId: "deal-1", officeId: null, actor: ACTOR, approverEmail: APPROVER, note: null },
      { fetchImpl, env: ENV }
    );
    expect(result).toEqual({ ok: false, reason: "not_actionable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("voting-path (null request_id): enqueues create-from-rfp, does NOT POST SyncHub", async () => {
    // voting-path deals have rfp_approval_request_id=null (never ran the SyncHub pipeline)
    const { tenantDb } = makeTenantDb([{ ...DEAL, rfpApprovalRequestId: null }]);
    const fetchImpl = fetchReturning(202);
    const result = await requestOverrideApproval(
      { tenantDb, dealId: "deal-1", officeId: "office-test", actor: ACTOR, approverEmail: APPROVER, note: null },
      { fetchImpl, env: ENV }
    );
    expect(result).toMatchObject({ ok: true, status: "approving", requestId: 0 });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a SyncHub 409 to synchub_rejected (route rolls back the 'approving' write)", async () => {
    const { tenantDb } = makeTenantDb([DEAL]);
    const fetchImpl = fetchReturning(409, { error: "not declined" });
    const result = await requestOverrideApproval(
      { tenantDb, dealId: "deal-1", officeId: null, actor: ACTOR, approverEmail: APPROVER, note: null },
      { fetchImpl, env: ENV }
    );
    expect(result).toMatchObject({ ok: false, reason: "synchub_rejected", syncHubStatus: 409 });
  });

  it("maps a network error to synchub_unavailable", async () => {
    const { tenantDb } = makeTenantDb([DEAL]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await requestOverrideApproval(
      { tenantDb, dealId: "deal-1", officeId: null, actor: ACTOR, approverEmail: APPROVER, note: null },
      { fetchImpl: fetchImpl as any, env: ENV }
    );
    expect(result).toMatchObject({ ok: false, reason: "synchub_unavailable" });
  });

  it("keeps the deal 'approving' (unconfirmed) on an abort/timeout — NOT retryable, but a late callback can resolve it", async () => {
    const { tenantDb, setArgs } = makeTenantDb([DEAL]);
    const fetchImpl = vi.fn(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const result = await requestOverrideApproval(
      { tenantDb, dealId: "deal-1", officeId: null, actor: ACTOR, approverEmail: APPROVER, note: null },
      { fetchImpl: fetchImpl as any, env: ENV }
    );
    // Ambiguous timeout: kept 'approving' (unconfirmed). NOT a rollback (that would drop rfp_override_reviewed_at
    // and re-expose an un-gated one-click approve) and NOT flipped to a retryable 'failed' (a re-approve could race
    // a still-in-flight first attempt into a duplicate). re-approve stays blocked; a late callback still resolves
    // it; a stuck deal is escapable via Re-confirm denial.
    expect(result).toMatchObject({ ok: true, status: "approving", requestId: 77, unconfirmed: true });
    // only the single 'approving' write happened — the timeout does not issue a second state-changing UPDATE
    expect(setArgs).toHaveLength(1);
    expect(setArgs[0].rfpOverrideState).toBe("approving");
  });
});

describe("reconfirmRfpDecline (re-confirm denial — unchanged outcome, guard allows retry-after-failed)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks the declined deal denial_reconfirmed, clears any override state, leaves status declined", async () => {
    const { tenantDb, setArgs } = makeTenantDb([{ id: "deal-1", name: "Acme", dealNumber: "TR-1", projectNumber: "P-9" }]);
    const result = await reconfirmRfpDecline({ tenantDb, dealId: "deal-1", actor: ACTOR, note: "no-go" });
    expect(result).toMatchObject({ ok: true, decision: "denial_reconfirmed" });
    const set = setArgs[0];
    expect(set.rfpOverrideDecision).toBe("denial_reconfirmed");
    expect(set.rfpOverrideState).toBeNull();
    expect(set.rfpApprovalStatus).toBeUndefined();
  });

  it("is a graceful no-op when not actionable", async () => {
    const { tenantDb } = makeTenantDb([]);
    const result = await reconfirmRfpDecline({ tenantDb, dealId: "deal-1", actor: ACTOR, note: null });
    expect(result).toEqual({ ok: false, reason: "not_actionable" });
  });

  it("[finding] enqueues the reconfirm-denial email app-side for a REQUEST-LESS (voting) re-confirm", async () => {
    // A voting NO-GO carries no request id, so the 0154 trigger skips the email — the app must enqueue it.
    const row = { id: "deal-1", name: "Acme", dealNumber: "TR-1", projectNumber: "P-9", rfpApprovalRequestId: null, rfpApprovalRequestEventId: "round-9", rfpApprovalRequestedBy: "rep-1", rfpDeclinedReason: "thin" };
    const { tenantDb } = makeTenantDb([row]);
    const inserted: any[] = [];
    (tenantDb as any).execute = vi.fn(async (q: any) => (JSON.stringify(q).includes("offices") ? { rows: [{ slug: "test" }] } : { rows: [] }));
    (tenantDb as any).insert = vi.fn(() => ({ values: vi.fn(async (v: any) => { inserted.push(v); }) }));
    const result = await reconfirmRfpDecline({ tenantDb, dealId: "deal-1", actor: ACTOR, note: "upheld", officeId: "office-test" });
    expect(result).toMatchObject({ ok: true, decision: "denial_reconfirmed" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].jobType).toBe("rfp_reconfirm_denial_email");
    expect(inserted[0].payload).toMatchObject({ tenantSchema: "office_test", dealId: "deal-1", rfpApprovalRequestId: null, rfpVoteRoundId: "round-9", requestedByUserId: "rep-1" });
  });

  it("[finding] does NOT enqueue app-side for a request-BACKED re-confirm (the 0154 trigger handles it)", async () => {
    const row = { id: "deal-1", name: "Acme", dealNumber: "TR-1", projectNumber: "P-9", rfpApprovalRequestId: 77 };
    const { tenantDb } = makeTenantDb([row]);
    const inserted: any[] = [];
    (tenantDb as any).insert = vi.fn(() => ({ values: vi.fn(async (v: any) => { inserted.push(v); }) }));
    await reconfirmRfpDecline({ tenantDb, dealId: "deal-1", actor: ACTOR, note: "upheld", officeId: "office-test" });
    expect(inserted).toHaveLength(0); // request-backed -> the DB trigger enqueues, not the app
  });
});

describe("getRfpReviewDetail (adds override state/error + actionable)", () => {
  function makeReadDb(row: any | null) {
    return { execute: vi.fn(async () => ({ rows: row ? [row] : [] })) } as any;
  }
  const baseRow = {
    dealId: "deal-1",
    dealName: "Acme",
    dealNumber: "TR-1",
    projectNumber: "P-9",
    rfpApprovalStatus: "declined",
    rfpApprovalRequestId: 77,
    requestedAt: null,
    requestedById: "u1",
    requestedByName: "Rep One",
    requestedByEmail: "rep@x.com",
    declinedReason: "thin",
    declinedAt: null,
    reviewedAt: null,
    reviewedById: null,
    reviewedByName: null,
    reviewDecision: null,
    reviewNote: null,
    overrideState: null,
    overrideError: null,
  };

  it("a fresh declined RFP is actionable with no override state", async () => {
    const detail = await getRfpReviewDetail(makeReadDb(baseRow), "deal-1");
    expect(detail).toMatchObject({ actionable: true, overrideState: null });
  });

  it("an in-flight override ('approving') is NOT actionable and surfaces the state", async () => {
    const detail = await getRfpReviewDetail(
      makeReadDb({ ...baseRow, reviewedAt: "2026-06-04T00:00:00Z", reviewDecision: "override_approved", overrideState: "approving" }),
      "deal-1"
    );
    expect(detail?.actionable).toBe(false);
    expect(detail?.overrideState).toBe("approving");
  });

  it("a failed override is actionable again (Retry) and surfaces the error", async () => {
    const detail = await getRfpReviewDetail(
      makeReadDb({ ...baseRow, reviewedAt: "2026-06-04T00:00:00Z", reviewDecision: "override_approved", overrideState: "failed", overrideError: "Procore form timed out" }),
      "deal-1"
    );
    expect(detail?.actionable).toBe(true);
    expect(detail?.overrideState).toBe("failed");
    expect(detail?.overrideError).toBe("Procore form timed out");
  });

  it("a re-confirmed denial is terminal (not actionable)", async () => {
    const detail = await getRfpReviewDetail(
      makeReadDb({ ...baseRow, reviewedAt: "2026-06-04T00:00:00Z", reviewDecision: "denial_reconfirmed" }),
      "deal-1"
    );
    expect(detail?.actionable).toBe(false);
  });

  it("an approved deal is not actionable", async () => {
    const detail = await getRfpReviewDetail(makeReadDb({ ...baseRow, rfpApprovalStatus: "approved" }), "deal-1");
    expect(detail?.actionable).toBe(false);
  });

  it("returns null when the deal is missing", async () => {
    expect(await getRfpReviewDetail(makeReadDb(null), "missing")).toBeNull();
  });
});
