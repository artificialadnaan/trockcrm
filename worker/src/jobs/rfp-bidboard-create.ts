import crypto from "node:crypto";
import type { RfpRequestDeliveryPayload } from "@trock-crm/shared/types";

export const RFP_BIDBOARD_CREATE_JOB = "rfp_bidboard_create";

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function assertPayload(payload: any): asserts payload is RfpRequestDeliveryPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid rfp_bidboard_create payload");
  }
  if (typeof payload.dealId !== "string" || typeof payload.syncHubUrl !== "string") {
    throw new Error("rfp_bidboard_create payload is missing dealId or syncHubUrl");
  }
  if (!payload.body || typeof payload.body !== "object") {
    throw new Error("rfp_bidboard_create payload is missing body");
  }
}

/**
 * GO delivery: HMAC-POST the normalized deal body (+ decision:'approved') to SyncHub's create-from-rfp
 * endpoint. Mirrors rfp-request-delivery.ts's signing (SYNCHUB_SHARED_SECRET == SyncHub's
 * RFP_REQUEST_SYNC_SECRET). Writes no deal state — SyncHub returns 202 and the deal advances later via the
 * bid-board-created callback. A non-2xx throws so the generic queue runner retries (maxAttempts=8).
 */
export async function handleRfpBidBoardCreate(
  payload: unknown,
  _officeId: string | null,
  deps: { fetchImpl?: typeof fetch; secret?: string } = {},
): Promise<void> {
  assertPayload(payload);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const secret = deps.secret ?? process.env.SYNCHUB_SHARED_SECRET;
  if (!secret) {
    throw new Error("SYNCHUB_SHARED_SECRET is not configured for rfp_bidboard_create delivery");
  }

  const rawBody = JSON.stringify(payload.body);
  let response: Response;
  try {
    response = await fetchImpl(payload.syncHubUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rfp-request-signature": signBody(rawBody, secret),
      },
      body: rawBody,
    });
  } catch (err) {
    throw new Error(`rfp_bidboard_create network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (response.status === 200 || response.status === 201 || response.status === 202) {
    return;
  }
  const text = await response.text().catch(() => "");
  throw new Error(`rfp_bidboard_create failed with ${response.status}: ${text || response.statusText}`);
}
