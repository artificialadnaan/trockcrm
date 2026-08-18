import crypto from "node:crypto";
import { Resend } from "resend";
import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_WEBHOOK_TOLERANCE_SECONDS,
  signWeeklyReportWebhook,
  verifyWeeklyReportWebhookSignature,
} from "./delivery-signature.js";

// The gate on a world-reachable endpoint that writes to client-facing report state.
//
// A GUARD TESTED ONLY FOR REFUSAL PASSES EVEN IF IT REFUSES EVERYTHING, and a signature verifier that
// rejected every request would look flawless under "unsigned is rejected, wrong secret is rejected, stale
// is rejected" — while silently discarding every real bounce the provider ever sent. So the first test
// here is the CONTROL, and every refusal below is paired against it.
//
// AND THE CONTROL IS NOT SELF-REFERENTIAL. Verifying a signature this module produced only proves the
// module agrees with itself; it says nothing about whether the provider would produce the same bytes. The
// cross-check runs OUR signature through `resend`'s own `webhooks.verify()` — which is the SDK wrapping
// `svix` wrapping `standardwebhooks`, i.e. the real implementation the provider signs with. If our signed
// content, our key derivation or our encoding were wrong in any way, that call would throw.

/** A real-shaped signing secret: `whsec_` + base64. Fixed, so the suite is deterministic. */
const SECRET = "whsec_c2VjcmV0LWtleS1mb3ItdGVzdGluZy0xMjM0NTY3OA==";
const MESSAGE_ID = "msg_2abc3def4ghi";
const PAYLOAD = JSON.stringify({
  type: "email.bounced",
  created_at: "2026-08-13T21:04:00.000Z",
  data: { email_id: "e1", bounce: { type: "Permanent", subType: "NoEmail", message: "550" } },
});

/**
 * An ABSOLUTE instant for everything except the tolerance window.
 *
 * The tolerance is measured against the wall clock by definition — it is replay protection, not a stored
 * value — so those cases pass an explicit `now` and offset it by literal second counts rather than by
 * `WEEKLY_REPORT_WEBHOOK_TOLERANCE_SECONDS ± n`. Deriving the fixture from the constant makes the test
 * agree with any value the constant takes, including one that switches the protection off.
 */
const NOW = new Date("2026-08-13T21:04:30.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function headersFor(timestampSeconds: number, payload = PAYLOAD, secret = SECRET) {
  return {
    id: MESSAGE_ID,
    timestamp: String(timestampSeconds),
    signature: `v1,${signWeeklyReportWebhook({ secret, messageId: MESSAGE_ID, timestampSeconds, payload })}`,
  };
}

describe("a correctly signed webhook is ACCEPTED — the control", () => {
  it("accepts a signature this module produced", () => {
    const result = verifyWeeklyReportWebhookSignature({
      rawBody: Buffer.from(PAYLOAD, "utf8"),
      headers: headersFor(NOW_SECONDS),
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("produces bytes the PROVIDER'S OWN verifier accepts", () => {
    // The cross-check against the real dependency. `resend.webhooks.verify` delegates to svix, which
    // enforces its own ±5 minute window against the live clock — so this one case signs at `Date.now()`
    // rather than at the fixed instant above. The API key is never used by `verify`; the constructor only
    // requires one to exist.
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const headers = headersFor(timestampSeconds);
    const resend = new Resend("re_not_a_real_key");

    expect(() =>
      resend.webhooks.verify({ payload: PAYLOAD, headers, webhookSecret: SECRET }),
    ).not.toThrow();

    // AND THE NEGATIVE, so `not.toThrow()` above is not a vacuous claim about a verifier that never
    // throws. Read `node_modules/svix/dist/webhook.js` if this ever changes: it delegates to
    // `standardwebhooks`, whose `verify` raises `WebhookVerificationError` rather than returning a flag.
    expect(() =>
      resend.webhooks.verify({
        payload: PAYLOAD.replace("email.bounced", "email.delivered"),
        headers,
        webhookSecret: SECRET,
      }),
    ).toThrow();

    // And the same signature must satisfy US, so the two verifiers are pinned to each other rather than
    // each being pinned to its own signer.
    expect(
      verifyWeeklyReportWebhookSignature({
        rawBody: PAYLOAD,
        headers,
        secret: SECRET,
        now: new Date(timestampSeconds * 1000),
      }).ok,
    ).toBe(true);
  });

  it("accepts our v1 alongside signatures for other versions and other keys", () => {
    // How a secret is rotated without dropping events: the provider sends several, and taking only the
    // first — or refusing the whole header because one entry is unrecognised — breaks every send for the
    // length of the rotation.
    const good = signWeeklyReportWebhook({
      secret: SECRET,
      messageId: MESSAGE_ID,
      timestampSeconds: NOW_SECONDS,
      payload: PAYLOAD,
    });
    const result = verifyWeeklyReportWebhookSignature({
      rawBody: PAYLOAD,
      headers: {
        id: MESSAGE_ID,
        timestamp: String(NOW_SECONDS),
        signature: `v2,c29tZXRoaW5nRWxzZQ== v1,${crypto.randomBytes(32).toString("base64")} v1,${good}`,
      },
      secret: SECRET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts the secret with or without its `whsec_` prefix", () => {
    // The prefix is a human-facing label, not key material. Somebody pasting the secret without it must
    // not silently get an endpoint that refuses every event.
    const bare = SECRET.slice("whsec_".length);
    const headers = headersFor(NOW_SECONDS, PAYLOAD, bare);
    expect(verifyWeeklyReportWebhookSignature({ rawBody: PAYLOAD, headers, secret: SECRET, now: NOW }).ok).toBe(
      true,
    );
  });
});

describe("anything else is REJECTED", () => {
  it("rejects a request with no signature headers at all", () => {
    const result = verifyWeeklyReportWebhookSignature({
      rawBody: PAYLOAD,
      headers: {},
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects a signature made with a DIFFERENT secret", () => {
    const headers = headersFor(NOW_SECONDS, PAYLOAD, "whsec_ZGlmZmVyZW50LXNlY3JldC0xMjM0NTY3OA==");
    expect(verifyWeeklyReportWebhookSignature({ rawBody: PAYLOAD, headers, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
  });

  it("rejects a body that was altered after signing", () => {
    // The attack the raw-body requirement exists for: a valid signature over a payload that says
    // `delivered`, replayed with a body that says something else.
    const headers = headersFor(NOW_SECONDS);
    const tampered = PAYLOAD.replace("email.bounced", "email.delivered");
    expect(tampered).not.toBe(PAYLOAD);
    expect(
      verifyWeeklyReportWebhookSignature({ rawBody: tampered, headers, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it("rejects a signature bound to a different message id", () => {
    const headers = headersFor(NOW_SECONDS);
    expect(
      verifyWeeklyReportWebhookSignature({
        rawBody: PAYLOAD,
        headers: { ...headers, id: "msg_someone_elses" },
        secret: SECRET,
        now: NOW,
      }).ok,
    ).toBe(false);
  });

  it("rejects a timestamp outside the replay window, in BOTH directions", () => {
    // 301 seconds either side — literal, not `TOLERANCE + 1`. A test written the other way would still
    // pass with the tolerance raised to a year, which is the same as having none.
    const tooOld = NOW_SECONDS - 301;
    const tooNew = NOW_SECONDS + 301;
    expect(
      verifyWeeklyReportWebhookSignature({
        rawBody: PAYLOAD,
        headers: headersFor(tooOld),
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(
      verifyWeeklyReportWebhookSignature({
        rawBody: PAYLOAD,
        headers: headersFor(tooNew),
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });

    // And 299 seconds is still inside it — the control for the pair above, so a verifier that rejected
    // every timestamp could not pass this block.
    expect(
      verifyWeeklyReportWebhookSignature({
        rawBody: PAYLOAD,
        headers: headersFor(NOW_SECONDS - 299),
        secret: SECRET,
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it("states the window it enforces", () => {
    // A plain assertion on the constant, so changing it is a deliberate edit to a named number rather
    // than a quiet drift the relative fixtures above would follow.
    expect(WEEKLY_REPORT_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
  });

  it("rejects a timestamp that is not a whole number of seconds", () => {
    for (const timestamp of ["", "abc", "123abc", "1.5", " ", "9007199254740993"]) {
      expect(
        verifyWeeklyReportWebhookSignature({
          rawBody: PAYLOAD,
          headers: { id: MESSAGE_ID, timestamp, signature: "v1,x" },
          secret: SECRET,
          now: NOW,
        }).ok,
        timestamp,
      ).toBe(false);
    }
  });

  it("FAILS CLOSED when no secret is configured", () => {
    // The deploy where somebody forgets the environment variable. Accepting everything would turn that
    // into an unauthenticated write endpoint against client report state, silently.
    for (const secret of [undefined, null, "", "   "]) {
      expect(
        verifyWeeklyReportWebhookSignature({
          rawBody: PAYLOAD,
          headers: headersFor(NOW_SECONDS),
          secret,
          now: NOW,
        }),
      ).toEqual({ ok: false, reason: "no_secret" });
    }
  });

  it("rejects a signature offered only under an unknown version", () => {
    const good = signWeeklyReportWebhook({
      secret: SECRET,
      messageId: MESSAGE_ID,
      timestampSeconds: NOW_SECONDS,
      payload: PAYLOAD,
    });
    expect(
      verifyWeeklyReportWebhookSignature({
        rawBody: PAYLOAD,
        headers: { id: MESSAGE_ID, timestamp: String(NOW_SECONDS), signature: `v9,${good}` },
        secret: SECRET,
        now: NOW,
      }).ok,
    ).toBe(false);
  });
});
