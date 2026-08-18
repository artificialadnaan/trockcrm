// What the MAIL PROVIDER later told us about a weekly report we had already handed it.
//
// `send_delivered_at` answers a different question and keeps answering it: the provider ACCEPTED the
// message. That is the last thing the send path can observe synchronously, and it is not delivery — a
// report addressed to `jay@examle.com` is accepted, hard-bounces minutes later, and every surface that
// reads acceptance alone shows it as fine forever. The vocabulary below is the second, slower fact, and
// it arrives out of band on a webhook.
//
// SHARED rather than server-local for the usual reason: the parse runs on the server, the wording runs in
// the CRM, and a status the two spell differently is a status that means two things.

/**
 * The verdicts this platform records. Deliberately smaller than the provider's event list — this is the
 * set that changes what somebody would DO, and anything outside it is dropped rather than stored as noise
 * a later reader has to interpret.
 *
 *   • `delayed`    — the provider is still trying. Not a problem yet, and explicitly not a failure.
 *   • `delivered`  — the receiving mail server accepted it. The strongest evidence that exists.
 *   • `complained` — it arrived and the recipient marked it as spam. They HAVE their report; the next one
 *                    may not reach them.
 *   • `failed`     — the provider never put it in front of the recipient at all (a send failure on their
 *                    side, or an address already on their suppression list).
 *   • `bounced`    — the receiving server rejected it. `hard` means it will never be accepted at that
 *                    address; `soft` means it might.
 */
export const WEEKLY_REPORT_DELIVERY_STATUSES = [
  "delayed",
  "delivered",
  "complained",
  "failed",
  "bounced",
] as const;

export type WeeklyReportDeliveryStatus = (typeof WEEKLY_REPORT_DELIVERY_STATUSES)[number];

/**
 * ONLY a tie-break, and it is worth being precise about that.
 *
 * Ordering is by the PROVIDER'S event timestamp; this rank decides nothing unless two events carry the
 * SAME timestamp to the millisecond, which is a shape the provider does not promise never to emit. When it
 * happens, the more conclusive statement that the client did not get their report wins — because the cost
 * of the two mistakes is not symmetric. Recording `bounced` on a report that was in fact delivered puts an
 * unnecessary chip in front of a PM; recording `delivered` on one that bounced is the exact silence this
 * whole feature exists to break.
 *
 * It is NOT a general precedence: a genuinely later `delivered` (a retry that got through) does supersede
 * an earlier `bounced`, and must, or a successful re-send could never clear the record.
 */
const DELIVERY_RANK: Record<WeeklyReportDeliveryStatus, number> = {
  delayed: 1,
  delivered: 2,
  complained: 3,
  failed: 4,
  bounced: 5,
};

/** Verdicts that mean the client demonstrably does NOT have this version of their report. */
export const WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES: readonly WeeklyReportDeliveryStatus[] = [
  "bounced",
  "failed",
];

export function isWeeklyReportDeliveryStatus(value: unknown): value is WeeklyReportDeliveryStatus {
  return (
    typeof value === "string" &&
    (WEEKLY_REPORT_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Did this verdict mean the client did not receive the report?
 *
 * `complained` is deliberately NOT a failure: a spam complaint can only follow a delivery, so the client
 * has the report. It is a reason to worry about the NEXT one, which is a different conversation.
 */
export function weeklyReportDeliveryFailed(status: unknown): boolean {
  return (
    isWeeklyReportDeliveryStatus(status) &&
    WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES.includes(status)
  );
}

/** Hard vs soft, from the provider's bounce classification. */
export type WeeklyReportBounceClass = "hard" | "soft" | "unknown";

/**
 * SES's vocabulary, which is what Resend passes through in `data.bounce.type`.
 *
 * `Undetermined` maps to `unknown` rather than to `soft`. Guessing "it might work next time" about a
 * bounce the provider itself would not classify is the kind of optimism that costs a client their report:
 * a PM told the address is merely busy waits, where "we do not know" sends them to check it.
 */
export function weeklyReportBounceClass(bounceType: unknown): WeeklyReportBounceClass {
  if (typeof bounceType !== "string") return "unknown";
  const normalized = bounceType.trim().toLowerCase();
  if (normalized === "permanent") return "hard";
  if (normalized === "transient") return "soft";
  return "unknown";
}

/**
 * The provider event types this platform acts on, and the verdict each produces.
 *
 * `email.sent` is absent ON PURPOSE. It says the provider accepted the API call, which is precisely what
 * `send_delivered_at` already records at the moment the worker made it — storing it again would add a row
 * of ceremony and, worse, would let a late `email.sent` outrank an earlier real verdict on timestamp.
 * `email.opened` and `email.clicked` are absent because tracking whether a client read their report is a
 * product decision nobody has made, and this endpoint is not the place to make it quietly.
 */
const EVENT_STATUS: Record<string, WeeklyReportDeliveryStatus> = {
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.complained": "complained",
  "email.bounced": "bounced",
  "email.failed": "failed",
  "email.suppressed": "failed",
};

/**
 * The tag the delivery key rides out on, and back in.
 *
 * WHY A TAG AND NOT THE PROVIDER'S MESSAGE ID. The message id only exists once the provider has answered,
 * so correlating on it means writing it down after the send — and "provider accepted, process died before
 * the stamp" is an ordinary outcome for this worker (it is the whole reason `send_delivery_key` is an
 * idempotency key in the first place). A bounce for a send whose id we never got to record would be
 * unattributable, which is the one case where a bounce matters most. A tag travels WITH the message: it is
 * set from the row before the request, the provider echoes it on every event about that message, and no
 * write of ours has to survive for the correlation to work.
 *
 * Resend restricts tag names and values to ASCII letters, digits, `_` and `-`, which a uuid satisfies.
 */
export const WEEKLY_REPORT_DELIVERY_TAG = "weekly_report_delivery_key";

/** A provider event, reduced to the four things a decision needs. */
export interface WeeklyReportDeliveryEvent {
  /** `send_delivery_key`, read back off the message's own tag. */
  deliveryKey: string;
  status: WeeklyReportDeliveryStatus;
  /** THE PROVIDER'S event timestamp, ISO. The ordering key — never the time we received it. */
  occurredAt: string;
  /** Kept verbatim so a support question can be answered without re-deriving anything. */
  detail: {
    eventType: string;
    emailId: string | null;
    bounceClass: WeeklyReportBounceClass | null;
    bounceType: string | null;
    bounceSubType: string | null;
    message: string | null;
  };
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 8-4-4-4-12 hex. The delivery key is a uuid and is about to be bound as one; anything else is not ours. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn a verified provider payload into an event, or into `null`.
 *
 * `null` covers everything this endpoint is not interested in — a contact event, an open, a message with
 * no weekly-report tag — and it is not an error. The provider webhook is configured per ACCOUNT, so every
 * email this company sends arrives here, and the ordinary case is a payload that has nothing to do with a
 * weekly report.
 *
 * THE TIMESTAMP HAS NO FALLBACK. An event whose `created_at` is missing or unparseable is dropped rather
 * than dated with the arrival time, because arrival order is exactly the thing that must not decide this:
 * a `delivered` retried out of a provider-side queue can reach us after the `bounced` that followed it,
 * and stamping both with "now" would resolve them backwards. A dropped event leaves the previous verdict
 * standing, which is wrong in the direction that stays visible.
 */
export function parseWeeklyReportDeliveryEvent(payload: unknown): WeeklyReportDeliveryEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { type?: unknown; created_at?: unknown; data?: unknown };

  const eventType = text(envelope.type);
  if (!eventType) return null;
  const status = EVENT_STATUS[eventType];
  if (!status) return null;

  const data = (envelope.data ?? null) as
    | { email_id?: unknown; tags?: unknown; bounce?: unknown; failed?: unknown; suppressed?: unknown }
    | null;
  if (!data || typeof data !== "object") return null;

  const tags = (data.tags ?? null) as Record<string, unknown> | null;
  const deliveryKey = tags && typeof tags === "object" ? text(tags[WEEKLY_REPORT_DELIVERY_TAG]) : null;
  if (!deliveryKey || !UUID_PATTERN.test(deliveryKey)) return null;

  const occurredAtRaw = text(envelope.created_at);
  if (!occurredAtRaw) return null;
  const occurredAtMs = Date.parse(occurredAtRaw);
  if (!Number.isFinite(occurredAtMs)) return null;

  const bounce = (data.bounce ?? null) as { type?: unknown; subType?: unknown; message?: unknown } | null;
  const failed = (data.failed ?? null) as { reason?: unknown } | null;
  const suppressed = (data.suppressed ?? null) as { message?: unknown; type?: unknown } | null;

  return {
    deliveryKey: deliveryKey.toLowerCase(),
    status,
    occurredAt: new Date(occurredAtMs).toISOString(),
    detail: {
      eventType,
      emailId: text(data.email_id),
      bounceClass: bounce ? weeklyReportBounceClass(bounce.type) : null,
      bounceType: bounce ? text(bounce.type) : null,
      bounceSubType: bounce ? text(bounce.subType) : null,
      message:
        text(bounce?.message) ?? text(failed?.reason) ?? text(suppressed?.message) ?? null,
    },
  };
}

/**
 * Does an incoming verdict replace the one already on the row?
 *
 * The one rule the whole feature turns on. Webhooks arrive more than once and out of order — a provider
 * retrying a `delivered` it could not hand over can land it after the `bounced` that superseded it — so
 * "the last one we saw" is not the answer. The PROVIDER'S clock is.
 *
 * Strictly greater, which is what makes a replay a no-op: the same event delivered five times computes the
 * same timestamp and the same rank, so only the first one writes. Nothing else is needed for idempotency
 * and nothing else is kept — an event ledger with a row per delivery attempt would grow without bound to
 * re-derive a fact these three columns already hold.
 */
export function weeklyReportDeliverySupersedes(
  current: { status: unknown; occurredAt: unknown } | null,
  incoming: { status: WeeklyReportDeliveryStatus; occurredAt: string },
): boolean {
  if (!current) return true;
  const currentStatus = isWeeklyReportDeliveryStatus(current.status) ? current.status : null;
  const currentAt =
    current.occurredAt instanceof Date
      ? current.occurredAt.getTime()
      : typeof current.occurredAt === "string"
        ? Date.parse(current.occurredAt)
        : NaN;
  // A row with no readable verdict yet — never written, or written before this feature existed — takes
  // whatever arrives. Both fields are checked because a half-written pair is not a state to defer to.
  if (currentStatus == null || !Number.isFinite(currentAt)) return true;

  const incomingAt = Date.parse(incoming.occurredAt);
  if (!Number.isFinite(incomingAt)) return false;

  if (incomingAt > currentAt) return true;
  if (incomingAt < currentAt) return false;
  return DELIVERY_RANK[incoming.status] > DELIVERY_RANK[currentStatus];
}

/**
 * What a person reads. Kept beside the vocabulary so the CRM cannot drift from what the column means.
 *
 * The bounce wording names the CLASS rather than the provider's word, because "Permanent" in front of a PM
 * is a status they have to translate and "will never be delivered" is one they can act on.
 */
export function weeklyReportDeliveryLabel(
  status: WeeklyReportDeliveryStatus,
  bounceClass?: WeeklyReportBounceClass | null,
): string {
  switch (status) {
    case "delivered":
      return "Delivered";
    case "delayed":
      return "Delivery delayed";
    case "complained":
      return "Marked as spam";
    case "failed":
      return "Never sent";
    case "bounced":
      if (bounceClass === "hard") return "Bounced — bad address";
      if (bounceClass === "soft") return "Bounced — try again";
      return "Bounced";
  }
}
