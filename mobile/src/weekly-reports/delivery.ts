// What happened to the client's email AFTER the PM pressed Send — and the two ways back.
//
// This is the last piece of the weekly-report feature, and it exists because the send had no follow-up on
// this surface at all. A PM sends, the mail provider refuses the client's address, the worker stamps
// `send_error`, and T-Rock Cam showed that PM nothing, ever: a `sent` week leaves the review queue, and the
// project card reads "Sent". The only surfaces that ever said otherwise were the CRM board and the sweep's
// alert email, and the ordinary `construction` PM — the person who pressed the button — can reach neither.
//
// WHY THE VERDICT IS DERIVED HERE AND NOT SHIPPED BY THE SERVER. "Sending…", "Send failed" and "Send stuck"
// are not three stored states; they are one stored state read against a clock. A label computed when the
// payload was built is true at that instant and drifts every second afterwards — and this app caches the
// hub feed and renders it offline, so a server-side label would have the phone confidently calling a
// half-hour-old stall "Sending…" until somebody pulled to refresh. The four columns are facts and travel as
// facts; the reading happens where and when it is rendered.
//
// WHAT THIS FILE MAY AND MAY NOT DECIDE. It may decide what to SHOW, and whether to ASK before acting. It
// may NOT decide whether an action is allowed: `canPublishWeeklyReport` is enforced in the service under
// FOR UPDATE, on both surfaces, and every refusal below is a courtesy that the server repeats. In
// particular `acknowledgeDuplicateRisk` is not a client-side rule — the server refuses the retry without it
// — so what the confirmation here buys is that a PM is TOLD what they are agreeing to, not that the rule
// exists.
//
// THE DECISIONS LIVE HERE RATHER THAN IN THE SCREEN for the reason the sibling modules state: `mobile/` has
// no OTA and this app's only executed suite is jest, so a branch that exists solely inside a React
// component ships to phones with nothing having run it.

import type { WeeklyReportDetailView, WeeklyReportUndeliveredSend } from "../api/types";

/**
 * Mirrors WEEKLY_REPORT_SEND_STALL_MINUTES in server/src/modules/weekly-reports/dashboard-service.ts.
 *
 * Restated because `mobile/` is a non-workspace Expo app that can resolve neither @trock-crm/shared nor the
 * server's source at runtime. __tests__/delivery.test.ts reads the real constant off disk and fails if
 * these drift, which is the same mechanism that pins WEEKLY_REPORT_SEND_LIMITS in send.ts.
 *
 * THE THRESHOLD EXISTS FOR A FAILURE WITH NO ERROR MESSAGE. The delivery job records its outcome in the
 * same database whose unavailability is the likeliest reason the delivery failed; the queue gives up after
 * three attempts with 3s/9s/27s backoff, so a fault lasting a couple of minutes dead-letters the job having
 * written nothing at all. That row reads `status = 'sent'`, `sent_at` set, `send_error` NULL,
 * `send_delivered_at` NULL, `send_attempts` 0 — identical, to anything keyed on the error text, to a send
 * queued five seconds ago. Time is the only evidence left.
 */
export const WEEKLY_REPORT_SEND_STALL_MINUTES = 30;

/**
 * Mirrors WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS in shared/src/lib/weeklyReportEmail.ts.
 *
 * Resend keeps an idempotency key for 24 hours. Inside that window replaying a send is a no-op at the
 * provider; outside it the key has been forgotten and the replay is an ordinary new email — a genuinely
 * second copy in a paying client's inbox. Since an undelivered week can sit on this list for as long as
 * nobody deals with it, "Retry is harmless" is true for the first day and false afterwards.
 */
export const WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS = 24;

/**
 * Is a replay of the SAME provider idempotency key still guaranteed not to send twice?
 *
 * Mirrors `weeklyReportRetryIsProviderDeduped` in shared, including its two conservative edges: a missing
 * or unparseable `sentAt` reads as OUTSIDE the window. Being wrong in that direction costs one extra
 * confirmation; being wrong the other way costs a duplicate client email.
 */
export function weeklyReportRetryIsProviderDeduped(
  sentAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (sentAt == null) return false;
  const stamped = new Date(sentAt);
  if (Number.isNaN(stamped.getTime())) return false;
  const elapsedHours = (now.getTime() - stamped.getTime()) / 3_600_000;
  return elapsedHours < WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS;
}

/**
 * The columns a delivery verdict is read from — satisfied by BOTH the hub's list row and the full report.
 *
 * `sendDeliveredAt` is optional because the hub's `undeliveredSends` row does not carry it: the server's
 * predicate for that list is `send_delivered_at IS NULL`, so it could only ever be null there. The detail
 * read does carry it, and that is the read that has to be able to say "delivered" — a week can be delivered
 * between the hub painting a row and the PM tapping it.
 */
export interface WeeklyReportDeliveryFacts {
  sentAt: string | null;
  sendDeliveredAt?: string | null;
  sendError: string | null;
  sendAttempts: number;
  sendLastAttemptAt: string | null;
}

/**
 * `delivered` — the mail provider accepted the message. Nothing more: there is no bounce webhook anywhere
 *               in this platform, so a report addressed to a mistyped domain is accepted, hard-bounces, and
 *               reads as delivered forever. Every sentence below is worded to claim only what is evidenced.
 * `failed`    — undelivered, and the last attempt reported an error there is something to show.
 * `stuck`     — undelivered, NO error recorded, and older than a delivery plausibly takes. The silent case,
 *               and the dangerous one: nothing wrote anything down, so only the clock knows.
 * `sending`   — undelivered, no error, recent. A queued job, not a problem.
 */
export type WeeklyReportDeliveryState = "delivered" | "failed" | "stuck" | "sending";

/**
 * When this delivery was last handed to the queue — the moment the stall clock runs from.
 *
 * The LATER of the two stamps, matching `lastSendActivityAt` in dashboard-service.ts, and both are needed.
 * `sentAt` is the PM's commit and the only timestamp that exists in the dead-lettered case above.
 * `sendLastAttemptAt` is written by the worker after every attempt and by the retry route when it
 * re-queues, which is the only record a retry leaves.
 *
 * Ageing off `sentAt` alone is what made every legitimate retry read as a failure on the CRM board: the
 * stamp never moves, so a send committed ninety minutes ago and retried five seconds ago was still ninety
 * minutes old, the chip flipped straight from "Send failed" to "Send stuck", and a PM who had just
 * acknowledged the duplicate risk saw nothing change and would reasonably tap again — a second real copy.
 */
function lastSendActivityAt(facts: WeeklyReportDeliveryFacts): Date | null {
  const stamps = [facts.sentAt, facts.sendLastAttemptAt]
    .map((value) => (value == null ? null : new Date(value)))
    .filter((value): value is Date => value != null && !Number.isNaN(value.getTime()));
  if (stamps.length === 0) return null;
  return stamps.reduce((latest, entry) => (entry.getTime() > latest.getTime() ? entry : latest));
}

export function weeklyReportDeliveryState(
  facts: WeeklyReportDeliveryFacts,
  now: Date = new Date(),
): WeeklyReportDeliveryState {
  if (facts.sendDeliveredAt) return "delivered";
  if (facts.sendError) return "failed";
  const since = lastSendActivityAt(facts);
  // A row with neither stamp cannot be aged, so it is left alone rather than guessed at. `sent` guarantees
  // `sent_at`; a row without one is corrupt, and inventing a failure for it would be a chip nobody can act
  // on — the same choice dashboard-service.ts makes.
  if (since == null) return "sending";
  const stalled = now.getTime() - since.getTime() > WEEKLY_REPORT_SEND_STALL_MINUTES * 60_000;
  return stalled ? "stuck" : "sending";
}

/** The chip, matching the CRM board's vocabulary word for word so one feature does not speak two ways. */
export function weeklyReportDeliveryLabel(state: WeeklyReportDeliveryState): string {
  switch (state) {
    case "delivered":
      return "Delivered";
    case "failed":
      return "Send failed";
    case "stuck":
      return "Send stuck";
    default:
      return "Sending…";
  }
}

/**
 * The sentence under the chip: what is known, in the words a PM on a jobsite can act on.
 *
 * The attempt count is carried into the `stuck` copy deliberately. A flat "nothing was ever recorded" is
 * false in the state a PM most often reads it in — a send that failed three times and was then retried has
 * an attempt history, and the retry is what erased the error text this state stands in for. Telling them
 * nothing was recorded contradicts the "· 3 attempts" they were looking at a moment earlier.
 */
export function weeklyReportDeliveryDetail(
  facts: WeeklyReportDeliveryFacts,
  state: WeeklyReportDeliveryState,
): string {
  const attempts = Number.isFinite(facts.sendAttempts) ? Math.max(0, Math.trunc(facts.sendAttempts)) : 0;
  const tries = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  switch (state) {
    case "delivered":
      // Says "accepted", not "received". The platform cannot evidence the second.
      return "The mail provider accepted this email. That is not proof anybody opened it, but it did leave here.";
    case "failed":
      return `The mail provider refused this email after ${tries}. ${facts.sendError ?? ""}`.trim();
    case "stuck":
      return attempts > 0
        ? `Sent, and delivery has been tried ${tries}, but the mail provider has never been recorded as accepting it and the last attempt reported no error.`
        : "This report was marked sent, but no delivery was ever attempted or recorded. The client has nothing.";
    default:
      return attempts > 0
        ? `Still going out — ${tries} so far. Give it a few minutes before retrying.`
        : "Still going out. Give it a few minutes before retrying.";
  }
}

/**
 * Does a Retry right now need the duplicate-risk acknowledgement?
 *
 * AGE ALONE, and the send's recorded outcome deliberately plays no part. An earlier revision took
 * `sendError` here on the reasoning that a recorded provider refusal means there is no first copy to
 * duplicate; it was reverted, because `send_error` describes only the LATEST attempt. It is overwritten
 * each time, a retry clears it while keeping `send_attempts`, and the case that matters most — the
 * provider accepting while the delivery-stamp write dies — records nothing at all. "This send definitely
 * reached nobody" is not a statement these columns can support, so the confirmation is always asked for
 * once the provider's window has closed.
 *
 * The outcome drives `weeklyReportRetryAcknowledgementPrompt` instead: what the PM is TOLD, not whether
 * they are asked. Mirrors `weeklyReportRetryIsProviderDeduped` in shared, which the CRM and the send
 * service both use — the phone cannot import it, so the two are kept in step by hand and by these tests.
 */
export function weeklyReportRetryNeedsAcknowledgement(
  report: { sentAt: string | null | undefined },
  now: Date = new Date(),
): boolean {
  return !weeklyReportRetryIsProviderDeduped(report.sentAt, now);
}

/**
 * Does this stored `send_error` PROVE the provider created nothing?
 *
 * Mirrors `weeklyReportSendErrorIsProvableRejection` in shared. The worker writes `send_error` with an
 * outcome prefix — `rejected:` when the provider refused the request and created nothing, `unknown:` when
 * we never learned. ONLY the first is evidence. `unknown:` covers a swallowed fetch, a 5xx, a 408 and an
 * in-flight idempotency 409, all of which may have left the message enqueued, so a row can carry a real
 * `send_error` and still be a report the client has.
 *
 * Anchored at the start and requiring the colon: `unknown: ... the address was rejected by the receiving
 * server` contains the word and means the opposite.
 */
function weeklyReportSendErrorIsProvableRejection(sendError: string | null | undefined): boolean {
  if (typeof sendError !== "string") return false;
  return sendError.trimStart().toLowerCase().startsWith("rejected:");
}

/**
 * What the PM is being asked to agree to. Says the cost plainly rather than asking "are you sure?".
 *
 * Mirrors the CRM dialog's substance (weekly-report-history-panel.tsx `RetryButton`) — the two surfaces
 * take the same action against the same service, so a PM must not be warned on one and not the other.
 */
export function weeklyReportRetryAcknowledgementPrompt(sendError?: string | null): {
  title: string;
  message: string;
} {
  // `subject` varies for coherence, matching shared. "the first email" is right when nothing is known
  // about any attempt, and reads as a contradiction directly after telling the PM a recorded attempt sent
  // nothing — so the rejected branch names the unaccounted-for attempts instead.
  const risk = (subject: string) =>
    `This send is more than ${WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS} hours old, so the mail ` +
    `provider will no longer treat a retry as a duplicate. If ${subject} did go out, the client ` +
    "will receive a second copy.";
  return {
    title: "Send this again?",
    message: weeklyReportSendErrorIsProvableRejection(sendError)
      ? "A recorded attempt on this send was refused by the mail provider, so that attempt sent nothing " +
        `— but no other attempt is accounted for. ${risk("one of those")}`
      : risk("the first email"),
  };
}

export interface WeeklyReportRetryPort {
  /**
   * Ask the PM to confirm. Resolves TRUE only on an explicit yes.
   *
   * Every dismissal path — Cancel, the Android back gesture, a dialog that fails to present — must resolve
   * false. Silence is the one answer that can never be read as consent here, because what it would consent
   * to is a second email to a paying client.
   */
  confirm(prompt: { title: string; message: string }): Promise<boolean>;
  /** POST the retry. The flag is passed through to the server, which refuses without it past the window. */
  retry(acknowledgeDuplicateRisk: boolean): Promise<WeeklyReportDetailView>;
  /** The report moved. Refresh the hub, re-read the screen — nothing about this call is secret. */
  onRetried(report: WeeklyReportDetailView): void;
}

/**
 * Ask if it matters, then queue the same message again.
 *
 * THE ACKNOWLEDGEMENT IS PASSED ONLY WHEN IT WAS ACTUALLY ASKED FOR AND GRANTED, which is the same shape
 * the CRM uses (`retryWeeklyReportSend(reportId, !deduped)`). Sending `true` unconditionally would turn a
 * deliberate act into an accidental one and strip the server's last defence; sending `false`
 * unconditionally would make the button 409 outside the window with no way forward.
 *
 * Returns what happened rather than throwing on a decline, because "the PM said no" is an ordinary outcome
 * and the screen must not show it as an error.
 */
export async function runWeeklyReportRetry(
  input: { sentAt: string | null; sendError?: string | null; now?: Date },
  port: WeeklyReportRetryPort,
): Promise<"retried" | "cancelled"> {
  const needsAcknowledgement = weeklyReportRetryNeedsAcknowledgement(
    { sentAt: input.sentAt },
    input.now ?? new Date(),
  );
  if (needsAcknowledgement) {
    const confirmed = await port.confirm(weeklyReportRetryAcknowledgementPrompt(input.sendError));
    if (!confirmed) return "cancelled";
  }
  const report = await port.retry(needsAcknowledgement);
  port.onRetried(report);
  return "retried";
}

export interface WeeklyReportCorrectionPort {
  confirm(prompt: { title: string; message: string }): Promise<boolean>;
  /** POST the correction. Answers with the NEW report — a fresh version in `approved`, not yet sent. */
  create(): Promise<WeeklyReportDetailView>;
  /** Hand the new version on. The screen sends the PM straight into its send flow. */
  onCreated(correction: WeeklyReportDetailView): void;
}

/**
 * What a correction is about to do, worded for the state the PM is actually in.
 *
 * THE UNDELIVERED WORDING IS THE ONE THAT MATTERS HERE, and it is the copy the CRM was missing for a while.
 * A PM staring at "Send failed" reaches for the most prominent button on the screen, and a correction is
 * NOT how a failed delivery is fixed: it creates a v2, takes the failure off the board, and — if the PM is
 * pulled away before finishing it — leaves the client with nothing at all, from a week that now looks
 * handled.
 */
export function weeklyReportCorrectionPrompt(delivered: boolean): { title: string; message: string } {
  return delivered
    ? {
        title: "Issue a correction?",
        message:
          "This creates a new version of the report. Once you send it, the client is told it replaces the " +
          "copy they already have, and their old link starts showing a notice.",
      }
    : {
        title: "Start a new version?",
        message:
          "This report's email never reached the client. A correction is a new version, not a re-send — if " +
          "you only need the delivery to go out, use Retry instead. Start a new version anyway?",
      };
}

/**
 * Confirm, clone, hand on.
 *
 * `delivered` decides only the wording; the route is the same either way. The server owns the refusals that
 * matter — a report that is not `sent`, or a week that already has a newer version — and their sentences
 * name the version to work on, which is more useful than anything this side could pre-empt with.
 */
export async function runWeeklyReportCorrection(
  input: { delivered: boolean },
  port: WeeklyReportCorrectionPort,
): Promise<"created" | "cancelled"> {
  const confirmed = await port.confirm(weeklyReportCorrectionPrompt(input.delivered));
  if (!confirmed) return "cancelled";
  const correction = await port.create();
  port.onCreated(correction);
  return "created";
}

/**
 * Turn a failed retry or correction into something a PM standing on a jobsite can act on.
 *
 * Prefers the server's own sentence for the same reason `weeklyReportSendErrorMessage` does: every
 * actionable case carries one, and they are specific in ways nothing here could reproduce — "A newer
 * version of this report has already been sent to the client…", "Version 3 of this week's report already
 * exists — finish and send that one instead…", "This report's email was already accepted by the mail
 * provider — issue a correction to send it again".
 *
 * THE OFFLINE COPY IS ITS OWN CASE, and it does not tell the PM to try again. A retry request can commit
 * and lose its reply, so a second tap after a dropped connection is exactly how one acknowledged replay
 * becomes two real emails.
 */
export function weeklyReportDeliveryErrorMessage(error: unknown): string {
  const candidate = error as { status?: unknown; message?: unknown } | null | undefined;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const serverMessage = typeof candidate?.message === "string" ? candidate.message.trim() : "";

  if (status === 0 || status === 408) {
    return "No connection, so we can’t tell whether that went through. Open this report again once you have a signal and check what it says before trying again.";
  }
  if (serverMessage && !serverMessage.startsWith("Request failed (")) return serverMessage;
  return "Couldn’t do that. Open this report again to check where it got to before trying again.";
}

/**
 * May this report's delivery be retried at all?
 *
 * Three conditions, each one a 409 the service raises independently:
 *   • `sent`               — nothing else has a delivery to replay.
 *   • not delivered        — an accepted message is re-sent by issuing a correction, not by replaying it.
 *   • not superseded       — a version a correction has already replaced must NEVER go out. It is still
 *                            `sent`, still undelivered, and its stored request still carries a live share
 *                            URL, so replaying it emails a client the version they were told was replaced,
 *                            with nothing in the message saying so, linking to a page that then tells them
 *                            their copy is out of date. The same predicate guards the CRM's button and the
 *                            hub's list; this is what keeps the detail screen from offering it after a race.
 */
export function weeklyReportCanRetryDelivery(
  report: Pick<
    WeeklyReportDetailView,
    "status" | "sendDeliveredAt" | "supersededById"
  >,
): boolean {
  return report.status === "sent" && !report.sendDeliveredAt && !report.supersededById;
}

/**
 * May a correction be started from this report?
 *
 * Only from `sent` — an unsent report is edited instead — and never from a version that has already been
 * superseded, where the fix belongs on the version that replaced it. A week that merely has a newer DRAFT
 * is not excluded here: nothing in this payload can see one, and the server's refusal names it precisely.
 */
export function weeklyReportCanCorrect(
  report: Pick<WeeklyReportDetailView, "status" | "supersededById">,
): boolean {
  return report.status === "sent" && !report.supersededById;
}

/**
 * The hub row's summary line: "Week of Aug 13 · v2 · 3 attempts".
 *
 * Built here rather than in the list so the one place that knows what these columns mean also decides what
 * is worth saying about them — the version is only mentioned when it is not the first, and the attempt
 * count only when something has actually been attempted.
 */
export function weeklyReportUndeliveredSummary(
  item: Pick<WeeklyReportUndeliveredSend, "version" | "sendAttempts">,
  formattedWeekOf: string,
): string {
  const parts = [`Week of ${formattedWeekOf}`];
  if (item.version > 1) parts.push(`v${item.version}`);
  const attempts = Number.isFinite(item.sendAttempts) ? Math.max(0, Math.trunc(item.sendAttempts)) : 0;
  if (attempts > 0) parts.push(`${attempts} attempt${attempts === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
