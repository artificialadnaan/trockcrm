// The weekly report's client email, composed in ONE place.
//
// The spec's promise that "the send modal is identical on both surfaces because the server composes it"
// only holds if there is a single implementation of what the email says. Three processes need the same
// answer: the API composes the draft the modal renders, the CRM (and later T-Rock Cam) displays it, and
// the WORKER renders the message that actually goes out. A second copy of the greeting or the link line
// anywhere means the PM approves one wording and the client receives another.
//
// So the parts live here, in `shared`, and both the API and the worker assemble from them. The worker owns
// only the HTML table markup — presentation, not content.
//
// No date arithmetic beyond formatting: `week_of` is a plain calendar date and every function here parses
// it at UTC NOON, matching types/weekly-report.ts, so a worker in a UTC container and a laptop in Karachi
// print the same week.

/** A client-team address the modal offers. `role` is the label the report prints (DOC / PM / RM / CM). */
export interface WeeklyReportRecipientOption {
  role: string;
  name: string | null;
  email: string;
}

/** The T-Rock PM block that signs the email. Phone and email are what the client replies to. */
export interface WeeklyReportSenderContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** Everything the body is built from. The PM edits `contextParagraph`; the rest is composed. */
export interface WeeklyReportEmailParts {
  greetingName: string | null;
  contextParagraph: string;
  shareUrl: string | null;
  sender: WeeklyReportSenderContact;
  /**
   * True when an earlier version of this week's report ALREADY REACHED the client.
   *
   * Deliberately not `version > 1`. A v2 exists for two different reasons — the content was wrong, or the
   * v1 email never got out — and only the first is a correction. Telling a client that this "replaces the
   * previous copy" when no previous copy ever arrived sends them looking for an email that does not exist.
   */
  isCorrection: boolean;
}

export const WEEKLY_REPORT_SEND_LIMITS = {
  /** Resend's own ceiling is far higher; this bounds a paste accident, not a real client team. */
  maxRecipients: 25,
  maxSubjectChars: 300,
  /** Long enough for a paragraph of genuine context, short enough that nobody pastes the report into it. */
  maxContextChars: 4_000,
} as const;

/**
 * How long the mail provider's idempotency key actually dedupes for.
 *
 * Resend keeps an idempotency key for 24 HOURS ("Idempotency keys are kept in the system for 24 hours",
 * resend.com/docs/dashboard/emails/idempotency-keys). Past that the key is forgotten and replaying it is
 * an ordinary new send.
 *
 * This matters because the "Send failed" chip persists for the dashboard's 26-week lookback: a PM clicking
 * Retry the following Monday is far outside the window, so the retry path's guarantee that "the worst
 * outcome is a no-op" is only true INSIDE it. Outside, a retry can put a second copy in a client's inbox,
 * which is the one outcome this feature must never produce by accident — so it is made a deliberate,
 * acknowledged act rather than a silent one.
 */
export const WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS = 24;

/**
 * Is a replay of the SAME provider idempotency key still guaranteed not to send twice?
 *
 * Measured from when the send request was created (`sent_at`), which is the earliest the key can have been
 * used. Deliberately conservative: it declares the window closed no later than it really closes, never
 * later, because the failure mode of being wrong the other way is a duplicate client email.
 */
export function weeklyReportRetryIsProviderDeduped(
  sentAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (sentAt == null) return false;
  const stamped = sentAt instanceof Date ? sentAt : new Date(sentAt);
  if (Number.isNaN(stamped.getTime())) return false;
  const elapsedHours = (now.getTime() - stamped.getTime()) / 3_600_000;
  return elapsedHours < WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS;
}

/**
 * The two outcomes a failed send is classified into, and the prefix `send_error` is written with.
 *
 * A CONTRACT between the worker that writes the column and everything that reads it, named here so the two
 * ends cannot drift apart. `weeklyReportSendFailureMessage` builds the stored string from these;
 * `weeklyReportSendErrorIsProvableRejection` takes it apart again.
 *
 * `rejected` — the provider refused the request and created nothing, so the report is PROVABLY undelivered.
 * `unknown` — we never learned. A swallowed fetch, a 5xx, a 408, or a 409 `concurrent_idempotent_requests`
 * all reached something that may have enqueued the message. See `classifySendFailure`, whose default is
 * `unknown` for the same reason: over-reporting `unknown` costs a retry declined, over-reporting `rejected`
 * costs a duplicate delivery.
 */
export const WEEKLY_REPORT_SEND_OUTCOME_REJECTED = "rejected";
export const WEEKLY_REPORT_SEND_OUTCOME_UNKNOWN = "unknown";

/**
 * Does this stored `send_error` PROVE the provider created nothing?
 *
 * Only the `rejected:` prefix does. Everything else — `unknown:`, a legacy row written before the prefix
 * existed, a blank, an absent value — is ambiguous and must be treated as "the client may already have it".
 *
 * ANCHORED AT THE START AND REQUIRING THE COLON, not a substring search: `unknown: ... the address was
 * rejected by the receiving server` contains the word and proves the opposite of what it would be read as.
 * Whitespace and casing are tolerated because this parses a value out of a database column rather than a
 * literal the caller just built.
 */
export function weeklyReportSendErrorIsProvableRejection(sendError: unknown): boolean {
  if (typeof sendError !== "string") return false;
  return sendError.trimStart().toLowerCase().startsWith(`${WEEKLY_REPORT_SEND_OUTCOME_REJECTED}:`);
}

/**
 * What the PM is asked to agree to before a retry the provider will no longer dedupe.
 *
 * WHEN it is asked is decided by AGE ALONE (`weeklyReportRetryIsProviderDeduped`). This function changes
 * only what the dialog SAYS, and that division is the whole point.
 *
 * Three rounds of review went into trying to make the GATE outcome-aware — suppressing the confirmation on
 * a send we could show had failed — and each round produced a new counterexample of the same shape:
 * `send_delivered_at IS NULL` is not proof of non-delivery; a non-blank `send_error` is not proof of
 * refusal; and a `rejected:` on the LATEST attempt is not proof that an EARLIER attempt did not deliver,
 * because `send_error` is overwritten per attempt and a retry clears it while keeping `send_attempts`.
 *
 * The question is underdetermined by the columns, and the case that matters most cannot be recorded at all:
 * when the provider accepts and the delivery stamp write dies, nothing is written by construction. So the
 * platform stopped trying to prove a negative it cannot prove, and the confirmation stayed.
 *
 * WHAT WAS ACTUALLY WRONG was the sentence, not the gate. A PM in front of a "Send failed" chip was told
 * flatly that the client might get a second copy, with nothing acknowledging that the attempt they are
 * looking at demonstrably sent nothing — so the obvious read was "retrying is dangerous", and the button
 * they reached for instead was Send correction, which mints a v2 and takes the failure off the board.
 *
 * So when the record carries a provable rejection this SAYS so, and is then careful about the rest: that
 * attempt sent nothing, no other attempt is accounted for, and past the window a replay is a new email.
 * It states what is known and stops there.
 *
 * DELIBERATELY NOT "the last attempt". `send_error` is cleared only by the statement that also stamps the
 * delivery, so a rejected attempt followed by a successful one whose stamp write dies leaves `rejected:`
 * on a row the client HAS. Calling it the latest attempt would be a false claim in exactly the state that
 * matters, and would encourage the duplicate this dialog exists to prevent. "A recorded attempt" asserts
 * only what the column can support: that some attempt was refused, not which, and nothing about the rest.
 */
export function weeklyReportRetryDuplicateRiskPrompt(sendError?: string | null): string {
  // "the first email" only makes sense when nothing is known about any attempt. After telling a PM that a
  // recorded attempt sent nothing, it reads as a contradiction of the sentence they just finished — so the
  // rejected branch names what is actually unaccounted for instead. Found by printing the finished string
  // and reading it, which no assertion here was ever going to do.
  const risk = (subject: string) =>
    `This send is more than ${WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS} hours old, so the mail ` +
    `provider will no longer treat a retry as a duplicate. If ${subject} did go out, the client will ` +
    "receive a second copy. Send it again?";
  if (!weeklyReportSendErrorIsProvableRejection(sendError)) return risk("the first email");
  return (
    "A recorded attempt on this send was refused by the mail provider, so that attempt sent nothing — but " +
    `no other attempt is accounted for. ${risk("one of those")}`
  );
}

/**
 * The frozen `send_request` jsonb — the ONLY description of what was sent, and the contract between the
 * API that writes it and the worker that reads it.
 *
 * Declared here, in shared, rather than separately in each package: the two used to be a server-side
 * interface and a hand-written worker test fixture, so the worker suite asserted the contract against its
 * own copy of it and a field the API stopped writing would have gone unnoticed by both.
 */
export interface WeeklyReportSendRequest {
  recipients: string[];
  subject: string;
  greetingName: string | null;
  contextParagraph: string;
  shareUrl: string;
  sender: WeeklyReportSenderContact;
  attachPdf: boolean;
  isCorrection: boolean;
  requestedBy: string;
  requestedAt: string;
  requestVersion: 1;
}

/**
 * Every key the request carries, at RUNTIME.
 *
 * The interface above is erased at compile time, so it cannot stop the API writing a row the worker reads
 * a missing field from. Both sides assert their object against this list, which is what turns "the worker
 * fixture matches the worker's expectations" into "the worker fixture matches what the API actually
 * writes".
 */
export const WEEKLY_REPORT_SEND_REQUEST_KEYS: ReadonlyArray<keyof WeeklyReportSendRequest> = [
  "recipients",
  "subject",
  "greetingName",
  "contextParagraph",
  "shareUrl",
  "sender",
  "attachPdf",
  "isCorrection",
  "requestedBy",
  "requestedAt",
  "requestVersion",
];

/**
 * A subject line safe to hand a mail provider.
 *
 * CR and LF are stripped rather than trimmed: the PM's subject is free text that reaches
 * `resend.emails.send({ subject })`, and a bare newline in a header value is the classic header-injection
 * shape. Resend builds the MIME server-side so this is defence in depth, not a live exploit — but the
 * value is unsanitised otherwise, and "the provider probably handles it" is not a property this codebase
 * can assert.
 */
export function sanitizeWeeklyReportSubject(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Deliberately permissive: one "@", a dotted domain, no whitespace.
 *
 * Matching the field-scorecard job's check rather than inventing a stricter one. A PM typing a real but
 * unusual client address must not be refused by a regex that is cleverer than the mail system.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isWeeklyReportEmailAddress(value: unknown): value is string {
  return typeof value === "string" && EMAIL_PATTERN.test(value.trim());
}

/**
 * Trim, drop blanks and invalid addresses, de-duplicate CASE-INSENSITIVELY, preserve the first spelling.
 *
 * Case-insensitive because "Jay@example.com" and "jay@example.com" are one mailbox, and sending a client
 * their report twice because the PM typed it differently in two boxes is the kind of thing that gets the
 * whole feature switched off.
 */
export function normalizeWeeklyReportRecipients(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!isWeeklyReportEmailAddress(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * "8/13/26" — the format the reference report's header uses, so the subject line and the document a client
 * opens name the same week the same way.
 *
 * Byte-identical to the PDF renderer's own `formatWeeklyReportDate`; the two are asserted equal in
 * server/src/modules/weekly-reports/send-email.test.ts rather than left to agree by inspection.
 */
export function weeklyReportWeekLabel(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const parsed = new Date(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}/${String(parsed.getUTCFullYear()).slice(-2)}`;
}

/** `{Property Name} — Weekly Progress Report, Week of 8/13/26`, exactly as the spec writes it. */
export function weeklyReportEmailSubject(input: {
  propertyName: string | null | undefined;
  weekOf: string | null | undefined;
}): string {
  const property = (input.propertyName ?? "").trim() || "Weekly Progress Report";
  const week = weeklyReportWeekLabel(input.weekOf);
  const suffix = week ? `Weekly Progress Report, Week of ${week}` : "Weekly Progress Report";
  return `${property} — ${suffix}`.slice(0, WEEKLY_REPORT_SEND_LIMITS.maxSubjectChars);
}

/**
 * "Hello Jay," — the FIRST name only.
 *
 * A weekly note to a client one has been on site with all year does not open "Hello Jay Stauble,". Falling
 * back to "Hello," rather than to a role or a company name: an email that opens "Hello DOC," is worse than
 * one that opens with nothing.
 */
export function weeklyReportGreeting(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? `Hello ${first},` : "Hello,";
}

/**
 * Who the greeting names, given the addresses actually selected.
 *
 * The first SELECTED recipient that maps to a client-team role, so removing the DOC and leaving only the
 * client's PM re-addresses the greeting to them rather than continuing to greet somebody who is no longer
 * on the email. A free-typed address matches no role and leaves the greeting generic, which is right — the
 * platform does not know whose mailbox it is.
 *
 * Lives in `shared` because THREE places have to agree on it: the API composing the draft, the API
 * recomposing at send from the recipients the PM finally chose, and the modal, which has to re-derive it
 * live as the PM edits the list. It used to exist only on the server, so the modal rendered the greeting
 * from the PRE-FILLED options and went stale the moment anyone touched the To field — the PM approved
 * "Hello Jay," and the client read "Hello Melissa,".
 */
export function weeklyReportGreetingNameFor(
  options: readonly WeeklyReportRecipientOption[],
  recipients: readonly string[],
): string | null {
  const byEmail = new Map(options.map((option) => [option.email.toLowerCase(), option]));
  for (const recipient of recipients) {
    const match = byEmail.get(recipient.trim().toLowerCase());
    if (match?.name) return match.name;
  }
  return null;
}

/**
 * The editable middle paragraph, pre-filled.
 *
 * A default rather than a blank box because the PM sending twenty of these on a Thursday afternoon will
 * otherwise send twenty blank ones — and because a default that is already correct is what makes editing
 * it a deliberate act.
 */
export function weeklyReportDefaultContextParagraph(input: {
  propertyName: string | null | undefined;
  weekOf: string | null | undefined;
  isCorrection: boolean;
}): string {
  const property = (input.propertyName ?? "").trim();
  const week = weeklyReportWeekLabel(input.weekOf);
  const forWeek = week ? ` for the week of ${week}` : "";
  const onProject = property ? ` at ${property}` : "";
  if (input.isCorrection) {
    return (
      `Please find an updated copy of the weekly progress report${onProject}${forWeek}. ` +
      `It replaces the version sent previously — please use this one.`
    );
  }
  return (
    `Please find this week's progress report${onProject}${forWeek}. ` +
    `It covers the work completed, what is planned for next week, and the current schedule position.`
  );
}

/** The sentence that carries the link. Split out so the API preview and the worker cannot word it apart. */
export function weeklyReportLinkLine(shareUrl: string | null | undefined): string | null {
  const url = (shareUrl ?? "").trim();
  return url ? `Here's the link to your weekly report: ${url}` : null;
}

/** The signature block: the T-Rock PM's name, email and phone, one per line, blanks omitted. */
export function weeklyReportSignatureLines(sender: WeeklyReportSenderContact): string[] {
  return [
    (sender.name ?? "").trim() || "T-Rock Construction",
    (sender.email ?? "").trim(),
    (sender.phone ?? "").trim(),
  ].filter((line) => line.length > 0);
}

/**
 * The body as an ordered list of paragraphs — the single source both renderers read.
 *
 * A list rather than a finished string so the HTML renderer can wrap each paragraph in its own `<p>`
 * without re-splitting text and guessing where the author meant a break. `weeklyReportEmailBodyText`
 * joins the same list for the plain-text part, so the two can never say different things.
 */
export type WeeklyReportEmailParagraphKind =
  | "greeting"
  | "correction"
  | "context"
  | "link"
  | "signature";

/** One paragraph of the body, TAGGED with what it is. */
export interface WeeklyReportEmailParagraph {
  kind: WeeklyReportEmailParagraphKind;
  text: string;
}

/**
 * The body as an ordered list of TAGGED paragraphs — the single source both renderers read.
 *
 * Tagged, not bare strings, because the HTML renderer needs to treat exactly one of them differently: the
 * link sentence is rendered as a button rather than repeated as text. Identifying that paragraph by
 * SEARCHING its text for the share URL is what a previous revision did, and it dropped the PM's whole
 * paragraph whenever their message happened to quote the link — from the HTML part only, so the plain-text
 * alternative still carried it and the two parts of the same email disagreed. A tag cannot mistake one
 * paragraph for another.
 */
export function weeklyReportEmailParagraphBlocks(
  parts: WeeklyReportEmailParts,
): WeeklyReportEmailParagraph[] {
  const paragraphs: WeeklyReportEmailParagraph[] = [
    { kind: "greeting", text: weeklyReportGreeting(parts.greetingName) },
  ];

  if (parts.isCorrection) {
    // Ahead of the PM's own paragraph, and stated in the platform's words rather than left to whatever
    // they happened to type: the client must be told this supersedes what they already have even when the
    // PM edits the context away entirely.
    paragraphs.push({
      kind: "correction",
      text: "This is a revised version of a report that was sent to you earlier. It replaces the previous copy.",
    });
  }

  const context = parts.contextParagraph.trim();
  if (context) paragraphs.push({ kind: "context", text: context });

  const link = weeklyReportLinkLine(parts.shareUrl);
  if (link) paragraphs.push({ kind: "link", text: link });

  paragraphs.push({ kind: "signature", text: weeklyReportSignatureLines(parts.sender).join("\n") });
  return paragraphs;
}

/**
 * The body as an ordered list of paragraphs.
 *
 * A list rather than a finished string so the HTML renderer can wrap each paragraph in its own row without
 * re-splitting text and guessing where the author meant a break. `weeklyReportEmailBodyText` joins the same
 * list for the plain-text part, so the two can never say different things.
 */
export function weeklyReportEmailParagraphs(parts: WeeklyReportEmailParts): string[] {
  return weeklyReportEmailParagraphBlocks(parts).map((paragraph) => paragraph.text);
}

/** The plain-text alternative part. Same paragraphs, blank line between each. */
export function weeklyReportEmailBodyText(parts: WeeklyReportEmailParts): string {
  return weeklyReportEmailParagraphs(parts).join("\n\n");
}
