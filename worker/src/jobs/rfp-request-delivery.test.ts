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
});
