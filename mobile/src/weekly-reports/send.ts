// Sending the weekly report to the client, from the phone.
//
// The send is the step the assigned PM could never take. The CRM's send routes are gated admin/director,
// and the roles that may HOLD the PM slot are field_contractor/construction/admin/director — so a
// `construction` PM, which is the ordinary case, was refused before any permission logic ran. Their route
// is /field/weekly-reports/reports/:id/send, and this module is the phone's half of it.
//
// WHAT THIS FILE MAY AND MAY NOT DECIDE.
//
// It may decide what to SHOW and when to refuse a round trip. It may NOT decide what the email says. The
// subject, the greeting, the default message and the body preview are composed by the server and shipped
// as data precisely so the CRM's dialog and this screen cannot drift into two different emails for one
// feature — the same rule status.ts states for the labels, and it bites harder here because a client reads
// the result. So there is no greeting rule and no body assembly below; when the PM edits the recipient
// list far enough that the server's preview no longer describes the email, this says so rather than
// guessing at the new one.
//
// The limits ARE mirrored, because they are refusals rather than content: a phone that posts 4,001
// characters over LTE and waits for a 400 has spent the round trip to learn something it could have said
// immediately. __tests__/send.test.ts reads the real constants out of shared/src/lib/weeklyReportEmail.ts
// and fails if these drift.
//
// THE RAW SHARE TOKEN. `POST /send` answers with a `shareUrl` containing the only copy of the raw token
// that will ever exist — the server stores a SHA-256 hash, and no later read returns it. It is handed to
// the caller through `reveal` and is deliberately not reachable from anything this module persists. See
// `runWeeklyReportSend`.

import type {
  WeeklyReportDetailView,
  WeeklyReportSendDraftView,
} from "../api/types";

/**
 * Mirrors WEEKLY_REPORT_SEND_LIMITS in shared/src/lib/weeklyReportEmail.ts.
 *
 * Restated rather than imported because `mobile/` is a non-workspace Expo app that cannot resolve
 * @trock-crm/shared at runtime. The server re-validates every one of these, so the copy here is an early
 * refusal and never the enforcement.
 */
export const WEEKLY_REPORT_SEND_LIMITS = {
  maxRecipients: 25,
  maxSubjectChars: 300,
  maxContextChars: 4_000,
} as const;

/**
 * The same shape check the CRM dialog applies before adding an address.
 *
 * Deliberately loose. `normalizeWeeklyReportRecipients` on the server is the authority and this only has
 * to catch the typo the PM can see — a strict RFC 5322 pattern here would refuse addresses the server
 * accepts, which is worse than letting one round trip through.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isWeeklyReportRecipientShape(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/**
 * The list that will actually be POSTed, INCLUDING an address typed but never added.
 *
 * This is not a nicety. The CRM dialog documents the same trap: a PM types the client's new contact into
 * the "add" field, taps Send without tapping Add, and the person they had just added never receives the
 * report — silently, because the request succeeds. On a phone it is worse: the keyboard covers the Add
 * button, so typing-then-sending is the natural gesture rather than the careless one.
 *
 * Returns an error instead of dropping the pending value, for the same reason the server rejects rather
 * than filters an unusable recipient: the honest outcomes are "this went where you asked" or "fix this",
 * never "this went to some of them".
 */
export function weeklyReportSendRecipients(input: {
  selected: string[];
  pending: string;
}): { recipients: string[]; error: string | null } {
  const pending = input.pending.trim();
  if (!pending) return { recipients: input.selected, error: null };
  if (!isWeeklyReportRecipientShape(pending)) {
    return { recipients: input.selected, error: "That doesn’t look like an email address." };
  }
  const already = input.selected.some((entry) => entry.toLowerCase() === pending.toLowerCase());
  return { recipients: already ? input.selected : [...input.selected, pending], error: null };
}

/**
 * Why this send cannot be attempted, or null.
 *
 * Every case here has a matching 400 on the server; none of them replaces it. What this buys is the
 * difference between a jobsite LTE round trip and an immediate sentence, on the one screen where the round
 * trip is also the point of no return.
 */
export function weeklyReportSendValidationError(input: {
  recipients: string[];
  subject: string;
  contextParagraph: string;
}): string | null {
  if (input.recipients.length === 0) {
    return "Add at least one client address before sending.";
  }
  if (input.recipients.length > WEEKLY_REPORT_SEND_LIMITS.maxRecipients) {
    return `A report can go to at most ${WEEKLY_REPORT_SEND_LIMITS.maxRecipients} recipients.`;
  }
  const invalid = input.recipients.find((entry) => !isWeeklyReportRecipientShape(entry));
  if (invalid) return `${invalid} is not a valid email address.`;
  if (!input.subject.trim()) return "The subject cannot be blank.";
  if (input.subject.length > WEEKLY_REPORT_SEND_LIMITS.maxSubjectChars) {
    return `The subject is limited to ${WEEKLY_REPORT_SEND_LIMITS.maxSubjectChars} characters.`;
  }
  if (input.contextParagraph.length > WEEKLY_REPORT_SEND_LIMITS.maxContextChars) {
    return `The message is limited to ${WEEKLY_REPORT_SEND_LIMITS.maxContextChars} characters.`;
  }
  return null;
}

/**
 * Whether the server's body preview still describes the email that will go out, and what to say if not.
 *
 * `bodyPreview` and `greeting` are composed from the PRE-FILLED recipients. The server picks the greeting
 * from the list it is FINALLY given, so the moment the PM removes the DOC and leaves the client's PM on,
 * the preview says "Hello Jay," for an email that will read "Hello Melissa,".
 *
 * The CRM fixes this by recomputing the greeting with the shared function. This app cannot: it cannot
 * import `shared`, and a second implementation of a rule the client reads is exactly what the shared
 * module exists to prevent — a mirror that drifted would put a wrong name in front of a paying client
 * while both surfaces claimed to show what would be sent. So the preview is marked stale instead. Saying
 * "the greeting is chosen when you send" is a true sentence; guessing at the name is not.
 */
export function weeklyReportSendPreviewNote(
  draft: Pick<WeeklyReportSendDraftView, "recipients">,
  recipients: string[],
): string | null {
  const before = draft.recipients.map((entry) => entry.toLowerCase());
  const after = recipients.map((entry) => entry.toLowerCase());
  const unchanged = before.length === after.length && before.every((entry, i) => entry === after[i]);
  if (unchanged) return null;
  return "You’ve changed who this goes to, so the greeting below may differ — the client’s name is chosen from the final list when you send.";
}

/**
 * The banner above the form for a version that is not the first.
 *
 * Keyed on `isCorrection`, NOT on `version > 1`, and the distinction is the whole point. A v2 exists for
 * two different reasons — the content was wrong, or the v1 email never got out — and only the first
 * replaces anything. The server decides which by asking whether an earlier version actually reached the
 * client, and the email itself says the same thing, so the screen must read the same flag or it will
 * promise something the message does not.
 */
export function weeklyReportSendVersionNote(
  draft: Pick<WeeklyReportSendDraftView, "isCorrection" | "version">,
): string | null {
  if (draft.isCorrection) {
    return `Version ${draft.version}. The client is told plainly that this replaces the copy they already have, and their earlier link starts showing a notice that a newer version was issued.`;
  }
  if (draft.version > 1) {
    return `Version ${draft.version}. The earlier version never reached the client, so this goes out as their first copy — it does not say it replaces anything.`;
  }
  return null;
}

/**
 * Turn a failed send into something a PM standing on a jobsite can act on.
 *
 * The server's own message is preferred wherever it has one, because every actionable case carries it:
 * "This report has already been sent — issue a correction instead", "A report has to be approved by the PM
 * before it can go to the client", "Only the assigned project manager or office leadership can send this
 * report to the client", and the retry's duplicate-risk sentence.
 *
 * THE OFFLINE COPY IS DIFFERENT FROM THE WIZARD'S, ON PURPOSE. `weeklyReportSubmitErrorMessage` says the
 * work is safe on the phone, which is true of a draft and false of this: nothing about a send is held
 * locally, and the one thing the PM needs to know after a lost connection is whether the email went. It
 * may have — the request can commit and lose its reply — so the honest instruction is to re-open the
 * report and look at its status rather than to tap Send again.
 */
export function weeklyReportSendErrorMessage(error: unknown): string {
  const candidate = error as { status?: unknown; message?: unknown } | null | undefined;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const serverMessage = typeof candidate?.message === "string" ? candidate.message.trim() : "";

  if (status === 0 || status === 408) {
    return "No connection, so we can’t tell whether the email went out. Open the report again once you have a signal and check whether it says Sent before trying again.";
  }
  if (serverMessage && !serverMessage.startsWith("Request failed (")) return serverMessage;
  return "Couldn’t send this report. Open it again to check whether it went out before trying again.";
}

/**
 * What the send produced. `shareUrl` appears HERE and is not carried anywhere else.
 *
 * Typed as its own object rather than folded into the report so that every caller has to name it to touch
 * it — the point being that a caller which does not name it cannot accidentally carry the live client link
 * into a draft, a log or a crash report.
 */
export interface WeeklyReportSendOutcome {
  report: WeeklyReportDetailView;
  shareUrl: string;
}

export interface WeeklyReportSendPort {
  /** POST the send. Resolves with the server's answer, including the one-time link. */
  send(payload: {
    recipients: string[];
    subject: string;
    contextParagraph: string;
    attachPdf: boolean;
  }): Promise<WeeklyReportSendOutcome>;
  /**
   * Show the outcome. The ONLY thing handed the raw link.
   *
   * `reveal`, not `save`: the screen renders it for copying and holds it in component state that dies with
   * the screen. public.weekly_report_tokens keeps a SHA-256 hash, so a link written to the draft store or
   * to a log is a live 180-day unauthenticated credential for a client's report sitting in a place with
   * none of the protections the token table has, and one nothing will ever revoke because nothing knows
   * it is there.
   */
  reveal(outcome: WeeklyReportSendOutcome): void;
  /** Tell the caller the report moved, WITHOUT the link — hub refresh, cache invalidation, navigation. */
  recordSent(report: WeeklyReportDetailView): void;
}

/**
 * Validate, send, reveal — and hand the report on without the link.
 *
 * The ordering is the substance. `recordSent` runs with the REPORT only and never sees `shareUrl`, so the
 * refresh-and-navigate path this feature shares with every other mutation cannot carry a live client
 * credential into a query cache, a draft on disk or a navigation param that lands in a crash breadcrumb.
 * Splitting one callback into two is the whole guard: with a single `onSent(outcome)` every downstream
 * caller would receive the token whether it wanted it or not, and it would leak the first time somebody
 * logged "sent" with its argument.
 *
 * Validation happens here rather than in the screen so it is covered by the one suite `mobile/` runs —
 * this app is not in CI and has no OTA, so a branch that exists only inside a React component ships to
 * phones unexecuted by anything.
 */
export async function runWeeklyReportSend(
  input: {
    recipients: string[];
    subject: string;
    contextParagraph: string;
    attachPdf: boolean;
  },
  port: WeeklyReportSendPort,
): Promise<WeeklyReportSendOutcome> {
  const invalid = weeklyReportSendValidationError(input);
  if (invalid) throw new WeeklyReportSendInputError(invalid);

  const outcome = await port.send({
    recipients: input.recipients,
    subject: input.subject,
    contextParagraph: input.contextParagraph,
    attachPdf: input.attachPdf,
  });

  port.reveal(outcome);
  port.recordSent(outcome.report);
  return outcome;
}

/**
 * A refusal raised before anything left the phone.
 *
 * `status: 400` so `weeklyReportSendErrorMessage` shows the sentence verbatim rather than replacing it
 * with the offline copy — the same convention `WeeklyReportOvertakenError` uses for a 409.
 */
export class WeeklyReportSendInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "WeeklyReportSendInputError";
  }
}
