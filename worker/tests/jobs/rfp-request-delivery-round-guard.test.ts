import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRfpRequestDelivery } from "../../src/jobs/rfp-request-delivery.js";

/**
 * "Move back to Opportunity" clears a deal's whole RFP cycle and cancels the queued delivery job in the
 * same transaction. A job the worker has ALREADY CLAIMED is beyond that transaction's reach, so the job
 * itself has to refuse — otherwise it POSTs its stale payload (creating an orphan SyncHub request) and
 * then writes rfp_approval_status back BY DEAL ID, repopulating the cycle. A non-null status is exactly
 * what re-arms the bid-board-created resurrection guard, so the repopulated cycle can let a later
 * callback re-attach a deal the operator deliberately disconnected.
 *
 * Lives in worker/tests/jobs/ because worker/vitest.config.ts only collects `tests/**` — the sibling
 * suite at worker/src/jobs/rfp-request-delivery.test.ts is never executed.
 */
function makeDb(dealRows?: Array<{ rfp_approval_status: string | null }>) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "dallas" }] };
    // Default {rows: []} means "this mock cannot see the deal", which must NOT suppress delivery —
    // only a deal we actually read and found to be no longer awaiting does.
    if (sql.includes("SELECT rfp_approval_status")) return { rows: dealRows ?? [] };
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

describe("handleRfpRequestDelivery — stale-round guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT deliver when the RFP cycle was cleared while the job sat queued", async () => {
    const db = makeDb([{ rfp_approval_status: null }]);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));

    await handleRfpRequestDelivery(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as never,
      secret: "secret",
    });

    // No orphan external request, and nothing written back onto the deal.
    expect(fetchImpl).not.toHaveBeenCalled();
    const sql = db.query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).not.toContain("rfp_approval_status = 'pending'");
  });

  it("still delivers for a deal genuinely awaiting its request", async () => {
    const db = makeDb([{ rfp_approval_status: "pending_outbox" }]);
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ requestId: 9, token: "t" }), { status: 201 })
    );

    await handleRfpRequestDelivery(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as never,
      secret: "secret",
    });

    expect(fetchImpl).toHaveBeenCalled();
  });

  it("guards BOTH write-backs in SQL, not just the pre-POST read", async () => {
    // The pre-POST check only narrows the window; the SQL predicate is what actually closes the write
    // for a cycle cleared after the check.
    for (const [status, marker] of [
      [201, "rfp_approval_status = 'pending'"],
      [409, "rfp_approval_status = 'conflict'"],
    ] as const) {
      const db = makeDb([{ rfp_approval_status: "pending_outbox" }]);
      const fetchImpl = vi.fn(async () => new Response("{}", { status }));

      await handleRfpRequestDelivery(makePayload(), "office-1", {
        db,
        fetchImpl: fetchImpl as never,
        secret: "secret",
      });

      const write = db.query.mock.calls.map((c) => String(c[0])).find((s) => s.includes(marker));
      expect(write, `expected a write for HTTP ${status}`).toBeDefined();
      expect(write).toContain("rfp_approval_status IN ('pending_outbox', 'pending')");
    }
  });
});
