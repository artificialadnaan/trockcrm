import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRfpRequestDelivery, runRfpRequestDeadLetterSweep } from "../../src/jobs/rfp-request-delivery.js";

function makeDb() {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "dallas" }] };
    return { rows: [] };
  });
  return { query };
}

function makePayload(sourceEventId = "event-1") {
  return {
    dealId: "deal-1",
    syncHubUrl: "https://synchub.example.com/api/rfp-requests",
    body: {
      sourceSystem: "trock_crm",
      sourceDealId: "deal-1",
      sourceEventId,
      deal: { name: "Deal", projectNumber: "DFW-1", projectType: "4" },
      attachments: [],
    },
  };
}

/**
 * A sourceEventId in the form the round guard can actually parse.
 *
 * The bare "event-1" default does NOT match, and that is the fail-open path — worth keeping as the default
 * because it is what most historical payloads look like, but useless on its own for proving the guard binds
 * anything. Both shapes are exercised below.
 */
const ROUND_EVENT_ID = "crm:deal-stage:opportunity:round-77";

describe("handleRfpRequestDelivery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([201, 200])("marks the deal pending after SyncHub %s", async (status) => {
    const db = makeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ requestId: 123, token: "tok" }), { status }));

    await handleRfpRequestDelivery(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      secret: "secret",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://synchub.example.com/api/rfp-requests",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-rfp-request-signature": expect.stringMatching(/^sha256=/) }),
      })
    );
    const updateSql = db.query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(updateSql).toContain("rfp_approval_status = 'pending'");
    // Four params, not three: the write-back is bound to the ROUND it answers. Null here is the deliberate
    // fail-open — "event-1" is not a parseable round id — see the round-guard cases below.
    expect(db.query.mock.calls.at(-1)?.[1]).toEqual([123, "tok", "deal-1", null]);
  });

  it("clears the override-cycle fields when a new RFP cycle starts (stale override state can't leak across cycles)", async () => {
    const db = makeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ requestId: 56, token: "tok" }), { status: 201 }));

    await handleRfpRequestDelivery(makePayload(), "office-1", { db, fetchImpl: fetchImpl as any, secret: "secret" });

    const pendingUpdate = db.query.mock.calls.map((c) => String(c[0])).find((s) => s.includes("rfp_approval_status = 'pending'"));
    expect(pendingUpdate).toBeDefined();
    // A re-opened deal must start its new cycle with CLEAN override state. Otherwise a stale 'denial_reconfirmed'
    // makes reconfirmRfpDecline's guard match 0 rows and suppresses the new cycle's re-confirm email (#651), and a
    // stale 'override_approved' was the #653 risk. Clear every override-cycle field here.
    expect(pendingUpdate).toContain("rfp_override_decision = NULL");
    expect(pendingUpdate).toContain("rfp_override_reviewed_at = NULL");
    expect(pendingUpdate).toContain("rfp_override_reviewed_by = NULL");
    expect(pendingUpdate).toContain("rfp_override_note = NULL");
    expect(pendingUpdate).toContain("rfp_override_state = NULL");
    expect(pendingUpdate).toContain("rfp_override_error = NULL");
  });

  it("marks the deal conflict on SyncHub 409 and completes successfully", async () => {
    const db = makeDb();
    const conflict = { sourceSystem: "hubspot", sourceDealId: "hs-1" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "pending_collision", conflict }), { status: 409 }));

    await handleRfpRequestDelivery(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      secret: "secret",
    });

    const updateSql = db.query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(updateSql).toContain("rfp_approval_status = 'conflict'");
    expect(db.query.mock.calls.at(-1)?.[1]).toEqual(["pending_collision", JSON.stringify(conflict), "deal-1", null]);
  });

  // The round guard, which this file did not previously know about.
  //
  // This job writes back BY DEAL ID from a payload snapshot taken when the delivery was queued. Two things
  // can happen while it is in flight: "Move back to Opportunity" clears the RFP cycle, or a move-back
  // followed by a fresh trigger starts a NEW round. Without binding the response to the round that produced
  // it, a late reply either resurrects a cleared cycle or overwrites the new round's request id and token
  // with the old round's — silently, and with no way to tell afterwards which round the stored token belongs
  // to. Asserting only the fail-open null (as the cases above do) would leave that unpinned.
  it.each([
    ["the success path", 201, { requestId: 123, token: "tok" }, "rfp_approval_status = 'pending'"],
    ["the conflict path", 409, { error: "pending_collision", conflict: {} }, "rfp_approval_status = 'conflict'"],
  ])("binds %s write-back to the round that produced it", async (_label, status, body, marker) => {
    const db = makeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status }));

    await handleRfpRequestDelivery(makePayload(ROUND_EVENT_ID), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      secret: "secret",
    });

    const update = db.query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes(marker));
    expect(update).toBeDefined();
    // Both halves of the guard: a cleared cycle fails the status predicate, a DIFFERENT round fails the
    // identity one. Either alone lets one of the two races through.
    expect(update).toContain("rfp_approval_status IN ('pending_outbox', 'pending')");
    expect(update).toContain("rfp_approval_request_event_id");
    expect(db.query.mock.calls.at(-1)?.[1]?.at(-1)).toBe("round-77");
  });

  // Fail-open is a decision, not an oversight: an over-eager guard would stop EVERY delivery whose payload
  // predates the round-stamped event id, which is far worse than the drift it prevents.
  it("passes a null round for a payload whose event id carries no round, rather than refusing to write", async () => {
    const db = makeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ requestId: 9, token: "t" }), { status: 201 }));

    await handleRfpRequestDelivery(makePayload("some-unparseable-id"), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      secret: "secret",
    });

    const update = db.query.mock.calls.map((c) => String(c[0])).find((s) => s.includes("rfp_approval_status = 'pending'"));
    expect(update).toBeDefined();
    expect(db.query.mock.calls.at(-1)?.[1]?.at(-1)).toBeNull();
    // And the SQL itself tolerates that null rather than matching nothing.
    expect(update).toContain("$4::text IS NULL");
  });

  it.each([401, 422, 500])("throws on SyncHub %s so job_queue retries or deads the row", async (status) => {
    const db = makeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "bad" }), { status }));

    await expect(handleRfpRequestDelivery(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      secret: "secret",
    })).rejects.toThrow(`RFP delivery failed with ${status}`);
  });

  // TRK-2607-H3X6. A 413 means the body exceeded SyncHub's parser limit — retrying re-sends the
  // SAME bytes, so all 8 attempts are guaranteed to fail. The old behaviour burned ~2.7h of backoff
  // and then surfaced SyncHub's production-masked "Internal server error", which told the rep
  // nothing. Fail fast, and say what actually went wrong.
  it("dead-letters immediately on SyncHub 413 rather than retrying a body that can never shrink", async () => {
    const db = makeDb();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: "Internal server error" }), { status: 413 })
    );

    const result = await handleRfpRequestDelivery(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      secret: "secret",
    });

    expect(result).toMatchObject({ status: "dead" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The operator-facing message must explain the 413 instead of parroting SyncHub's mask.
    expect((result as { error: string }).error).toMatch(/too large/i);
    expect((result as { error: string }).error).toContain("413");
  });

  it("throws on network errors so job_queue retries", async () => {
    const db = makeDb();
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });

    await expect(handleRfpRequestDelivery(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      secret: "secret",
    })).rejects.toThrow("network down");
  });
});

describe("runRfpRequestDeadLetterSweep", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("marks dead delivery jobs handled and updates the deal as send_failed", async () => {
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM public.job_queue") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        return {
          rows: [{
            id: 55,
            office_id: "office-1",
            last_error: "bad secret",
            payload: { dealId: "deal-1", syncHubUrl: "https://synchub.example.com", body: {} },
          }],
        };
      }
      if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "dallas" }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release })) };

    const handled = await runRfpRequestDeadLetterSweep({ db });

    expect(handled).toBe(1);
    const sqlText = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("rfp_approval_status = 'send_failed'");
    expect(sqlText).toContain("jsonb_set(payload, '{dealHandled}'");
    expect(release).toHaveBeenCalled();
  });

  it("handles dead jobs for inactive offices during cleanup", async () => {
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM public.job_queue") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        return {
          rows: [{
            id: 56,
            office_id: "office-inactive",
            last_error: "bad secret",
            payload: { dealId: "deal-inactive", syncHubUrl: "https://synchub.example.com", body: {} },
          }],
        };
      }
      if (sql.includes("SELECT slug FROM public.offices")) {
        expect(sql).not.toContain("is_active = true");
        return { rows: [{ slug: "inactive_office" }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release })) };

    const handled = await runRfpRequestDeadLetterSweep({ db });

    expect(handled).toBe(1);
    const sqlText = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain('"office_inactive_office".deals');
    expect(sqlText).toContain("rfp_approval_status = 'send_failed'");
  });

  it("processes active and inactive office dead jobs in the same sweep", async () => {
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM public.job_queue") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        return {
          rows: [
            {
              id: 57,
              office_id: "office-active",
              last_error: "active failure",
              payload: { dealId: "deal-active", syncHubUrl: "https://synchub.example.com", body: {} },
            },
            {
              id: 58,
              office_id: "office-inactive",
              last_error: "inactive failure",
              payload: { dealId: "deal-inactive", syncHubUrl: "https://synchub.example.com", body: {} },
            },
          ],
        };
      }
      if (sql.includes("SELECT slug FROM public.offices")) {
        return { rows: [{ slug: params?.[0] === "office-active" ? "active" : "inactive" }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release })) };

    const handled = await runRfpRequestDeadLetterSweep({ db });

    expect(handled).toBe(2);
    const sqlText = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain('"office_active".deals');
    expect(sqlText).toContain('"office_inactive".deals');
  });

  it("continues processing the batch when one dead row fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM public.job_queue") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        return {
          rows: [
            {
              id: 59,
              office_id: "office-bad",
              last_error: "bad failure",
              payload: { dealId: "deal-bad", syncHubUrl: "https://synchub.example.com", body: {} },
            },
            {
              id: 60,
              office_id: "office-good",
              last_error: "good failure",
              payload: { dealId: "deal-good", syncHubUrl: "https://synchub.example.com", body: {} },
            },
          ],
        };
      }
      if (sql.includes("SELECT slug FROM public.offices")) {
        if (params?.[0] === "office-bad") {
          throw new Error("office lookup failed");
        }
        return { rows: [{ slug: "good" }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release })) };

    const handled = await runRfpRequestDeadLetterSweep({ db });

    expect(handled).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to handle dead RFP delivery job 59"),
      expect.any(Error)
    );
    const sqlText = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain('"office_good".deals');
  });

  it("atomically claims dead rows so concurrent sweep ticks do not process the same row twice", async () => {
    let claimed = false;
    const dealUpdates: unknown[][] = [];
    const makeClient = () => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("UPDATE public.job_queue") && sql.includes("RETURNING")) {
          if (claimed) return { rows: [] };
          claimed = true;
          return {
            rows: [{
              id: 61,
              office_id: "office-1",
              last_error: "bad secret",
              payload: { dealId: "deal-1", syncHubUrl: "https://synchub.example.com", body: {} },
            }],
          };
        }
        if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "dallas" }] };
        if (sql.includes("rfp_approval_status = 'send_failed'")) {
          dealUpdates.push(params ?? []);
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const db = { query: vi.fn(), connect: vi.fn(async () => makeClient()) };

    const [first, second] = await Promise.all([
      runRfpRequestDeadLetterSweep({ db }),
      runRfpRequestDeadLetterSweep({ db }),
    ]);

    expect([first, second].sort()).toEqual([0, 1]);
    expect(dealUpdates).toHaveLength(1);
  });

  it("leaves a failed claimed row claimed so the next sweep does not reprocess it", async () => {
    let claimedValue: undefined | "claimed" | "true";
    let dealUpdateAttempts = 0;
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("UPDATE public.job_queue") && sql.includes("RETURNING")) {
        if (claimedValue != null) return { rows: [] };
        claimedValue = "claimed";
        return {
          rows: [{
            id: 62,
            office_id: "office-1",
            last_error: "bad secret",
            payload: { dealId: "deal-1", syncHubUrl: "https://synchub.example.com", body: {} },
          }],
        };
      }
      if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "dallas" }] };
      if (sql.includes("rfp_approval_status = 'send_failed'")) {
        dealUpdateAttempts += 1;
        throw new Error("deal update failed");
      }
      if (sql.includes("jsonb_set(payload, '{dealHandled}'") && String(params?.[0]) === "62") {
        claimedValue = "true";
        return { rows: [] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release })) };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await runRfpRequestDeadLetterSweep({ db });
    const second = await runRfpRequestDeadLetterSweep({ db });

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(claimedValue).toBe("claimed");
    expect(dealUpdateAttempts).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to handle dead RFP delivery job 62"),
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });
});
