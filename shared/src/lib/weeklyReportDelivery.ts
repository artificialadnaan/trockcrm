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
 * THE PRECEDENCE. Which of two verdicts about the same message is the one worth keeping.
 *
 * It decides ahead of the clock, and that ordering of the two rules is the whole point — see
 * `weeklyReportDeliverySupersedes`. Read upwards it is "how much does this verdict oblige somebody to do
 * something": `delayed` is the provider still trying, `delivered` is a recipient who has it, `complained`
 * is a recipient who has it and does not want the next one, and `failed`/`bounced` are a recipient who
 * does not have it at all.
 *
 * ONE COLUMN, MANY RECIPIENTS — which is what makes a precedence the right shape rather than a tie-break.
 * A weekly report goes to up to four client contacts plus SYSTEM_EMAIL_BCC, the provider emits one event
 * per RECIPIENT, and every one of them carries the same delivery-key tag with nothing in the payload
 * saying which address it is about. The row therefore cannot mean "what happened to the message"; the
 * only honest reading of a single column over a set of per-recipient outcomes is THE WORST ONE ANY
 * RECIPIENT HAD, and that is exactly a running maximum over this rank.
 *
 * The costs are not symmetric either, which settles which direction to round in when the events disagree.
 * Recording `bounced` on a message a second recipient did receive puts an extra chip in front of a PM;
 * recording `delivered` on one whose only real recipient bounced is the exact silence this whole feature
 * exists to break.
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
 * than dated with the arrival time. It is the ordering key BETWEEN TWO EVENTS THAT SAY THE SAME THING
 * (see `weeklyReportDeliverySupersedes`), and arrival order is exactly what must not decide that: the
 * soft bounce off one contact and the hard bounce off another arrive in whatever order the provider's
 * queue hands them over, and stamping both with "now" would let the transient one land last and tell a PM
 * to try again against an address that is permanently dead. It is also read verbatim by whoever answers
 * the support question, and a fabricated instant is a fabricated fact. A dropped event leaves the
 * previous verdict standing, which is wrong in the direction that stays visible.
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
 * The one rule the whole feature turns on. VERDICT FIRST, CLOCK SECOND: a more conclusive verdict wins
 * whatever it is dated, and the provider's timestamp only separates two events that say the SAME thing.
 *
 * WHY NOT PURE RECENCY, which is what this was. Recency is only sound if a message has one recipient, and
 * a weekly report has up to five (four client contacts plus SYSTEM_EMAIL_BCC). The provider emits one
 * event per recipient outcome, all tagged with the same delivery key, and `data.to` does not say which
 * address an event is about — the delivery-service header states that limit outright. So the ordinary
 * shape of a broken send is `bounced` for the client's real address at T+1s and `delivered` for the
 * internal bcc copy at T+2min, and under recency the second one erased the first: the chip came off the
 * board, the week dropped out of "Send failures", and the report was filed away as settled while the
 * client had nothing. `complained` was the same erasure at its worst, because a spam complaint is a human
 * pressing a button and is therefore ALWAYS later than any bounce.
 *
 * The scenario recency was justified by does not survive either. It was "a provider retry that finally
 * gets through", but a bounce is emitted when the sending side has STOPPED trying — SES retries a
 * transient failure internally and reports the bounce only once it gives up — so there is no later
 * success on that recipient to wait for.
 *
 * A RATCHET NEEDS A RELEASE, and it has one that is not this function's business: a new send or a
 * correction mints a NEW delivery key and NULLs all three verdict columns in the same statement (see
 * `transitionWeeklyReport`). So a recorded failure is released by sending something, which is the only
 * thing that could make it untrue, and no report can be wedged reading "bounced" forever.
 *
 * TWO PROPERTIES WORTH NAMING, both of which pure recency lacked:
 *
 *   • The stored verdict is a function of the SET of events received, not of the order they arrived in or
 *     of how many times each was delivered. That is the only shape that makes sense for an at-least-once,
 *     out-of-order feed, and it is why no ordering assumption has to hold for the row to be right.
 *   • Replays stay no-ops by construction — same verdict, same instant, and `>` is strict — so nothing
 *     else is needed for idempotency and no event ledger has to grow unbounded to re-derive a fact these
 *     three columns already hold.
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

  const currentRank = DELIVERY_RANK[currentStatus];
  const incomingRank = DELIVERY_RANK[incoming.status];
  // A different verdict is settled by the precedence alone. Reaching for the clock here is what let one
  // recipient's later `delivered` overwrite another's `bounced`.
  if (incomingRank !== currentRank) return incomingRank > currentRank;
  // The SAME verdict again: now the clock is the right question, and answering it keeps
  // `send_delivery_status_at` and the stored detail on the most recent event of that kind — a second
  // recipient's bounce, or the hard bounce that follows a soft one — instead of the first one seen.
  return incomingAt > currentAt;
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
