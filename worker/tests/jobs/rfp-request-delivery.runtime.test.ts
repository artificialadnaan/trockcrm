import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleRfpRequestDelivery } from "../../src/jobs/rfp-request-delivery.js";

describe("handleRfpRequestDelivery requester contract", () => {
  it("forwards the actual requester separately from the assigned deal owner", async () => {
    const secret = "shared-secret";
    const payload = {
      dealId: "deal-1",
      syncHubUrl: "https://synchub.example.com/api/rfp-requests",
      body: {
        sourceSystem: "trock_crm",
        sourceDealId: "deal-1",
        sourceEventId: "event-1",
        deal: {
          name: "Repair Project",
          projectNumber: "DFW-4-19526-aa",
          projectType: "4",
          ownerName: "Rep Owner",
          ownerEmail: "rep@trockgc.com",
          requestedByName: "Dana Director",
          requestedByEmail: "director@trockgc.com",
        },
        attachments: [],
      },
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT slug FROM public.offices")) return { rows: [{ slug: "dallas" }] };
        return { rows: [] };
      }),
    };
    const fetchImpl = vi.fn(async (_url: string, _request: RequestInit) =>
      new Response(JSON.stringify({ requestId: 123, token: "tok" }), { status: 201 })
    );

    await handleRfpRequestDelivery(payload, "office-1", {
      db,
      fetchImpl: fetchImpl as typeof fetch,
      secret,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = fetchImpl.mock.calls[0]?.[1];
    const rawBody = String(request?.body ?? "");
    expect(JSON.parse(rawBody).deal).toMatchObject({
      ownerName: "Rep Owner",
      ownerEmail: "rep@trockgc.com",
      requestedByName: "Dana Director",
      requestedByEmail: "director@trockgc.com",
    });
    expect(request?.headers).toMatchObject({
      "x-rfp-request-signature": `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    });
  });
});
