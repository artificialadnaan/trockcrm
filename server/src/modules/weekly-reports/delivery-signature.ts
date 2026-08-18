import crypto from "node:crypto";

// The signature on the delivery webhook, verified over the RAW REQUEST BYTES.
//
// THE ENDPOINT IS PUBLIC AND WORLD-REACHABLE. Anyone can POST to it, so the signature is the only thing
// separating "the mail provider told us this report bounced" from "somebody on the internet said so". A
// forged event is not harmless: it can mark a report the client happily received as never delivered, or —
// worse — mark a genuinely bounced one as delivered and put the failure back out of sight.
//
// WHY THIS IS HAND-WRITTEN RATHER THAN A LIBRARY CALL. Resend signs with Standard Webhooks (the scheme
// Svix publishes), and the verifier it ships is reachable — `resend.webhooks.verify()` wraps
// `svix`'s `Webhook`, which wraps `standardwebhooks`. Two things argued against calling it: `new Resend()`
// throws without an API key, and this service does not need one (the WORKER sends the mail, the API only
// receives the events), so using the SDK here would mean holding a mail credential on a process that never
// mails anybody. And `svix` is a transitive dependency of `resend`, not a declared one — importing it
// directly would work today and break silently on a hoist change.
//
// So the scheme is implemented here, in twenty lines against node:crypto, and its EQUIVALENCE TO THE REAL
// LIBRARY IS PINNED BY A TEST: delivery-signature.test.ts signs a payload with this module and hands it to
// `resend`'s own verifier, which must accept it. A description of a wire format is not evidence; the
// provider's own code agreeing is.
//
// The wire format, for a reader who does not want to go and look:
//   svix-id         an opaque message id
//   svix-timestamp  unix SECONDS, as a decimal string
//   svix-signature  one or more space-separated `v<version>,<base64>` entries; only `v1` is understood
//   signed content  `${id}.${timestamp}.${rawBody}`
//   key             the secret's base64 body (after an optional `whsec_` prefix), decoded to bytes
//   signature       base64 of HMAC-SHA256(key, signedContent)

/**
 * How far the provider's timestamp may be from ours, in seconds. Matches the reference implementation's
 * 5 minutes.
 *
 * This is REPLAY PROTECTION, not clock tolerance: without it, a signature captured off the wire stays
 * valid forever and can be re-posted at will. Bounded either side, because a clock skewed forwards on
 * either end is as good as one skewed back.
 */
export const WEEKLY_REPORT_WEBHOOK_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = "whsec_";

export type WeeklyReportWebhookSignatureFailure =
  | "no_secret"
  | "missing_headers"
  | "bad_timestamp"
  | "stale_timestamp"
  | "no_matching_signature";

export type WeeklyReportWebhookSignatureResult =
  | { ok: true }
  | { ok: false; reason: WeeklyReportWebhookSignatureFailure };

export interface WeeklyReportWebhookHeaders {
  id?: string | string[] | undefined;
  timestamp?: string | string[] | undefined;
  signature?: string | string[] | undefined;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length === 1 ? headerValue(value[0]) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** The secret's key material. `whsec_` is a human-facing prefix, not part of the key. */
function secretKey(secret: string): Buffer {
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(body, "base64");
}

/**
 * Sign a payload exactly as the provider does. Exported for the tests, and used by nothing else.
 *
 * A verifier can only be tested by feeding it signatures, and a signer written inside the test file would
 * be a second implementation of the same guess — if both were wrong in the same way the suite would still
 * be green. This one is the module's own, so the cross-check against `resend`'s verifier tests THIS code.
 */
export function signWeeklyReportWebhook(input: {
  secret: string;
  messageId: string;
  timestampSeconds: number;
  payload: string;
}): string {
  const signed = `${input.messageId}.${input.timestampSeconds}.${input.payload}`;
  return crypto.createHmac("sha256", secretKey(input.secret)).update(signed, "utf8").digest("base64");
}

/** Constant-time over equal-length inputs; a length mismatch is answered without comparing at all. */
function signatureMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify a delivery webhook.
 *
 * Returns a REASON rather than throwing, and the reason is for the LOG, never for the response. Telling a
 * caller which of "your signature is wrong", "your timestamp is stale" and "we have no secret configured"
 * happened is a free oracle for anybody probing the endpoint.
 *
 * An UNCONFIGURED SECRET FAILS CLOSED. The alternative — accepting everything when `RESEND_WEBHOOK_SECRET`
 * is unset — turns a missed environment variable into an open write endpoint against client-facing report
 * state, and it would do so silently, on exactly the deploy where nobody is looking.
 */
export function verifyWeeklyReportWebhookSignature(input: {
  rawBody: Buffer | string;
  headers: WeeklyReportWebhookHeaders;
  secret: string | undefined | null;
  /** Injected only by the tests, which need both sides of the tolerance without waiting five minutes. */
  now?: Date;
}): WeeklyReportWebhookSignatureResult {
  const secret = input.secret?.trim();
  if (!secret) return { ok: false, reason: "no_secret" };

  const messageId = headerValue(input.headers.id);
  const timestampHeader = headerValue(input.headers.timestamp);
  const signatureHeader = headerValue(input.headers.signature);
  if (!messageId || !timestampHeader || !signatureHeader) {
    return { ok: false, reason: "missing_headers" };
  }

  // Deliberately strict. `Number.parseInt` would read "123abc" as 123, and a timestamp that is partly
  // garbage is not a timestamp — it is a probe.
  if (!/^-?\d+$/.test(timestampHeader)) return { ok: false, reason: "bad_timestamp" };
  const timestampSeconds = Number(timestampHeader);
  if (!Number.isSafeInteger(timestampSeconds)) return { ok: false, reason: "bad_timestamp" };

  const nowSeconds = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > WEEKLY_REPORT_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const payload = typeof input.rawBody === "string" ? input.rawBody : input.rawBody.toString("utf8");
  const expected = signWeeklyReportWebhook({ secret, messageId, timestampSeconds, payload });

  // The header may carry SEVERAL signatures — that is how the provider rotates a secret without dropping
  // events, so taking only the first would break every send during a rotation. Non-v1 entries are skipped
  // rather than rejected: a future version arriving alongside a v1 must not invalidate the v1.
  for (const entry of signatureHeader.split(" ")) {
    const separator = entry.indexOf(",");
    if (separator < 0) continue;
    if (entry.slice(0, separator) !== "v1") continue;
    if (signatureMatches(entry.slice(separator + 1), expected)) return { ok: true };
  }
  return { ok: false, reason: "no_matching_signature" };
}
