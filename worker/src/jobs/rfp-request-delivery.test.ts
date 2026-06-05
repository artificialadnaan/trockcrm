import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRfpRequestDelivery, runRfpRequestDeadLetterSweep } from "./rfp-request-delivery.js";

function makeDb() {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "dallas" }] };
    return { rows: [] };
  });
  return { query };
}

function makePayload() {
  return {
    dealId: "deal-1",
    syncHubUrl: "https://synchub.example.com/api/rfp-requests",
    body: {
      sourceSystem: "trock_crm",
      sourceDealId: "deal-1",
      sourceEventId: "event-1",
      deal: { name: "Deal", projectNumber: "DFW-1", projectType: "4" },
      attachments: [],
    },
  };
}

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
    expect(db.query.mock.calls.at(-1)?.[1]).toEqual([123, "tok", "deal-1"]);
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
    expect(db.query.mock.calls.at(-1)?.[1]).toEqual(["pending_collision", JSON.stringify(conflict), "deal-1"]);
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
