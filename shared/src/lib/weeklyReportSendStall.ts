/**
 * THE ONE CLOCK A WEEKLY REPORT'S DELIVERY IS AGED AGAINST.
 *
 * Two surfaces answer "has this send stopped moving": the CRM board, which draws a chip a PM reads, and
 * the worker's dead-letter sweep, which emails leadership about it. They must not be able to disagree —
 * an email announcing a stalled send that the board is still calling "Sending…" is worse than no email at
 * all, because the first thing its recipient does is click through to the board and find nothing there.
 * So the threshold and the arithmetic live here, imported by both, rather than being written twice.
 *
 * WHAT THE THRESHOLD IS FOR. The failure this whole mechanism exists for has no error message. The
 * delivery job's outcome — `send_attempts`, `send_error`, `send_delivered_at` — is recorded in THE SAME
 * DATABASE whose unavailability is the likeliest reason the delivery failed in the first place, and the
 * queue gives up after three attempts with 3s/9s/27s backoff. A fault lasting a couple of minutes
 * therefore dead-letters the job having written nothing at all, leaving a row that reads `status = 'sent'`,
 * `sent_at` set, `send_error` NULL, `send_delivered_at` NULL, `send_attempts` 0 — indistinguishable, to any
 * predicate keyed on the error text, from a send queued five seconds ago. Time is the only evidence left,
 * so time is what this uses.
 */

/**
 * How long a `sent` report may sit undelivered before it has stopped being "in flight".
 *
 * Generous enough that an ordinary queue backlog does not cry wolf, short enough that a lost report is
 * caught the same working day.
 */
export const WEEKLY_REPORT_SEND_STALL_MINUTES = 30;

/** The two timestamps that say when a delivery was last worked on. Loosely typed: these come off a row. */
export interface WeeklyReportSendActivityRow {
  sent_at?: unknown;
  send_last_attempt_at?: unknown;
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * WHEN THIS DELIVERY WAS LAST HANDED TO THE QUEUE — the moment the stall clock runs from.
 *
 * The LATER of the two stamps, and both are needed:
 *
 *   `sent_at`              the PM's commit. The only timestamp that exists in the case this whole
 *                          mechanism is for, where the job dead-lettered having written nothing at all.
 *   `send_last_attempt_at` written by the worker after every attempt, and — since it is also the only
 *                          record a retry leaves — by `retryWeeklyReportSend` when it re-queues.
 *
 * AGEING OFF `sent_at` ALONE IS THE BUG MIGRATION 0226 WAS WRITTEN TO FIX. `sent_at` is stamped once at
 * commit and never moves, so a send committed ninety minutes ago and retried five seconds ago was still
 * ninety minutes old by that measure: the chip flipped straight from "Send failed" to "Send stuck", the PM
 * got no acknowledgement that their click had done anything, and past the provider's dedupe window a PM
 * who clicked Retry, cleared the duplicate-risk confirmation and saw nothing change would reasonably click
 * it again — a second acknowledged replay, which is a second real copy in the client's inbox.
 *
 * Nor is `send_last_attempt_at` alone enough, which is why this is a MAX and not that column on its own:
 * it is null for precisely the dead-lettered-having-written-nothing row above, and a null clock ages
 * nothing.
 *
 * A row with NEITHER stamp cannot be aged and is left alone rather than guessed at: `sent` guarantees
 * `sent_at`, so that is a corrupt row, and inventing a failure for it would be a chip nobody can act on.
 */
export function weeklyReportLastSendActivityAt(row: WeeklyReportSendActivityRow): Date | null {
  const sentAt = toDate(row.sent_at);
  const lastAttemptAt = toDate(row.send_last_attempt_at);
  if (sentAt == null) return lastAttemptAt;
  if (lastAttemptAt == null) return sentAt;
  return lastAttemptAt.getTime() > sentAt.getTime() ? lastAttemptAt : sentAt;
}

/**
 * Has this send been undelivered for longer than a delivery plausibly takes?
 *
 * PURELY THE AGE TEST — it says nothing about whether the row is undelivered, superseded or even a send at
 * all; its callers own those predicates, because they do not agree about them. The board splits an aged
 * undelivered send by whether the last attempt left an error (`send_error` set is "Send failed", null is
 * the silent "Send stuck"), while the sweep alerts on both: an error recorded an hour ago and never
 * followed up is exactly as undelivered as silence, and `send_attempts` alone cannot tell it from a
 * failure the queue is retrying right now.
 */
export function weeklyReportSendHasStalled(row: WeeklyReportSendActivityRow, now: Date): boolean {
  const since = weeklyReportLastSendActivityAt(row);
  if (since == null) return false;
  return now.getTime() - since.getTime() > WEEKLY_REPORT_SEND_STALL_MINUTES * 60_000;
}
