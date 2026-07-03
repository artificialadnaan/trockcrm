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

describe("handleRfpBidBoardCreate", () => {
  it("HMAC-POSTs the body (with decision:'approved') to the create-from-rfp URL", async () => {
    const captured: any = {};
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured.url = url;
      captured.init = init;
      return { status: 202, ok: true, text: async () => "" } as any;
    });
    await handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET });

    expect(captured.url).toBe("https://synchub.example.com/api/bid-board/create-from-rfp");
    expect(captured.init.method).toBe("POST");
    const sentBody = JSON.parse(captured.init.body);
    expect(sentBody.decision).toBe("approved");
    expect(sentBody.sourceDealId).toBe("deal-1");
    expect(sentBody.deal.projectNumber).toBe("TR-1001");

    const expectedSig = `sha256=${crypto.createHmac("sha256", SECRET).update(captured.init.body).digest("hex")}`;
    expect(captured.init.headers["x-rfp-request-signature"]).toBe(expectedSig);
  });

  it("throws on a non-2xx SyncHub response so the job retries", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 500, ok: false, text: async () => "boom" } as any));
    await expect(
      handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET }),
    ).rejects.toThrow(/rfp_bidboard_create failed with 500/);
  });
});

describe("runRfpBidBoardCreateDeadLetterSweep", () => {
  it("stamps a visible override 'failed' marker on the deal for an exhausted create job", async () => {
    const dealUpdates: unknown[][] = [];
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM public.job_queue") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        return {
          rows: [{
            id: 91,
            office_id: "office-1",
            last_error: "rfp_bidboard_create failed with 500: boom",
            payload: { dealId: "deal-9", syncHubUrl: "https://synchub.example.com", body: {} },
          }],
        };
      }
      if (sql.includes("SELECT slug FROM public.offices")) {
        // requireActive:false — a since-deactivated office's dead job still gets its deal marked.
        expect(sql).not.toContain("is_active = true");
        return { rows: [{ slug: "dallas" }] };
      }
      if (sql.includes("rfp_override_state = 'failed'")) {
        dealUpdates.push(params ?? []);
        return { rows: [] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const db = { query: vi.fn(), connect: vi.fn(async () => ({ query: clientQuery, release })) };

    const handled = await runRfpBidBoardCreateDeadLetterSweep({ db });

    expect(handled).toBe(1);
    const sqlText = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain('"office_dallas".deals');
    expect(sqlText).toContain("rfp_override_state = 'failed'");
    // never touches an already-approved deal or a re-confirmed denial
    expect(sqlText).toContain("rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'");
    expect(sqlText).toContain("rfp_approval_status = 'pending'");
    // marks the job handled so it isn't reprocessed
    expect(sqlText).toContain("jsonb_set(payload, '{dealHandled}'");
    // the deal update is keyed by the job's dealId + carries the exhaustion error
    expect(dealUpdates).toHaveLength(1);
    expect(dealUpdates[0]?.[0]).toBe("rfp_bidboard_create failed with 500: boom");
    expect(dealUpdates[0]?.[1]).toBe("deal-9");
    expect(release).toHaveBeenCalled();
  });

  it("atomically claims dead rows so concurrent sweep ticks do not double-process one row", async () => {
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
              id: 92,
              office_id: "office-1",
              last_error: "exhausted",
              payload: { dealId: "deal-9", syncHubUrl: "https://synchub.example.com", body: {} },
            }],
          };
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
