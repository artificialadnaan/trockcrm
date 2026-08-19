import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The public edge of the delivery webhook: what a request has to be for anything to happen, and what the
// endpoint tells the world about what it found.
//
// A REFUSAL-ONLY SUITE PROVES NOTHING. "Unsigned is rejected, wrong secret is rejected, tampered is
// rejected" all pass against a handler that rejects everything — which would silently discard every real
// bounce the provider ever sent, and look immaculate doing it. So the ingest is a spy and every refusal
// below is stated as BOTH the status code AND the fact that the ingest was never reached, paired against
// a control that proves a genuine event reaches it.
//
// The service is mocked at the module boundary rather than exercised: what it does with an event has its
// own runtime suite against a real Postgres. This file is about the HTTP contract.

const ingestMock = vi.fn();
vi.mock("../src/modules/weekly-reports/delivery-service.js", () => ({
  ingestWeeklyReportDeliveryEvent: ingestMock,
}));

const { weeklyReportDeliveryWebhookRoutes } = await import(
  "../src/modules/weekly-reports/delivery-webhook-routes.js"
);
const { signWeeklyReportWebhook } = await import(
  "../src/modules/weekly-reports/delivery-signature.js"
);
const { errorHandler } = await import("../src/middleware/error-handler.js");
const { WEEKLY_REPORT_DELIVERY_TAG } = await import("@trock-crm/shared/lib/weeklyReportDelivery");

const SECRET = "whsec_c2VjcmV0LWtleS1mb3ItdGVzdGluZy0xMjM0NTY3OA==";
const MESSAGE_ID = "msg_2abc3def4ghi";
const DELIVERY_KEY = "9f2a1c44-3f6b-4a2f-9d55-6e7c8b9a0d12";

function app() {
  const instance = express();
  // Mounted with NO express.json() ahead of it, exactly as app.ts mounts it. The signature covers the raw
  // bytes; a parser upstream would consume them and leave nothing to verify against.
  instance.use("/api/webhooks/resend", weeklyReportDeliveryWebhookRoutes);
  instance.use(errorHandler);
  return instance;
}

function bouncePayload() {
  return JSON.stringify({
    type: "email.bounced",
    created_at: "2026-08-13T21:04:00.000Z",
    data: {
      email_id: "e1f2a3b4-0000-4000-8000-000000000001",
      from: "crm@trockconstruction.com",
      to: ["jay@example.com"],
      subject: "Weekly Progress Report",
      created_at: "2026-08-13T20:59:00.000Z",
      tags: { [WEEKLY_REPORT_DELIVERY_TAG]: DELIVERY_KEY },
      bounce: { type: "Permanent", subType: "NoEmail", message: "550 5.1.1 user unknown" },
    },
  });
}

/** Sign for NOW, because the verifier's replay window is measured against the wall clock by design. */
function sign(payload: string, secret = SECRET) {
  const timestampSeconds = Math.floor(Date.now() / 1000);
  return {
    "svix-id": MESSAGE_ID,
    "svix-timestamp": String(timestampSeconds),
    "svix-signature": `v1,${signWeeklyReportWebhook({
      secret,
      messageId: MESSAGE_ID,
      timestampSeconds,
      payload,
    })}`,
  };
}

function post(payload: string, headers: Record<string, string>, contentType = "application/json") {
  return request(app())
    .post("/api/webhooks/resend")
    .set(headers)
    .set("Content-Type", contentType)
    .send(payload);
}

beforeEach(() => {
  ingestMock.mockReset();
  ingestMock.mockResolvedValue({
    outcome: "applied",
    target: { deliveryKey: DELIVERY_KEY, weeklyReportId: "r1", tenantId: "o1", officeSlug: "dallas" },
  });
  vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a correctly signed event is ACCEPTED and ingested — the control", () => {
  it("returns 202 and hands the parsed event to the service", async () => {
    const payload = bouncePayload();
    const response = await post(payload, sign(payload));

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "accepted" });
    expect(ingestMock).toHaveBeenCalledTimes(1);
    // The DELIVERY KEY off the message's own tag, and the PROVIDER'S event timestamp — not the email's
    // creation time in `data.created_at`, and not the time this request arrived.
    expect(ingestMock.mock.calls[0]![0]).toMatchObject({
      deliveryKey: DELIVERY_KEY,
      status: "bounced",
      occurredAt: "2026-08-13T21:04:00.000Z",
      detail: { bounceClass: "hard", eventType: "email.bounced" },
    });
  });
});

describe("an unsigned or wrongly signed request is REJECTED", () => {
  it("refuses a request with no signature headers and never reaches the service", async () => {
    const response = await post(bouncePayload(), {});
    expect(response.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("refuses a signature made with a different secret", async () => {
    const payload = bouncePayload();
    const response = await post(payload, sign(payload, "whsec_ZGlmZmVyZW50LXNlY3JldC0xMjM0NTY3OA=="));
    expect(response.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("refuses a body altered after it was signed", async () => {
    // The whole reason this router parses raw bytes instead of sitting behind express.json().
    const payload = bouncePayload();
    const headers = sign(payload);
    const response = await post(payload.replace("email.bounced", "email.delivered"), headers);
    expect(response.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("refuses a body smuggled under an unexpected Content-Type", async () => {
    // The oldest way past a raw-body verifier: choose a Content-Type the parser ignores so the body
    // arrives as `{}` and the signature is computed over nothing. `type: () => true` captures the bytes
    // whatever is claimed, so an UNSIGNED one is refused...
    const payload = bouncePayload();
    expect((await post(payload, {}, "text/plain")).status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();

    // ...and a correctly signed one still gets through, which is what proves the bytes really were read
    // rather than the odd Content-Type simply breaking everything.
    const signedResponse = await post(payload, sign(payload), "text/plain");
    expect(signedResponse.status).toBe(202);
    expect(ingestMock).toHaveBeenCalledTimes(1);
  });

  it("FAILS CLOSED when RESEND_WEBHOOK_SECRET is not configured", async () => {
    // A missed environment variable must not turn this into an open write endpoint against client report
    // state. Note the request is otherwise perfectly valid.
    const payload = bouncePayload();
    const headers = sign(payload);
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");

    const response = await post(payload, headers);
    expect(response.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("says nothing about WHY it refused", async () => {
    // "Bad signature" vs "stale timestamp" vs "no secret configured" is a free oracle for anyone probing
    // the endpoint, and the last would advertise a misconfiguration to the whole internet. Every refusal
    // is the same sentence; the reason goes to the log.
    const payload = bouncePayload();
    const bodies = [
      (await post(payload, {})).body,
      (await post(payload, sign(payload, "whsec_ZGlmZmVyZW50LXNlY3JldC0xMjM0NTY3OA=="))).body,
    ];
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    bodies.push((await post(payload, sign(payload))).body);

    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(bodies[0]).toEqual({ error: "Invalid signature" });
  });
});

describe("what a signed request is told about what we found", () => {
  it("answers identically whether the key resolved, lost, or was never minted", async () => {
    // A delivery key identifies one client's correspondence. An endpoint that answered differently for
    // "we have never heard of that key" would let anybody holding the URL enumerate them.
    const payload = bouncePayload();
    const responses = [];
    for (const outcome of ["applied", "superseded", "unmatched", "unknown_key"] as const) {
      ingestMock.mockResolvedValue({ outcome, target: outcome === "unknown_key" ? null : { officeSlug: "dallas" } });
      const response = await post(payload, sign(payload));
      responses.push({ status: response.status, body: response.body });
    }
    expect(new Set(responses.map((entry) => JSON.stringify(entry))).size).toBe(1);
    expect(responses[0]).toEqual({ status: 202, body: { status: "accepted" } });
  });

  it("accepts and ignores an event about an email that is not a weekly report", async () => {
    // The webhook is configured per provider ACCOUNT, so every system email this company sends arrives
    // here. A scorecard notification bouncing is the ORDINARY case, not an error — and answering
    // anything but 2xx would have the provider retry it forever.
    const payload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-08-13T21:04:00.000Z",
      data: { email_id: "e2", to: ["staff@trockconstruction.com"], tags: {} },
    });
    const response = await post(payload, sign(payload));

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "accepted" });
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("rejects a signed body that is not JSON, rather than telling the provider to stop", async () => {
    const payload = "{not json";
    const response = await post(payload, sign(payload));
    expect(response.status).toBe(400);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("answers 5xx when the ingest fails, so the provider RETRIES", async () => {
    // The provider is this feature's only retry mechanism. Swallowing a database failure into a cheerful
    // 202 would lose the one copy of a fact nothing else in the platform can reconstruct.
    ingestMock.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const payload = bouncePayload();
    const response = await post(payload, sign(payload));
    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
