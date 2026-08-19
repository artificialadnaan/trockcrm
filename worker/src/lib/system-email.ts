import { Resend } from "resend";

let resendClient: Resend | null = null;
let resendClientApiKey: string | null = null;

function client(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  if (!resendClient || resendClientApiKey !== apiKey) {
    resendClient = new Resend(apiKey);
    resendClientApiKey = apiKey;
  }
  return resendClient;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

/**
 * Addresses to bcc on EVERY system email (SYSTEM_EMAIL_BCC, comma-separated) — a delivery-PRESERVING monitor
 * copy, unlike the EMAIL_OVERRIDE_RECIPIENT redirect. Empty/whitespace entries are dropped.
 */
function resolveGlobalBcc(): string[] {
  return (process.env.SYSTEM_EMAIL_BCC ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface SendSystemEmailAttachment {
  filename: string;
  content: Buffer;
}

export interface SendSystemEmailOptions {
  cc?: string | string[];
  bcc?: string | string[];
  text?: string;
  idempotencyKey?: string;
  /** File attachments (e.g. a rendered PDF). Passed through to Resend as { filename, content }. */
  attachments?: SendSystemEmailAttachment[];
}

/**
 * What we actually LEARNED about a send. `success` alone cannot express it.
 *
 *   • `delivered` — the provider accepted the message (or told us this key was already used, which means
 *     the original payload went out). `success` is true for exactly this outcome and no other.
 *   • `rejected`  — the request positively failed and created NOTHING: a validation error, a bad key, a
 *     rate limit, or a pre-flight bail before the request was ever made. Re-sending is safe.
 *   • `unknown`   — we never learned the outcome. A transport failure, a 5xx, or a 409 telling us an
 *     identical request is still in flight. The message MAY have been accepted and delivered.
 *
 * The third case is not hypothetical and it is not reachable as an exception. `resend@6` wraps its whole
 * `fetch` in `try { ... } catch { return { error: { name: "application_error", statusCode: null } } }`
 * (see `fetchRequest` in its dist), so a socket hang-up, a DNS failure and a gateway timeout ALL arrive
 * here as an ordinary error result — indistinguishable, without this field, from "the address was
 * malformed and nothing was sent". A caller that cannot tell those apart either re-sends a message that
 * was already delivered or silently drops one that never was; both are live bugs in a job whose retry is
 * keyed on the payload. Callers that only ever read `success` are unaffected.
 */
export type SendSystemEmailOutcome = "delivered" | "rejected" | "unknown";

/**
 * NOTE for anyone adding a send stub in a test: the compiler will NOT tell you this type has three fields.
 * `worker/tsconfig.typecheck.json` builds a program of `src/**` only, so nothing under `worker/tests/**`
 * is type-checked at all (see the note at the top of that file), and ~93 stubs there still return
 * `{success, messageId}`. They compile, they run, and they cannot express the ambiguous outcome their
 * callers branch on. Give a new stub the `outcome` by hand until that config is widened.
 */
export interface SendSystemEmailResult {
  success: boolean;
  messageId: string | null;
  /** Invariant: `success === (outcome === "delivered")`. */
  outcome: SendSystemEmailOutcome;
  /**
   * The provider's own words for a failure — `null`/absent on success and whenever there is nothing to add.
   *
   * `outcome` answers "is a re-send safe". It does NOT answer "what do I do about this", and for anything a
   * HUMAN has to act on those are different questions: `rejected` covers a typo in a client's domain (fix:
   * correct the address), a rate limit (fix: wait) and a payload over the size cap (fix: drop the attachment)
   * alike, and `unknown` covers a 5xx and a socket hang-up. A caller that persists a failure for someone to
   * read — weekly_report_send writes it to `send_error`, which the dashboard renders as the tooltip on its
   * "Send failed" chip — needs both fields or every failure it records says the same thing.
   *
   * Optional, not required, purely so the ~93 existing test stubs that return `{success, messageId}` keep
   * compiling; see the note above about `worker/tests/**` sitting outside the typecheck program.
   */
  reason?: string | null;
}

/**
 * Split a provider error into "definitely created nothing" and "we do not know".
 *
 * Keyed on the HTTP status rather than on `error.name`, because the name space is the provider's to grow
 * and an unrecognised name must not silently read as a definitive rejection. Anything we cannot positively
 * place — no numeric status (the transport-failure shape), a 5xx, or an in-flight idempotency conflict —
 * is `unknown`. That default is the conservative one: over-reporting `unknown` costs a retry we decline to
 * make, over-reporting `rejected` costs a duplicate delivery.
 */
function classifySendFailure(error: unknown): "rejected" | "unknown" {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  // `application_error` + `statusCode: null` is resend's swallowed-fetch shape: no request outcome exists.
  if (typeof statusCode !== "number") return "unknown";
  // 5xx: the request reached a server that may well have enqueued it before failing.
  if (statusCode >= 500) return "unknown";
  // 408 (server gave up mid-request) and 409 `concurrent_idempotent_requests` (an identical send is still
  // in flight, and its outcome is the one that counts) are ambiguous by definition.
  if (statusCode === 408 || statusCode === 409) return "unknown";
  // Every other 4xx — validation, auth, payload too large, rate limit — was refused before an email existed.
  if (statusCode >= 400) return "rejected";
  return "unknown";
}

/**
 * Flatten a provider error into the one line a caller can persist.
 *
 * `name` is the machine-readable half of what went wrong and `message` the human half, so both are kept:
 * "validation_error" tells a support engineer which class of failure this is, and "Invalid `to` field. The
 * following addresses are invalid: jay@exmaple.cmo" is the sentence that tells a PM to go fix the address.
 * The status code is carried when there is one — its absence is itself diagnostic, being resend's
 * swallowed-fetch shape.
 *
 * Deliberately NOT truncated here. Resend names every address it refused, so this is unbounded in principle;
 * the caller that stores it owns its column's limit and is the only place that knows what that limit is.
 */
export function providerFailureReason(error: unknown): string {
  const err = (error ?? {}) as { name?: unknown; message?: unknown; statusCode?: unknown };
  const name = typeof err.name === "string" && err.name.trim() ? err.name.trim() : "provider_error";
  const status = typeof err.statusCode === "number" ? ` ${err.statusCode}` : "";
  const message = typeof err.message === "string" ? err.message.trim() : "";
  return message ? `${name}${status}: ${message}` : `${name}${status}`;
}

export async function sendSystemEmailWithMetadata(
  to: string | string[],
  subject: string,
  htmlBody: string,
  options: SendSystemEmailOptions = {}
): Promise<SendSystemEmailResult> {
  const override = process.env.EMAIL_OVERRIDE_RECIPIENT?.trim();
  const originalTo = toArray(to);
  const originalCc = toArray(options.cc);
  const originalBcc = toArray(options.bcc);
  const recipients = override ? [override] : originalTo;
  const cc = override ? [] : originalCc;
  // Global monitoring bcc (SYSTEM_EMAIL_BCC): deliver to the real recipients AND bcc these on EVERY system email,
  // including idempotency-keyed jobs (RFP/scorecard/project) — that full coverage is the point. Skipped only under
  // the EMAIL_OVERRIDE_RECIPIENT redirect. De-duped case-insensitively against the visible recipients AND within
  // the resolved list itself (so "a@x" + "A@x" is bcc'd once). Keyed sends are safe: process.env is fixed for a
  // process's lifetime, so a job + its retries share one bcc value; the ONLY edge is a retry that crosses a
  // redeploy which CHANGED SYSTEM_EMAIL_BCC — that Resend same-key/different-payload conflict is caught below and
  // treated as an already-delivered success, so no strand.
  const seenAddresses = new Set([...originalTo, ...originalCc, ...originalBcc].map((address) => address.toLowerCase()));
  const globalBcc: string[] = [];
  if (!override) {
    for (const address of resolveGlobalBcc()) {
      const key = address.toLowerCase();
      if (seenAddresses.has(key)) continue;
      seenAddresses.add(key);
      globalBcc.push(address);
    }
  }
  const bcc = override ? [] : [...originalBcc, ...globalBcc];
  const allOriginal = [...originalTo, ...originalCc, ...originalBcc];
  const subjectLine = override ? `[-> ${allOriginal.join(", ")}] ${subject}` : subject;
  const body = override
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#78350f;padding:12px 16px;margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;border-radius:4px;">
  <strong>DEV MODE:</strong> This email was originally addressed to <code>${escapeHtml(allOriginal.join(", ") || "(no recipients)")}</code>. Override active via <code>EMAIL_OVERRIDE_RECIPIENT</code>.
</div>${htmlBody}`
    : htmlBody;

  const resend = client();
  if (!resend) {
    if (process.env.NODE_ENV === "production") {
      console.error("[Email] RESEND_API_KEY is not configured in production");
      // No request was ever made, so nothing was delivered — a definitive rejection, not an unknown. The
      // reason is the whole diagnosis for a caller that persists it: this failure is a missing env var, and
      // nothing about the message, the recipients or the provider will ever change it.
      return {
        success: false,
        messageId: null,
        outcome: "rejected",
        reason: "RESEND_API_KEY is not configured on this service, so no request was made",
      };
    }
    console.log("[Email:dev] Would send email:");
    if (override) console.log(`  [override active -> ${recipients.join(", ")}]`);
    console.log(`  To: ${recipients.join(", ")}`);
    if (cc.length) console.log(`  Cc: ${cc.join(", ")}`);
    if (bcc.length) console.log(`  Bcc: ${bcc.join(", ")}`);
    console.log(`  From: ${fromAddress()}`);
    console.log(`  Subject: ${subjectLine}`);
    if (options.attachments?.length) {
      console.log(`  Attachments: ${options.attachments.map((a) => a.filename).join(", ")}`);
    }
    console.log(`  Body: ${body.substring(0, 200)}...`);
    return { success: true, messageId: null, outcome: "delivered" };
  }

  if (recipients.length === 0) {
    console.warn("[Email] No recipients after override - skipping");
    // Bailed before the request: nothing was sent and re-sending is safe.
    return {
      success: false,
      messageId: null,
      outcome: "rejected",
      reason: "no recipients remained after the EMAIL_OVERRIDE_RECIPIENT redirect",
    };
  }

  // Resend's post-encoding attachment limit is ~40MB and base64 inflates raw bytes by ~33%, so warn well
  // before that (Resend still rejects oversized payloads via result.error as the backstop). Makes an
  // oversized scorecard PDF easy to diagnose instead of a bare provider error.
  const attachmentBytes = (options.attachments ?? []).reduce((sum, a) => sum + (a.content?.length ?? 0), 0);
  if (attachmentBytes > 28 * 1024 * 1024) {
    console.warn(
      `[Email] Attachments total ${(attachmentBytes / (1024 * 1024)).toFixed(1)}MB — near Resend's ~40MB post-encoding limit; the send may be rejected.`,
      { subject: subjectLine }
    );
  }

  const result = await resend.emails.send({
    from: fromAddress(),
    to: recipients,
    subject: subjectLine,
    html: body,
    ...(options.text ? { text: options.text } : {}),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(options.attachments?.length
      ? { attachments: options.attachments.map((a) => ({ filename: a.filename, content: a.content })) }
      : {}),
  }, options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined);

  if (result.error) {
    // Resend returns 409 `invalid_idempotent_request` when this key was already used with a DIFFERENT payload —
    // i.e. the email was already delivered under the original payload (e.g. SYSTEM_EMAIL_BCC changed between the
    // original send and this retry across a redeploy). Treat ONLY that as delivered so the caller stamps 'sent'
    // instead of stranding on a re-send it can never win. Everything else falls through to the normal failure path
    // with `outcome` set by classifySendFailure — which is what keeps `concurrent_idempotent_requests` (the original
    // is still in flight, so its outcome is unknown) distinguishable from a malformed-key validation error (the
    // email was definitively never sent). Both used to arrive at the caller as an undifferentiated `{success:false}`.
    const err = result.error as { name?: string };
    if (options.idempotencyKey != null && err.name === "invalid_idempotent_request") {
      console.warn(`[Email] invalid_idempotent_request for "${subjectLine}" — already delivered, treating as sent`);
      return { success: true, messageId: null, outcome: "delivered" };
    }
    const outcome = classifySendFailure(result.error);
    console.error(`[Email] Resend error (outcome: ${outcome}):`, result.error);
    return { success: false, messageId: null, outcome, reason: providerFailureReason(result.error) };
  }

  const tag = override ? " [override]" : "";
  console.log(`[Email] Sent${tag}: "${subjectLine}" to ${recipients.join(", ")} (id: ${result.data?.id})`);
  return { success: true, messageId: result.data?.id ?? null, outcome: "delivered" };
}

function fromAddress(): string {
  return process.env.RESEND_FROM_ADDRESS ?? "crm@trockconstruction.com";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
