// What the REAL email transport does on the failures that decide whether leadership gets two digests.
//
// This file exists because a previous round's protection against the duplicate-digest bug was built on a
// stub that raised an exception, and the production stack cannot raise one. `resend@6` wraps its entire
// `fetch` in `try { ... } catch { return { data: null, error: { name: "application_error", statusCode:
// null } } }` (see `fetchRequest` in resend/dist), so a socket hang-up, a DNS failure, a gateway timeout
// and a 409 "an identical request is in flight" ALL come back as ordinary error results. Every one of them
// used to arrive at the caller as an undifferentiated `{success:false}`, indistinguishable from "the
// address was malformed and nothing was sent" — and the caller's ambiguity branch was therefore dead code.
//
// So nothing here mocks `resend`. It stubs `fetch` — the one boundary the SDK's own error handling sits
// INSIDE — and drives the real `sendSystemEmailWithMetadata`. A test that mocked the SDK could assert any
// shape it liked and would have caught none of this.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSystemEmailWithMetadata } from "../../src/lib/system-email.js";

const realFetch = globalThis.fetch;

/** Every request the SDK made. Nothing must reach the network. */
let fetchCalls: string[] = [];

function stubFetch(handler: () => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return handler();
  }) as typeof fetch;
}

/** A Resend-shaped JSON error body, as the API actually returns one. */
function errorResponse(status: number, name: string, message: string) {
  return new Response(JSON.stringify({ name, message, statusCode: status }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function send() {
  return sendSystemEmailWithMetadata("leadership@example.com", "Weekly reports due Thursday", "<p>x</p>", {
    text: "x",
    idempotencyKey: "weekly-report-digest-office_dallas-2026-08-13-abc",
  });
}

beforeEach(() => {
  fetchCalls = [];
  // A key is required or the sender short-circuits into its dev-mode branch and never builds a client.
  vi.stubEnv("RESEND_API_KEY", "re_test_transport_key");
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("sendSystemEmailWithMetadata: the real failure shapes", () => {
  it("does NOT throw when fetch itself rejects — it reports an UNKNOWN outcome", async () => {
    // The socket hang-up. The single claim the previous round's fix rested on was that this propagates as
    // an exception; it does not, which is why the exception handler was unreachable and the bug live.
    stubFetch(async () => {
      throw new Error("socket hang up");
    });

    const result = await send();

    expect(result).toEqual({ success: false, messageId: null, outcome: "unknown" });
    expect(fetchCalls).toHaveLength(1); // the request WAS attempted — that is what makes it ambiguous
  });

  it("reports UNKNOWN for a 504 gateway timeout, whose body is not even JSON", async () => {
    // A proxy 504 with an HTML body: resend fails to JSON.parse it and synthesises `application_error`
    // with the HTTP status. The message may already have been enqueued behind the gateway.
    stubFetch(async () => new Response("<html>504 Gateway Time-out</html>", { status: 504 }));

    expect(await send()).toEqual({ success: false, messageId: null, outcome: "unknown" });
  });

  it("reports UNKNOWN for a 500 with a well-formed error body", async () => {
    stubFetch(async () => errorResponse(500, "application_error", "Internal server error"));

    expect(await send()).toEqual({ success: false, messageId: null, outcome: "unknown" });
  });

  it("reports UNKNOWN for 409 concurrent_idempotent_requests — the original is still in flight", async () => {
    // The outcome that decides this is the ORIGINAL request's, and we have not seen it. Re-sending under a
    // rotated key would put a second copy in front of leadership.
    stubFetch(async () =>
      errorResponse(409, "concurrent_idempotent_requests", "Same idempotency key is being processed"),
    );

    expect(await send()).toEqual({ success: false, messageId: null, outcome: "unknown" });
  });

  it("reports REJECTED for a 422 validation error — provably no email exists", async () => {
    // The case option (b) would have stranded forever: a malformed recipient is fixable and the retry must
    // happen, so this one MUST stay distinguishable from the ambiguous failures above.
    stubFetch(async () => errorResponse(422, "validation_error", "Invalid `to` field"));

    expect(await send()).toEqual({ success: false, messageId: null, outcome: "rejected" });
  });

  it("reports REJECTED for a 401 bad API key and a 429 rate limit", async () => {
    stubFetch(async () => errorResponse(401, "restricted_api_key", "This API key is restricted"));
    expect(await send()).toEqual({ success: false, messageId: null, outcome: "rejected" });

    stubFetch(async () => errorResponse(429, "rate_limit_exceeded", "Too many requests"));
    expect(await send()).toEqual({ success: false, messageId: null, outcome: "rejected" });
  });

  it("reports DELIVERED on success, and on the already-delivered idempotency answer", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ id: "msg-1" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    expect(await send()).toEqual({ success: true, messageId: "msg-1", outcome: "delivered" });

    // 409 invalid_idempotent_request = this key already went out under a DIFFERENT payload, i.e. delivered.
    stubFetch(async () =>
      errorResponse(409, "invalid_idempotent_request", "Idempotency key reused with a different payload"),
    );
    expect(await send()).toEqual({ success: true, messageId: null, outcome: "delivered" });
  });

  it("keeps success and outcome in lockstep — `success === (outcome === 'delivered')`", async () => {
    // The invariant every existing caller relies on. Callers that only read `success` must be unaffected by
    // the widening, and a future outcome added without a matching `success` would break them silently.
    const cases: Array<() => Promise<Response>> = [
      async () => {
        throw new Error("socket hang up");
      },
      async () => errorResponse(500, "application_error", "boom"),
      async () => errorResponse(422, "validation_error", "bad"),
      async () => errorResponse(409, "concurrent_idempotent_requests", "in flight"),
      async () => errorResponse(409, "invalid_idempotent_request", "already sent"),
      async () =>
        new Response(JSON.stringify({ id: "msg-2" }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    for (const handler of cases) {
      stubFetch(handler);
      const result = await send();
      expect(result.success).toBe(result.outcome === "delivered");
    }
  });

  it("reports REJECTED without touching the network when there are no recipients", async () => {
    stubFetch(async () => new Response("{}", { status: 200 }));

    const result = await sendSystemEmailWithMetadata([], "Subject", "<p>x</p>");

    expect(result).toEqual({ success: false, messageId: null, outcome: "rejected" });
    expect(fetchCalls).toEqual([]); // nothing was sent, so a retry is safe
  });

  it("reports REJECTED when the API key is missing in production", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    stubFetch(async () => new Response("{}", { status: 200 }));

    const result = await sendSystemEmailWithMetadata("a@example.com", "Subject", "<p>x</p>");

    expect(result).toEqual({ success: false, messageId: null, outcome: "rejected" });
    expect(fetchCalls).toEqual([]);
  });
});
