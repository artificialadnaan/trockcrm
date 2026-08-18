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
  /** True for a version > 1. The client is told plainly that this replaces what they already have. */
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
export function weeklyReportEmailParagraphs(parts: WeeklyReportEmailParts): string[] {
  const paragraphs: string[] = [weeklyReportGreeting(parts.greetingName)];

  if (parts.isCorrection) {
    // Ahead of the PM's own paragraph, and stated in the platform's words rather than left to whatever
    // they happened to type: the client must be told this supersedes what they already have even when the
    // PM edits the context away entirely.
    paragraphs.push(
      "This is a revised version of a report that was sent to you earlier. It replaces the previous copy.",
    );
  }

  const context = parts.contextParagraph.trim();
  if (context) paragraphs.push(context);

  const link = weeklyReportLinkLine(parts.shareUrl);
  if (link) paragraphs.push(link);

  paragraphs.push(weeklyReportSignatureLines(parts.sender).join("\n"));
  return paragraphs;
}

/** The plain-text alternative part. Same paragraphs, blank line between each. */
export function weeklyReportEmailBodyText(parts: WeeklyReportEmailParts): string {
  return weeklyReportEmailParagraphs(parts).join("\n\n");
}
