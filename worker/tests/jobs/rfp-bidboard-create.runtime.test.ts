import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleRfpBidBoardCreate, runRfpBidBoardCreateDeadLetterSweep } from "../../src/jobs/rfp-bidboard-create.js";

const SECRET = "shared-secret";

function makePayload() {
  return {
    dealId: "deal-1",
    syncHubUrl: "https://synchub.example.com/api/bid-board/create-from-rfp",
    body: {
      sourceSystem: "trock_crm",
      sourceDealId: "deal-1",
      sourceEventId: "crm:rfp-vote:approved:round-1",
      deal: { name: "jasonn ranches", projectNumber: "TR-1001", projectType: "9", amount: 100000, workflowRoute: "normal", estimator: null, ownerName: null, ownerEmail: null, companyName: null, contactName: null, clientEmail: null, clientPhone: null, address: null, description: null, dueDate: null },
      attachments: [],
      decision: "approved",
    },
  };
}

// A db mock for the pre-POST deal recheck (finding): answers the office-schema lookup + the deals recheck SELECT.
// Default = a still-creatable 2/3-yes deal; pass null for a deleted/not-found deal, or override the deal fields.
function recheckDb(deal: any = { is_active: true, rfp_approval_status: "pending", rfp_approval_request_id: null, rfp_override_state: null, rfp_approval_request_event_id: "round-1" }) {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM public.offices")) return { rows: [{ slug: "test" }] };
      if (/\.deals\b/.test(sql)) return { rows: deal ? [deal] : [] };
      return { rows: [] };
    },
  } as any;
}

describe("handleRfpBidBoardCreate", () => {
  it("HMAC-POSTs the body (with decision:'approved') to the create-from-rfp URL", async () => {
    const captured: any = {};
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured.url = url;
      captured.init = init;
      return { status: 202, ok: true, text: async () => "" } as any;
    });
    await handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET, db: recheckDb() });

    expect(captured.url).toBe("https://synchub.example.com/api/bid-board/create-from-rfp");
    expect(captured.init.method).toBe("POST");
    const sentBody = JSON.parse(captured.init.body);
    expect(sentBody.decision).toBe("approved");
    expect(sentBody.sourceDealId).toBe("deal-1");
    expect(sentBody.deal.projectNumber).toBe("TR-1001");

    const expectedSig = `sha256=${crypto.createHmac("sha256", SECRET).update(captured.init.body).digest("hex")}`;
    expect(captured.init.headers["x-rfp-request-signature"]).toBe(expectedSig);
  });

  // The create worker's recheck existed but was UNLOCKED, so it was advisory rather than binding: it
  // could observe a live create round a microsecond before "Move back to Opportunity" committed and POST
  // anyway. rfp_request_delivery took the deal_rfp_delivery lock for exactly this reason in round 7;
  // this sibling did not, and ITS orphan is worse — a stray Bid Board PROJECT can never be linked back
  // (the bid-board-created callback requires the round state the move-back cleared), so the CRM has no
  // record it exists at all.
  //
  // Pins the SEQUENCE, not just that a lock happened: the lock must be the first statement inside the
  // transaction and must precede the deal read, matching the order the move-back now uses.
  it("authorizes the create under the deal_rfp_delivery lock, taken BEFORE the deal read", async () => {
    const statements: string[] = [];
    const params: unknown[][] = [];
    const release = vi.fn();
    const db = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async (sql: string, p?: unknown[]) => {
          statements.push(sql);
          params.push(p ?? []);
          if (sql.includes("FROM public.offices")) return { rows: [{ slug: "test" }] };
          if (/\.deals\b/.test(sql)) {
            return {
              rows: [{
                is_active: true,
                rfp_approval_status: "pending",
                rfp_approval_request_id: null,
                rfp_override_state: null,
                rfp_approval_request_event_id: "round-1",
              }],
            };
          }
          return { rows: [] };
        },
        release,
      }),
    } as any;
    // resolveOfficeSchema runs against the pool, not the locked client, so answer it there too.
    db.query = async (sql: string) =>
      sql.includes("FROM public.offices") ? { rows: [{ slug: "test" }] } : { rows: [] };

    let fetchedAfter = -1;
    const fetchImpl = vi.fn(async () => {
      fetchedAfter = statements.length;
      return { status: 202, ok: true, text: async () => "" } as any;
    });

    await handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET, db });

    const lockIdx = statements.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const readIdx = statements.findIndex((s) => /\.deals\b/.test(s));
    const commitIdx = statements.findIndex((s) => s === "COMMIT");

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThanOrEqual(0);
    // Same lock KEY as the delivery worker — the move-back takes one lock per deal, so both workers must
    // contend on it or it only serializes against one of them.
    expect(params[lockIdx][0]).toBe("deal_rfp_delivery:deal-1");
    // ORDER: lock first, then read.
    expect(lockIdx).toBeLessThan(readIdx);
    expect(statements[0]).toBe("BEGIN");
    // And the POST happens OUTSIDE the transaction — a db transaction must not span an outbound HTTP call.
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(fetchedAfter).toBeGreaterThan(commitIdx);
    expect(release).toHaveBeenCalled();
  });

  it("throws on a non-2xx SyncHub response so the job retries", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 500, ok: false, text: async () => "boom" } as any));
    await expect(
      handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET, db: recheckDb() }),
    ).rejects.toThrow(/rfp_bidboard_create failed with 500/);
  });

  it("[finding] SKIPS the POST for a deal soft-deleted / returned since approve (no orphaned Bid Board project)", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 202, ok: true, text: async () => "" } as any));
    // Deleted (not found) -> skip.
    await handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET, db: recheckDb(null) });
    // Soft-deleted -> skip.
    await handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET, db: recheckDb({ is_active: false, rfp_approval_status: "pending", rfp_approval_request_id: null }) });
    // Returned to Opportunity (status cleared) -> skip.
    await handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET, db: recheckDb({ is_active: true, rfp_approval_status: null, rfp_approval_request_id: null }) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[finding] POSTs for an override-approve deal still in declined+approving", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 202, ok: true, text: async () => "" } as any));
    await handleRfpBidBoardCreate(makePayload(), "office-9", {
      fetchImpl: fetchImpl as any, secret: SECRET,
      db: recheckDb({ is_active: true, rfp_approval_status: "declined", rfp_approval_request_id: null, rfp_override_state: "approving", rfp_approval_request_event_id: "round-1" }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[finding] SKIPS the POST when the deal is on a DIFFERENT round than the job's payload (Returned + re-triggered)", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 202, ok: true, text: async () => "" } as any));
    // Active + pending + request-less, but a FRESH round opened (different event id) than the job's payload round.
    await handleRfpBidBoardCreate(makePayload(), "office-9", {
      fetchImpl: fetchImpl as any, secret: SECRET,
      db: recheckDb({ is_active: true, rfp_approval_status: "pending", rfp_approval_request_id: null, rfp_override_state: null, rfp_approval_request_event_id: "round-2" }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[finding] fails OPEN (posts anyway) when the recheck query errors", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 202, ok: true, text: async () => "" } as any));
    const errDb = { query: async () => { throw new Error("db blip"); } } as any;
    await handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET, db: errDb });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("runRfpBidBoardCreateDeadLetterSweep", () => {
  // A single-client mock for the happy path: the batch candidate SELECT (LIMIT $1) returns one dead row, the
  // per-row re-lock (WHERE id = $1) confirms it's still claimable, the office resolves, and the deal update runs.
  function makeHappyClient(overrides: { officeSlug?: string | null } = {}) {
    const dealUpdates: unknown[][] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      // Batch candidate SELECT (reads only, no 'claimed' write).
      if (sql.includes("FROM public.job_queue") && sql.includes("LIMIT $1")) {
        return {
          rows: [{
            id: 91,
            office_id: "office-1",
            last_error: "rfp_bidboard_create failed with 500: boom",
            created_at: "2026-07-01T00:00:00.000Z",
            payload: { dealId: "deal-9", syncHubUrl: "https://synchub.example.com", body: {} },
          }],
        };
      }
      // Per-row re-lock inside the txn.
      if (sql.includes("FROM public.job_queue") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        return { rows: [{ id: 91 }] };
      }
      if (sql.includes("SELECT slug FROM public.offices")) {
        // requireActive:false — a since-deactivated office's dead job still gets its deal marked.
        expect(sql).not.toContain("is_active = true");
        return { rows: overrides.officeSlug === undefined ? [{ slug: "dallas" }] : [{ slug: overrides.officeSlug }] };
      }
      if (sql.includes("rfp_override_state = 'failed'")) {
        dealUpdates.push(params ?? []);
        return { rows: [] };
      }
      return { rows: [] };
    });
    return { query, dealUpdates };
  }

  it("stamps a visible send_failed + override 'failed' marker on the deal for an exhausted create job", async () => {
    const { query: clientQuery, dealUpdates } = makeHappyClient();
    const release = vi.fn();
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release })) };

    const handled = await runRfpBidBoardCreateDeadLetterSweep({ db });

    expect(handled).toBe(1);
    const sqlText = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain('"office_dallas".deals');
    expect(sqlText).toContain("rfp_override_state = 'failed'");
    // finding #2 + G4: the 2/3-yes sub-case ('pending') is driven to the VISIBLE, recoverable send_failed status,
    // while the override sub-case ('declined') is KEPT declined so the review buttons stay usable — a CASE expr.
    expect(sqlText).toContain("CASE WHEN rfp_approval_status = 'pending' THEN 'send_failed' ELSE rfp_approval_status END");
    expect(sqlText).toContain("rfp_approval_request_id IS NULL");
    // never touches an already-approved deal or a re-confirmed denial
    expect(sqlText).toContain("rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'");
    expect(sqlText).toContain("rfp_approval_status = 'pending'");
    // marks the job handled so it isn't reprocessed
    expect(sqlText).toContain("jsonb_set(payload, '{dealHandled}'");
    // finding F5: per-attempt freshness — a dead job from a PRIOR attempt (created_at < the deal's current
    // rfp_bidboard_attempt_at) must be skipped. The update carries the job's created_at ($3) and the SQL gates on it.
    expect(sqlText).toContain("rfp_bidboard_attempt_at IS NULL");
    expect(sqlText).toContain("$3::timestamptz >= rfp_bidboard_attempt_at");
    // finding W3: the override sub-case's freshness (reviewed_at) is ALSO enforced (attempt_at is NULL for it).
    expect(sqlText).toContain("rfp_override_reviewed_at IS NULL");
    expect(sqlText).toContain("$3::timestamptz >= rfp_override_reviewed_at");
    // finding (cross-round): a dead job from an OLD round can't mark a freshly-reopened round send_failed (both
    // per-attempt markers are NULL again) — the job created_at ($3) must be no older than the current round's open.
    expect(sqlText).toContain("rfp_approval_requested_at IS NULL");
    expect(sqlText).toContain("$3::timestamptz >= rfp_approval_requested_at");
    // finding W8: the visible send_failed reason is populated for the pending sub-case.
    expect(sqlText).toContain("rfp_last_attempt_error = CASE WHEN rfp_approval_status = 'pending' THEN $1");
    // the deal update is keyed by the job's dealId + carries the exhaustion error + the job's created_at (freshness)
    expect(dealUpdates).toHaveLength(1);
    expect(dealUpdates[0]?.[0]).toBe("rfp_bidboard_create failed with 500: boom");
    expect(dealUpdates[0]?.[1]).toBe("deal-9");
    expect(dealUpdates[0]?.[2]).toBe("2026-07-01T00:00:00.000Z");
    expect(release).toHaveBeenCalled();
  });

  it("writes the 'claimed' marker INSIDE the per-job txn (after re-lock), not in the batch SELECT", async () => {
    // finding #4: the batch candidate SELECT must NOT write 'claimed'; the claim happens after BEGIN so it can be
    // rolled back on failure. Assert the ordering: BEGIN -> re-lock -> claim marker (all before the deal update).
    const { query: clientQuery } = makeHappyClient();
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })) };

    await runRfpBidBoardCreateDeadLetterSweep({ db });

    const calls = clientQuery.mock.calls.map((call) => String(call[0]));
    const batchIdx = calls.findIndex((s) => s.includes("FROM public.job_queue") && s.includes("LIMIT $1"));
    const beginIdx = calls.findIndex((s) => s === "BEGIN");
    const claimIdx = calls.findIndex((s) => s.includes('jsonb_set(payload, \'{dealHandled}\', \'"claimed"'));
    // The batch SELECT (which never writes 'claimed') runs first, and the 'claimed' write happens AFTER BEGIN.
    expect(batchIdx).toBeGreaterThanOrEqual(0);
    expect(beginIdx).toBeGreaterThan(batchIdx);
    expect(claimIdx).toBeGreaterThan(beginIdx);
    // The batch SELECT itself must NOT write the marker (no jsonb_set) — proving 'claimed' isn't pre-committed
    // outside the txn. (Its WHERE filter mentions 'claimed' as a retryable value, but it performs no write.)
    expect(calls[batchIdx]).not.toContain("jsonb_set");
  });

  it("leaves the job RETRYABLE (not stuck 'claimed') when the per-job handler throws after the claim", async () => {
    // finding #4: a throw AFTER the 'claimed' write (here: office-schema resolve fails) must ROLLBACK — undoing the
    // 'claimed' marker in the SAME txn — and must NOT COMMIT or mark the job dealHandled='true'.
    const { query: clientQuery, dealUpdates } = makeHappyClient({ officeSlug: null }); // bad slug -> resolveOfficeSchema throws
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })) };

    const handled = await runRfpBidBoardCreateDeadLetterSweep({ db });

    expect(handled).toBe(0);
    const calls = clientQuery.mock.calls.map((call) => String(call[0]));
    // The claim WAS attempted inside the txn...
    expect(calls.some((s) => s.includes('jsonb_set(payload, \'{dealHandled}\', \'"claimed"'))).toBe(true);
    // ...and the txn ROLLED BACK (so the claim is undone -> row stays unclaimed/retryable)...
    expect(calls).toContain("ROLLBACK");
    // ...never committing, and never marking the job done ('true') or updating the deal.
    expect(calls).not.toContain("COMMIT");
    expect(calls.some((s) => s.includes('jsonb_set(payload, \'{dealHandled}\', \'true\''))).toBe(false);
    expect(dealUpdates).toHaveLength(0);
  });

  it("atomically claims dead rows so concurrent sweep ticks do not double-process one row", async () => {
    // Concurrency is now enforced by the per-row re-lock (FOR UPDATE SKIP LOCKED on WHERE id = $1): both ticks'
    // batch SELECT can return the same candidate, but only the first re-lock wins; the second gets 0 rows.
    let rowLocked = false;
    const dealUpdates: unknown[][] = [];
    const makeClient = () => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        // Batch candidate SELECT — both ticks see the candidate.
        if (sql.includes("FROM public.job_queue") && sql.includes("LIMIT $1")) {
          return {
            rows: [{
              id: 92,
              office_id: "office-1",
              last_error: "exhausted",
              payload: { dealId: "deal-9", syncHubUrl: "https://synchub.example.com", body: {} },
            }],
          };
        }
        // Per-row re-lock — first caller wins the row, the concurrent caller is skipped (SKIP LOCKED -> 0 rows).
        if (sql.includes("FROM public.job_queue") && sql.includes("FOR UPDATE SKIP LOCKED")) {
          if (rowLocked) return { rows: [] };
          rowLocked = true;
          return { rows: [{ id: 92 }] };
        }
        if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "dallas" }] };
        if (sql.includes("rfp_override_state = 'failed'")) {
          dealUpdates.push(params ?? []);
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const db = { query: vi.fn(), connect: vi.fn(async () => makeClient()) };

    const [first, second] = await Promise.all([
      runRfpBidBoardCreateDeadLetterSweep({ db }),
      runRfpBidBoardCreateDeadLetterSweep({ db }),
    ]);

    expect([first, second].sort()).toEqual([0, 1]);
    expect(dealUpdates).toHaveLength(1);
  });
});
