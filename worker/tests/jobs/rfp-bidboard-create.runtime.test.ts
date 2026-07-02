import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleRfpBidBoardCreate } from "../../src/jobs/rfp-bidboard-create.js";

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
