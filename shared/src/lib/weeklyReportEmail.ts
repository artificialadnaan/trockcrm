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
 * Must the PM be warned that retrying this send can put a SECOND copy in the client's inbox?
 *
 * The question the retry gate actually has to answer, and it is not the same question as "is the key still
 * deduped". Two facts decide it, and every surface that offers Retry has to weigh both the same way — the
 * CRM's History panel, the phone's field route, and `retryWeeklyReportSend`, which is the one that refuses.
 * They were each gating on age alone, so all three warned about a duplicate that could not exist.
 *
 * `sendError` is POSITIVE EVIDENCE THE PROVIDER REFUSED the message: the worker writes it, in the same
 * statement that records the attempt, only on the path where the send itself failed. Nothing left, so
 * nothing can arrive twice, and the confirmation is pure friction on the one retry that is unambiguously
 * correct — friction that pushed PMs towards Send correction, which makes a v2 and takes the failure off
 * the board.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is read `send_delivered_at IS NULL` as "never sent". The stamp is
 * written by a SEPARATE statement after the provider call returns, so a process that dies in between
 * leaves a report the client HAS with no stamp and no error at all — "an ordinary outcome for this worker",
 * as dashboard-service.ts puts it, "the reason the whole idempotency-key design exists". A SILENT record is
 * not evidence of failure. When nothing was recorded either way this still asks, exactly as before.
 *
 * Blank counts as silent. `send_error` is cleared to NULL on every retry, so "no error" is a state the
 * column genuinely reaches on a report that has already been through this path.
 */
export function weeklyReportRetryNeedsDuplicateRiskAck(
  report: { sentAt: string | Date | null | undefined; sendError: string | null | undefined },
  now: Date = new Date(),
): boolean {
  if (typeof report.sendError === "string" && report.sendError.trim().length > 0) return false;
  return !weeklyReportRetryIsProviderDeduped(report.sentAt, now);
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
