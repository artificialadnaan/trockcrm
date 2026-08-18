import { createHash } from "node:crypto";
import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailOutcome,
  type SendSystemEmailResult,
} from "../lib/system-email.js";
import { escapeHtml, isSafeTenantSchema, normalizeText } from "../lib/email-format.js";
import { acquirePgAdvisoryLock, type AdvisoryLockPool } from "../lib/advisory-lock.js";
// Reuse the branded-email primitives (frontend URL + hosted logo) so these reminders point at
// trockcrm.com and match the scorecard / RFP / project-number emails' look.
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
import {
  WEEKLY_REPORT_REMINDER_OFFSET_DAYS,
  daysBetweenIsoDates,
  weeklyReportExpectedWeeks,
  type WeeklyReportPauseInterval,
  weeklyReportWeekOf,
  weeklyReportWeekStateLabel,
  type WeeklyReportReminderKind,
  type WeeklyReportWeekState,
} from "@trock-crm/shared/types";

/**
 * Weekly Reports reminder cron — 07:00 America/Chicago, daily, with catch-up ticks at 09:00 and 11:00.
 *
 * Three notifications hang off one cadence date, derived per project from `cadence_weekday`:
 *
 *   • due − 2 days  — super + PM: "your report is due Thursday". Unconditional; it is the heads-up.
 *   • due − 1 day   — super + PM, ONLY when the week is still unfiled. Silent when it is already
 *                     submitted, so a reminder that arrives keeps meaning "you actually owe this".
 *   • the due date  — ONE digest to `weekly_report_settings.leadership_recipient_emails`: who filed,
 *                     who has not, and what is still outstanding from earlier weeks.
 *
 * The cadence arithmetic is NOT re-implemented here. `weeklyReportWeekOf` / `weeklyReportExpectedWeeks`
 * in `shared` are the same functions the CRM dashboard generates its rows from and the API validates
 * `week_of` against; a second implementation in the worker would let the reminder fire for a week the
 * dashboard is not tracking.
 */

/**
 * The timezone every cadence date is measured in. Mirrors BUSINESS_TIMEZONE in server/src/lib/period.ts.
 *
 * Hardcoded rather than read from `public.offices.timezone` (which exists, defaulting to this value)
 * because the cron's own `timezone: "America/Chicago"` fixes the FIRING time platform-wide: resolving a
 * hypothetical Denver office's calendar day here while still waking at 07:00 CT would produce a reminder
 * at 06:00 local, not a correct one. Making this per-office means making the schedule per-office too, and
 * there is one office today. Revisit both together.
 */
const BUSINESS_TIMEZONE = "America/Chicago";

/**
 * How far back the leadership digest's backlog block looks.
 *
 * The same VALUE as the CRM dashboard's DEFAULT_OUTSTANDING_LOOKBACK_WEEKS, applied the same way — a
 * count of expected weeks, not a date range, because a count is what `dashboard-service.ts` cuts on and
 * the two differ by a week at the edge. It is a copied literal and not an import only because
 * `dashboard-service.ts` lives in `server/`, which the worker cannot reach at runtime. The suite CAN
 * reach it, and asserts the two are equal — a hand-copied constant with nothing watching it is how the
 * email ends up quietly counting a different backlog than the board it links to.
 */
export const WEEKLY_REPORT_DIGEST_LOOKBACK_WEEKS = 26;

/**
 * A week is FILED once the superintendent has handed it over — anything past `draft`.
 *
 * Shared by the t−1 silence rule and the digest's current-week split. If either counted only `sent`, a
 * super who submitted on time would be listed as outstanding at 07:00 on the due date purely because the
 * PM had not reviewed yet, and the reminder they did NOT receive the day before would contradict it.
 */
const FILED_REPORT_STATUSES = new Set(["pending_review", "approved", "sent"]);

/**
 * A PAST week is only accounted for once it actually went to the client.
 *
 * Deliberately a stricter bar than FILED_REPORT_STATUSES, and the difference is the question each answers.
 * For the week due TODAY the question is "has the super done their part yet" — a submitted report is a
 * done job at 07:00. For a week from a month ago the question is "did the client ever get it", and a
 * report stuck in `pending_review` since July is exactly the thing leadership needs surfaced. This is also
 * the dashboard's own predicate (`!dismissed && status !== 'sent'`), so the backlog in the email and the
 * outstanding rows on the page it links to count the same weeks.
 */
const DELIVERED_REPORT_STATUSES = new Set(["sent"]);

/**
 * Whether reminder emails may render the T-Rock Cam deep link. Default OFF — see weeklyReportReminderLinks.
 */
export function weeklyReportAppDeepLinksEnabled(env: NodeJS.ProcessEnv): boolean {
  return String(env.WEEKLY_REPORT_APP_DEEP_LINKS ?? "").trim().toLowerCase() === "true";
}

/**
 * Report status → the dashboard's week state, so the digest prints the SAME words the board does
 * ("Approved, not sent", "Sent") instead of collapsing everything filed into one label.
 */
const REPORT_STATE_BY_STATUS: Record<string, WeeklyReportWeekState> = {
  draft: "draft",
  pending_review: "pending_review",
  approved: "approved",
  sent: "sent",
};

/**
 * Every per-office table one tick reads or writes. Probed together before the office runs — see the
 * guard in runWeeklyReportReminders. `weekly_report_pauses` comes from 0223 and the rest from 0222, so
 * "the feature's tables exist" is not a single fact and must not be tested as one.
 */
const REQUIRED_TENANT_TABLES = [
  "weekly_report_projects",
  "weekly_report_pauses",
  "weekly_reports",
  "weekly_report_dismissals",
  "weekly_report_settings",
  "weekly_report_reminders_sent",
] as const;

/** Basic sanity check on a stored address before it becomes a recipient. Mirrors the scorecard email's. */
function isBasicValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Is this stored address something a reminder can actually be sent to?
 *
 * ONE predicate, deliberately shared: `sendProjectReminder` decides whether to send by it, and the digest
 * marks a project "(unreachable)" by it. Two spellings of the same rule would make the annotation disagree
 * with the send.
 *
 * It answers only "can a reminder be addressed RIGHT NOW". Whether one actually WAS sent is a different
 * question with a different source — `weekly_report_reminders_sent`, read in sendLeadershipDigest — because
 * an assignment changes between the nudge and the digest, and reading the past off this predicate told
 * leadership both that a never-emailed super had been chased and that a chased one had not.
 */
function isDeliverableEmail(email: string | null | undefined): email is string {
  return email != null && isBasicValidEmail(email);
}

/** "YYYY-MM-DD" for `now`'s America/Chicago calendar day. */
export function businessCalendarDay(now: Date): string {
  // en-CA formats as YYYY-MM-DD. The worker container runs at UTC, so reading the date off the instant
  // directly would put every send between 18:00 and midnight CT on the FOLLOWING cadence day — and the
  // 07:00 tick is only safe by accident. Resolve the business day explicitly.
  return now.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}

/** `date` columns arrive as Date or string depending on whether a type parser is installed. */
function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return null;
}

/**
 * Which reminder (if any) fires when the due date is `leadDays` away.
 *
 * Read out of the shared offset table rather than re-listing 2/1/0, so the kinds, the CHECK constraint on
 * `weekly_report_reminders_sent.kind` and this scheduler cannot drift apart.
 */
export function reminderKindForLeadDays(leadDays: number): WeeklyReportReminderKind | null {
  for (const [kind, offset] of Object.entries(WEEKLY_REPORT_REMINDER_OFFSET_DAYS)) {
    if (offset === leadDays) return kind as WeeklyReportReminderKind;
  }
  return null;
}

/** "Thursday, Aug 13" — the phrasing the reminder copy uses for a due date. */
export function formatDueDay(isoDate: string): string {
  // Anchored at UTC noon and formatted in UTC: the string is a calendar date, not an instant, and
  // formatting it in any other zone can shift it a day.
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/**
 * Where a reminder sends its recipient.
 *
 * `appUrl` is the expo-linking custom scheme — `scheme: "trockcam"` in mobile/app.config.ts, with the
 * `(app)` route group transparent in the URL, the same shape as the corrective-action deep link. `webUrl`
 * is the https fallback into the CRM. Universal links (and the apple-app-site-association hosting they
 * need) are out of scope, so the two are offered side by side rather than collapsed into one https URL
 * that resolves to either.
 *
 * `appUrl` IS NULL UNLESS `WEEKLY_REPORT_APP_DEEP_LINKS=true`, and the flag defaults off because emitting
 * this link before the mobile route exists is actively harmful, not merely useless. `mobile/app/(app)/`
 * has no `reports/` route yet (it lands with the T-Rock Cam PR), and
 * `mobile/src/wearables/pairing-callback.ts` treats any URL whose route key is NOT in
 * `APP_OWN_ROUTES = {accept-invite, scorecards}` as a possible Meta pairing callback — deliberately a
 * deny-list. So today a tapped `trockcam://reports/...` is RETAINED as a pairing callback, evicting a real
 * held one and leaving the glasses unpaired, on top of landing the super on an unmatched route. Turning
 * the flag on requires both the route and a `"reports"` entry in `APP_OWN_ROUTES`. Until then every
 * reminder ships with the CRM link alone, which works.
 *
 * `webUrl` carries `officeId` and NOTHING ELSE. It briefly also carried `projectId` and `weekOf`, which
 * looked like deep-linking and was not: `client/src/pages/projects/weekly-reports-page.tsx` never reads
 * the query string (no `useSearchParams`, no `location.search`), so the recipient landed on the whole
 * unfiltered board while the URL promised a filtered one. Emitting parameters no page consumes is a
 * promise to the reader, not to the code — add them back in the same change that teaches the board to
 * honour them. `officeId` stays because office context in the CRM genuinely IS URL-driven: drop it and
 * the recipient lands in their home office instead of the one the reminder is about.
 */
export function weeklyReportReminderLinks(input: {
  frontendUrl: string;
  officeId: string | null;
  weeklyReportProjectId: string;
  weekOf: string;
  appDeepLinksEnabled: boolean;
}): { appUrl: string | null; webUrl: string } {
  const base = input.frontendUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (input.officeId) params.set("officeId", input.officeId);
  const search = params.toString();
  return {
    appUrl: input.appDeepLinksEnabled
      ? `trockcam://reports/weekly/${encodeURIComponent(input.weeklyReportProjectId)}?weekOf=${encodeURIComponent(input.weekOf)}`
      : null,
    webUrl: search ? `${base}/projects/weekly-reports?${search}` : `${base}/projects/weekly-reports`,
  };
}

/** The leadership digest's only link: the dashboard the whole feature exists to keep honest. */
export function weeklyReportDashboardUrl(frontendUrl: string, officeId: string | null): string {
  const base = frontendUrl.replace(/\/+$/, "");
  return officeId
    ? `${base}/projects/weekly-reports?officeId=${encodeURIComponent(officeId)}`
    : `${base}/projects/weekly-reports`;
}

// ---------------------------------------------------------------------------------------------------
// Email composition
// ---------------------------------------------------------------------------------------------------

export interface BrandedEmailInput {
  title: string;
  preheader: string;
  bodyHtml: string;
  primaryLabel: string;
  primaryUrl: string;
  secondaryLabel?: string;
  secondaryUrl?: string;
}

/**
 * Exported for the dead-letter sweep (`weekly-report-send-sweep.ts`), which is a second notification about
 * the same feature to the same leadership roster. A hand-copied shell would be one more place the brand
 * has to be changed twice, and the two emails arriving in the same inbox looking subtly different is how a
 * recipient starts wondering which of them is the real one.
 */
export function renderBrandedEmail(input: BrandedEmailInput): string {
  const primaryUrl = escapeHtml(input.primaryUrl);
  const secondary =
    input.secondaryUrl && input.secondaryLabel
      ? `
          <tr>
            <td align="center" style="padding:0 24px 24px 24px;">
              <a href="${escapeHtml(input.secondaryUrl)}" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#64748b;text-decoration:underline;">${escapeHtml(input.secondaryLabel)}</a>
            </td>
          </tr>`
      : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(input.title)}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr>
            <td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 24px 8px 24px;background-color:#ffffff;">
              <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 0 24px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">${escapeHtml(input.title)}</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">${escapeHtml(input.preheader)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px;">${input.bodyHtml}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 24px 12px 24px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${primaryUrl}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="9%" stroke="f" fillcolor="#CC0000">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${escapeHtml(input.primaryLabel)}</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${primaryUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:260px;border-radius:4px;">${escapeHtml(input.primaryLabel)}</a>
              <!--<![endif]-->
            </td>
          </tr>${secondary}
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e2e8f0;background-color:#fafafa;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">This is an automated notification from T Rock Construction CRM. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Exported alongside `renderBrandedEmail`, and for the same reason — the sweep renders the same table. */
export function renderDetailRows(rows: ReadonlyArray<readonly [string, string]>): string {
  const cells = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:bold;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${cells}
              </table>`;
}

export interface WeeklyReportReminderEmailInput {
  kind: Exclude<WeeklyReportReminderKind, "due_digest">;
  projectName: string;
  projectNumber: string | null;
  clientName: string | null;
  weekOf: string;
  /** null when the T-Rock Cam route is not live yet — see weeklyReportReminderLinks. */
  appUrl: string | null;
  webUrl: string;
}

/**
 * The super/PM nudge. The two kinds share a body and differ only in urgency, because the recipient's job
 * is identical either way — the t−1 mail is the t−2 mail with the polite tense removed.
 */
export function buildWeeklyReportReminderEmail(input: WeeklyReportReminderEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const dueDay = formatDueDay(input.weekOf);
  const isTomorrow = input.kind === "t_minus_1";
  const label = input.projectNumber ? `${input.projectNumber} — ${input.projectName}` : input.projectName;
  const subject = isTomorrow
    ? `Weekly report due tomorrow (${dueDay}): ${label}`
    : `Weekly report due ${dueDay}: ${label}`;
  const preheader = isTomorrow
    ? `This week's report has not been submitted yet. It is due ${dueDay}.`
    : `A heads-up: this week's report is due ${dueDay}.`;

  const rows = [
    ["Project", input.projectName],
    ["Project number", input.projectNumber ?? "—"],
    ["Client", input.clientName ?? "—"],
    ["Week of", dueDay],
  ] as const;

  // WHO THIS GOES TO decides the copy. The recipients are the assigned superintendent and PM, and those
  // are `construction` / `field_contractor` accounts far more often than not — roles that
  // /projects/weekly-reports refuses (the route is admin/director/rep on both the client guard and the
  // server router), and a field_contractor cannot sign into the web app at all.
  //
  // So with the deep link off, leading with a CRM button would hand most recipients a destination that
  // bounces them. The report is written in T-Rock Cam; the email says so in words, and the CRM link is
  // offered as the secondary for whoever does have dashboard access. Once the deep link is enabled the
  // app becomes a real button and this reduces to the obvious thing.
  const writeItHere = input.appUrl
    ? ""
    : `<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#333333;">` +
      `Write it in <strong>T-Rock Cam</strong> on your phone — the <strong>Reports</strong> tab.</p>`;

  const html = renderBrandedEmail({
    title: isTomorrow ? "Weekly report due tomorrow" : "Weekly report due soon",
    preheader,
    bodyHtml: renderDetailRows(rows) + writeItHere,
    primaryLabel: input.appUrl ? "Open in T-Rock Cam" : "Open the weekly reports board",
    primaryUrl: input.appUrl ?? input.webUrl,
    ...(input.appUrl
      ? { secondaryLabel: "Or open the weekly reports board in the CRM", secondaryUrl: input.webUrl }
      : {}),
  });

  const text =
    `${preheader}\n\n` +
    rows.map(([rowLabel, value]) => `${rowLabel}: ${value}`).join("\n") +
    (input.appUrl
      ? `\n\nOpen in T-Rock Cam: ${input.appUrl}\nOr open it in the CRM: ${input.webUrl}`
      : `\n\nWrite it in T-Rock Cam on your phone — the Reports tab.\nCRM dashboard (needs CRM access): ${input.webUrl}`);

  return { subject, html, text };
}

export interface WeeklyReportDigestEntry {
  projectName: string;
  projectNumber: string | null;
  superName: string | null;
  pmName: string | null;
  stateLabel: string;
  /**
   * Whether a reminder for this project could be ADDRESSED to that person AS OF THIS DIGEST — the same
   * predicate `sendProjectReminder` uses to decide whether to send at all.
   *
   * A statement about the NEXT reminder, never about the ones already sent. Reachability is evaluated at
   * digest time and the assignment moves underneath it: a super assigned on Thursday morning is reachable
   * here and was not on Tuesday, and a super who left on Wednesday night is unreachable here having been
   * emailed twice. What actually went out is `remindersSent`.
   */
  superReachable: boolean;
  pmReachable: boolean;
  /**
   * How many t−2 / t−1 reminder CLAIMS `weekly_report_reminders_sent` records for this project's due week.
   *
   * A CLAIM ledger, not a delivery ledger, and the name of this field is the strongest thing the row will
   * support. The row is INSERTed BEFORE the send — that ordering is what stops a restart mid-window
   * double-emailing every superintendent — and the compensating DELETE on a failed send is best-effort:
   * if the rollback itself fails, or the process dies between the INSERT and it, the row outlives a
   * reminder that was never delivered. Rare, but it is a real state and the digest cannot detect it.
   *
   * So NEITHER direction is a delivery fact, and the rendering says only what each one supports:
   *
   *   • ZERO rows means nothing is ON RECORD — which is weaker than "nothing was attempted", and the
   *     wording no longer claims otherwise. A claim is written before EVERY attempt and DELETED again when
   *     the send fails, including on an `unknown` outcome that the rollback's own comment says may well
   *     have been delivered. So a project whose t−2 and t−1 both came back `unknown` on all three ticks of
   *     both days reaches this digest with an empty ledger and up to six emails already in the super's
   *     inbox. Rare — it needs the send to fail after Resend accepted it, repeatedly — but the asymmetry
   *     the old wording rested on ("nothing was claimed, so nothing was even attempted") is simply not
   *     true of a ledger its own writer rolls back. The heading and the note therefore say NO REMINDER IS
   *     ON RECORD, which is exactly the fact in hand, and never that none was sent.
   *   • A NON-ZERO count only attests that the job took the slot and handed the message to the provider.
   *     The digest reports it as reminders LOGGED, never as reminders delivered — see reminderNote. Making
   *     it a delivery assertion would print "1 reminder was sent" to leadership over a nudge that provably
   *     never went out, which is worse than the vaguer word by exactly the amount leadership trusts it.
   *
   * Recording delivery separately would need a `delivered_at` column on a table this PR does not own
   * (0222, already merged), so the wording carries it instead. The ledger still answers "was anybody
   * actually chased about this" far better than the alternative it replaced: the digest used to answer it
   * from current reachability, which is wrong in both directions — silent about a project whose super was
   * assigned after both nudges had already skipped it (leadership told to chase someone who was never
   * emailed), and printing "no reminder was sent" over a project whose super received both and then left.
   */
  remindersSent: number;
}

export interface WeeklyReportDigestBacklogEntry {
  projectName: string;
  outstandingWeeks: number;
  oldestWeekOf: string;
  /** Outstanding weeks older than the lookback window. Counted, never silently dropped. */
  olderOutstandingCount: number;
}

/** Weeks this project owes, in and out of the lookback window. The number leadership acts on. */
function backlogTotal(entry: WeeklyReportDigestBacklogEntry): number {
  return entry.outstandingWeeks + entry.olderOutstandingCount;
}

/**
 * One backlog row, in both renderings. The out-of-window tail is printed rather than dropped so the email
 * cannot imply the backlog stops at the window edge — the same reason the dashboard carries
 * `olderOutstandingCounts`.
 *
 * The row LEADS WITH THE TOTAL. Leading with the in-window count instead rendered "0 weeks (+4 older)"
 * for a project whose recent weeks are all filed and whose old ones are not — which reads as nothing to
 * do, in the row that exists for precisely that project. The parenthetical still says how much of the
 * total the linked board will not render, so the email and the page cannot appear to disagree.
 */
function backlogSummary(entry: WeeklyReportDigestBacklogEntry): string {
  const total = backlogTotal(entry);
  const weeks = `${total} week${total === 1 ? "" : "s"}`;
  const older =
    entry.olderOutstandingCount === 0
      ? ""
      : entry.olderOutstandingCount === total
        ? " (all older than the board shows)"
        : ` (${entry.olderOutstandingCount} older than the board shows)`;
  return `${weeks}${older} · oldest ${formatDueDay(entry.oldestWeekOf)}`;
}

/**
 * The due-day leadership digest.
 *
 * Deliberately reports the state of the cohort due TODAY plus a separate backlog block, rather than one
 * merged list. Merging them answers "how many reports are missing" — which is not actionable — while the
 * split answers "who do I chase this morning" and "which job has quietly stopped reporting", the two
 * questions leadership actually asks.
 */
export function buildWeeklyReportLeadershipDigestEmail(input: {
  dueDate: string;
  filed: WeeklyReportDigestEntry[];
  outstanding: WeeklyReportDigestEntry[];
  /**
   * Weeks consciously written off. Listed WITH the filed ones — a dismissed week is neither filed nor
   * chaseable, and putting it in Outstanding inflates a count nobody can act on — but counted apart from
   * them, because "filed" in the subject is a claim that a report EXISTS. Folding the two together made a
   * cohort of three dismissed weeks read as "3 filed, 0 outstanding" over a body listing three reports
   * that were never written.
   */
  dismissed?: WeeklyReportDigestEntry[] | null;
  backlog: WeeklyReportDigestBacklogEntry[];
  dashboardUrl: string;
  /**
   * Names of the projects that were NOT covered by an earlier digest LOGGED for this same due date. Empty
   * or absent for the day's first digest — see the cohort note in sendLeadershipDigest.
   *
   * "Logged", not "sent", and the copy this drives says so. The caller derives it from `due_digest` claim
   * rows, which are written before the send; a send that failed and could not roll its claims back leaves
   * rows behind with nothing in anybody's inbox.
   */
  followUpForProjects?: string[] | null;
}): { subject: string; html: string; text: string } {
  const dueDay = formatDueDay(input.dueDate);
  const dismissed = input.dismissed ?? [];

  // The backlog belongs in the SUBJECT, not only in the body. Reporting the due-today cohort alone lets
  // leadership receive "2 filed, 0 outstanding / Everything has been filed" above a body listing a job
  // that has not delivered a report since May — and once every project files on time, which is the
  // feature working, that becomes the normal shape of this email. A director triaging on a phone reads
  // the subject and the preheader and stops.
  const backlogWeeks = input.backlog.reduce((total, entry) => total + backlogTotal(entry), 0);
  const backlogClause = input.backlog.length
    ? `${backlogWeeks} week${backlogWeeks === 1 ? "" : "s"} behind on ${input.backlog.length} project${input.backlog.length === 1 ? "" : "s"}`
    : null;
  const followUpProjects = input.followUpForProjects ?? [];
  const isFollowUp = followUpProjects.length > 0;

  // Dismissed weeks get their own clause rather than being absorbed into either count. "0 filed, 0
  // outstanding" with nothing else said would be true and unreadable; "1 filed" would be false.
  const dismissedClause = dismissed.length ? `${dismissed.length} dismissed` : null;

  // A second digest for a cohort that GREW mid-morning re-lists the earlier one's projects, under a
  // subject that otherwise differs only in its counts. Saying which email this is costs two words and is
  // the difference between "here is a revised list" and "the cron sent it twice".
  //
  // "ANOTHER DIGEST", not "Update". The flag behind it is `alreadyDigested`, read off `due_digest` CLAIM
  // rows that are written BEFORE the send and survive a send that failed to roll them back — so the
  // strongest fact available is that an earlier digest was LOGGED, not that leadership received one.
  // "Update — " asserts the recipient is holding the thing being updated, and both paths that reach here
  // with nothing delivered are live: a `rejected` send whose rollback throws (provably nothing went out),
  // and an `unknown` send whose rollback throws (nobody knows). Same correction, and for the same reason,
  // as the "logged" wording in reminderNote.
  const subject =
    `${isFollowUp ? "Another digest — " : ""}Weekly reports due ${dueDay} — ` +
    `${input.filed.length} filed, ${input.outstanding.length} outstanding` +
    (dismissedClause ? `, ${dismissedClause}` : "") +
    (backlogClause ? `, ${backlogClause}` : "");
  const dueTotal = input.filed.length + dismissed.length + input.outstanding.length;
  const duePreheader =
    input.outstanding.length === 0
      ? dismissed.length === 0
        ? `Everything due ${dueDay} has been filed.`
        : // "Everything has been filed" over a cohort of write-offs is the same lie the subject used to
          // tell, one line further down. Name both numbers.
          `Nothing due ${dueDay} is outstanding: ${input.filed.length} filed, ${dismissed.length} dismissed.`
      : `${input.outstanding.length} of ${dueTotal} reports due ${dueDay} are still outstanding` +
        (dismissedClause ? `, ${dismissedClause}` : "") +
        `.`;
  const preheader = backlogClause ? `${duePreheader} Earlier weeks: ${backlogClause}.` : duePreheader;

  // Same correction as the subject prefix, in the one place a reader will actually stop and read it. The
  // sentence used to open "This updates the digest sent earlier today", which claims a delivery the ledger
  // cannot support — and reads at its most confident in exactly the case where nothing went out at all.
  // What is true: an earlier digest was logged, these projects were not in it, and this email is complete
  // on its own, so a recipient holding nothing else has lost nothing.
  const followUpLine = isFollowUp
    ? `An earlier digest for ${dueDay} was already logged today — ${listNames(followUpProjects)} became due after it. ` +
      `Everything due ${dueDay} is listed below, so this email stands on its own whether or not that earlier one reached you.`
    : null;
  const followUpHtml = followUpLine
    ? `
              <p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#64748b;">${escapeHtml(followUpLine)}</p>`
    : "";

  // `flagUnreachable` is set for Outstanding only. On a filed week nobody is being chased, so who could
  // or could not have been emailed is noise; on an outstanding one it is the difference between a person
  // who ignored two reminders and a project the job has never been able to notify at all.
  //
  // The heading's count comes from the LEDGER (`remindersSent === 0`), not from reachability. "Nobody to
  // remind" described the present and was printed as a claim about the past — see reminderNote. It is
  // phrased at the strength the ledger supports, ON RECORD rather than "never reminded", for the same
  // reason the note under it is: the claim behind that zero is rolled back on every failed send, so an
  // empty ledger is an absence of evidence and not evidence of absence.
  const section = (
    heading: string,
    entries: WeeklyReportDigestEntry[],
    emptyNote: string,
    flagUnreachable = false,
  ) => {
    const noReminderOnRecord = flagUnreachable
      ? entries.filter((entry) => entry.remindersSent === 0).length
      : 0;
    const fullHeading =
      noReminderOnRecord > 0 ? `${heading} — ${noReminderOnRecord} with no reminder on record` : heading;
    const items = entries.length
      ? entries
          .map((entry) => {
            const name = entry.projectNumber ? `${entry.projectNumber} — ${entry.projectName}` : entry.projectName;
            const people = [
              personLabel("Super", entry.superName, entry.superReachable, flagUnreachable),
              personLabel("PM", entry.pmName, entry.pmReachable, flagUnreachable),
            ].join(" · ");
            const noteText = flagUnreachable ? reminderNote(entry) : null;
            const note = noteText
              ? `
                    <div style="font-size:12px;line-height:18px;color:#CC0000;">${escapeHtml(noteText)}</div>`
              : "";
            return `
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;vertical-align:top;">
                    <div style="font-size:14px;line-height:20px;color:#111111;font-weight:bold;">${escapeHtml(name)}</div>
                    <div style="font-size:12px;line-height:18px;color:#64748b;">${escapeHtml(people)}</div>${note}
                  </td>
                  <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#111111;text-align:right;vertical-align:top;white-space:nowrap;">${escapeHtml(entry.stateLabel)}</td>
                </tr>`;
          })
          .join("")
      : `
                <tr>
                  <td colspan="2" style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#64748b;">${escapeHtml(emptyNote)}</td>
                </tr>`;
    return `
              <h2 style="margin:20px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#111111;">${escapeHtml(fullHeading)}</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${items}
              </table>`;
  };

  const backlogHtml = input.backlog.length
    ? `
              <h2 style="margin:20px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#111111;">Still outstanding from earlier weeks</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${input.backlog
                .map(
                  (entry) => `
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;vertical-align:top;">${escapeHtml(entry.projectName)}</td>
                  <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#64748b;text-align:right;vertical-align:top;white-space:nowrap;">${escapeHtml(backlogSummary(entry))}</td>
                </tr>`,
                )
                .join("")}
              </table>`
    : "";

  // Dismissed weeks sit in this section, after the filed ones, under a heading that says how many of the
  // rows below are write-offs rather than reports. Same placement as before, without the same claim.
  const accountedFor = [...input.filed, ...dismissed];
  const filedHeading = dismissed.length
    ? `Filed — ${dismissed.length} dismissed, not filed`
    : "Filed";

  const html = renderBrandedEmail({
    // "(another digest today)", not "(update)" — see the subject prefix. The heading is read by someone
    // who may be holding this email and nothing else.
    title: isFollowUp
      ? `Weekly reports due ${dueDay} (another digest today)`
      : `Weekly reports due ${dueDay}`,
    preheader,
    bodyHtml:
      followUpHtml +
      section(filedHeading, accountedFor, "Nothing filed yet.") +
      section("Outstanding", input.outstanding, "Nothing outstanding.", true) +
      backlogHtml,
    primaryLabel: "Open the weekly reports board",
    primaryUrl: input.dashboardUrl,
  });

  const textEntry = (entry: WeeklyReportDigestEntry, flagUnreachable = false) => {
    const name = entry.projectNumber ? `${entry.projectNumber} — ${entry.projectName}` : entry.projectName;
    const people = [
      personLabel("Super", entry.superName, entry.superReachable, flagUnreachable),
      personLabel("PM", entry.pmName, entry.pmReachable, flagUnreachable),
    ].join(", ");
    const noteText = flagUnreachable ? reminderNote(entry) : null;
    const note = noteText ? `\n      ${noteText}` : "";
    return `  - ${name} (${entry.stateLabel}) — ${people}${note}`;
  };
  const outstandingNoReminderOnRecord = input.outstanding.filter((entry) => entry.remindersSent === 0).length;
  const text =
    (followUpLine ? `${followUpLine}\n\n` : "") +
    `${preheader}\n\n` +
    `Filed (${input.filed.length}${dismissed.length ? `, plus ${dismissed.length} dismissed` : ""}):\n` +
    `${accountedFor.map((entry) => textEntry(entry)).join("\n") || "  - none"}\n\n` +
    `Outstanding (${input.outstanding.length}${outstandingNoReminderOnRecord > 0 ? `, ${outstandingNoReminderOnRecord} with no reminder on record` : ""}):\n` +
    `${input.outstanding.map((entry) => textEntry(entry, true)).join("\n") || "  - none"}\n` +
    (input.backlog.length
      ? `\nStill outstanding from earlier weeks:\n${input.backlog
          .map((entry) => `  - ${entry.projectName}: ${backlogSummary(entry)}`)
          .join("\n")}\n`
      : "") +
    `\nOpen the weekly reports board: ${input.dashboardUrl}`;

  return { subject, html, text };
}

/**
 * What this digest can honestly say about one outstanding project's reminders. Same words in HTML and text.
 *
 * TWO facts, and the note used to collapse them into one sentence drawn from the wrong one. The LEDGER
 * (`remindersSent`) is the record of what the job CLAIMED — past tense, and the strongest past-tense claim
 * available; see the field's own doc for why it is not a delivery record. Reachability is evaluated NOW
 * and predicts only whether the next reminder can land. Deriving "no reminder was sent" from reachability
 * was wrong in both directions:
 *
 *   • a project created without a super, assigned one on the due-date morning, was reachable here and had
 *     been skipped by both nudges — printed as ordinary Outstanding, so leadership chased a person who was
 *     never emailed. That is the common setup pattern, and it is the case the note exists to catch.
 *   • a super who received both nudges and was deactivated on Wednesday night was unreachable here —
 *     printed as "no reminder was sent" over two emails that had in fact been delivered.
 *
 * So the past comes from the ledger and the future from reachability, and neither sentence claims the other.
 *
 * NEITHER sentence is a delivery claim, because no row here can carry one in either direction. A PRESENT
 * row only proves the job took the slot, so the non-zero case says LOGGED, not sent — a reminder whose
 * claim survived a failed rollback never reached anyone, and "1 reminder was sent" over that tells
 * leadership a superintendent ignored a nudge he was never sent. An ABSENT row is no stronger: the claim
 * is deleted again whenever the send fails, `unknown` included, so the zero case says NO REMINDER IS ON
 * RECORD rather than "none was sent" — see the field's own doc for the run of failures that produces an
 * empty ledger over a full inbox.
 */
function reminderNote(entry: WeeklyReportDigestEntry): string | null {
  const reachable = isRemindable(entry);
  if (entry.remindersSent === 0) {
    return reachable
      ? "No reminder is on record for this week."
      : "No reminder is on record for this week — and with no reachable super or PM email, none can be sent now either.";
  }
  if (!reachable) {
    return `${entry.remindersSent} reminder${entry.remindersSent === 1 ? " was" : "s were"} logged for this week, but there is no reachable super or PM email now.`;
  }
  return null;
}

/** Could the NEXT t−2 / t−1 reminder for this project be addressed to anybody at all? */
function isRemindable(entry: WeeklyReportDigestEntry): boolean {
  return entry.superReachable || entry.pmReachable;
}

/**
 * "Super: Steve Sanchez", "PM: unassigned", or — when the section is assigning accountability and the
 * address is undeliverable — "Super: Gone Fishing (unreachable)". A deactivated account keeps its
 * display name, so without the tail the digest reads as though that person is still on the hook.
 */
function personLabel(
  role: string,
  name: string | null,
  reachable: boolean,
  annotate: boolean,
): string {
  if (name == null) return `${role}: unassigned`;
  return annotate && !reachable ? `${role}: ${name} (unreachable)` : `${role}: ${name}`;
}

/** "A", "A and B", "A, B and C" — for naming the projects a follow-up digest adds. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

/** A minimal query shape so the job is injectable in tests (pool.query, a PGlite query, or a mock all fit). */
type PgQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/**
 * The transport, injectable so the suite can drive it.
 *
 * Deliberately typed as the FULL `SendSystemEmailResult`, `outcome` included, rather than a convenient
 * `{success}` subset: a stub that cannot express "the provider answered and we still do not know whether
 * it delivered" cannot exercise the branch that decides whether leadership gets a second copy — which is
 * exactly how a fix for that branch came to look verified while the bug stayed live.
 */
type SendEmail = (
  to: string | string[],
  subject: string,
  html: string,
  options: { text: string; idempotencyKey: string },
) => Promise<SendSystemEmailResult>;

export interface WeeklyReportReminderRunDeps {
  query?: PgQuery;
  sendEmail?: SendEmail;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** The reference instant; "today" is its America/Chicago calendar day. Injected so tests can pin it. */
  now?: Date;
  /**
   * Single-flight guard: resolves to a release fn if this run acquired the lock, or null if another run
   * holds it. Default = a Postgres session advisory lock, which is global across worker replicas.
   */
  acquireLock?: () => Promise<null | (() => Promise<void>)>;
}

export interface WeeklyReportReminderRunSummary {
  offices: number;
  tMinus2Sent: number;
  tMinus1Sent: number;
  /** t−1 reminders deliberately withheld because the week was already filed, or was dismissed. */
  tMinus1Suppressed: number;
  digestsSent: number;
  /** Reminders that were due but could not be addressed (no active super/PM email, empty digest roster). */
  skipped: number;
  failed: number;
}

interface ProjectRow {
  id: string;
  officeId: string | null;
  projectName: string;
  projectNumber: string | null;
  clientName: string | null;
  cadenceWeekday: number;
  cadenceStartDate: string;
  cadenceEndDate: string | null;
  /** Stretches this project was not reporting for. Excluded from every cadence regeneration. */
  pausedIntervals: WeeklyReportPauseInterval[] | null;
  superName: string | null;
  superEmail: string | null;
  pmName: string | null;
  pmEmail: string | null;
  /** This week's cadence due date, or null when the project has no expected week around today. */
  dueDate: string | null;
}

export async function runWeeklyReportReminders(
  deps: WeeklyReportReminderRunDeps = {},
): Promise<WeeklyReportReminderRunSummary> {
  const logger = deps.logger ?? console;
  const query = deps.query ?? (pool.query.bind(pool) as PgQuery);
  const env = deps.env ?? process.env;
  const today = businessCalendarDay(deps.now ?? new Date());
  const frontendUrl = resolveFrontendUrl(env);
  const appDeepLinksEnabled = weeklyReportAppDeepLinksEnabled(env);
  const summary: WeeklyReportReminderRunSummary = {
    offices: 0,
    tMinus2Sent: 0,
    tMinus1Sent: 0,
    tMinus1Suppressed: 0,
    digestsSent: 0,
    skipped: 0,
    failed: 0,
  };

  const acquireLock = deps.acquireLock ?? acquireReminderAdvisoryLock;
  const releaseLock = await acquireLock();
  if (!releaseLock) {
    logger.log("[WeeklyReportReminders] Another run holds the lock - skipping this tick");
    return summary;
  }

  try {
    const offices = await query(`SELECT id, slug, name FROM public.offices WHERE is_active = true ORDER BY slug`);
    for (const office of offices.rows) {
      const tenantSchema = `office_${String(office.slug ?? "")}`;
      // Guarded with the same helper the other email jobs use, because `tenantSchema` is interpolated
      // straight into every query below — identifiers cannot be $-parametrized.
      if (!isSafeTenantSchema(tenantSchema)) {
        logger.error(`[WeeklyReportReminders] Invalid office slug "${office.slug}" - skipping`);
        continue;
      }

      // Migrations run on the API's boot, NOT the worker's. Between a worker deploy and the API applying
      // 0222 — or in any office the migration skipped for want of `deals`/`files` — these tables do not
      // exist, and an unguarded query would throw 42P01 for every office on every tick.
      //
      // EVERY table the run touches is probed, not just the first one. The guard used to check
      // `weekly_report_projects` alone while the run also reads `weekly_report_pauses`, which arrives in a
      // SEPARATE migration (0223): an office that had 0222 and not 0223 — a branch database, a restore, a
      // 0223 that errored partway — sailed past the guard and then threw 42P01 out of processOffice. That
      // is caught one level up, so the office silently lost its t−2, its t−1 AND its digest for the tick,
      // visible only as a single logger.error. The tables are cheap to probe and the failure is not.
      //
      // The probe is GUARDED SEPARATELY, and not merely because a query can fail: it is the one per-office
      // statement that ran outside processOffice's try, so a pool-acquisition timeout on office 1 — the
      // known saturation failure mode, `connectionTimeoutMillis: 10000` in db.ts — threw straight out of
      // the run and offices 2..N never executed. Exactly the silent whole-office loss this probe was added
      // to prevent, one level further out. Its own catch also keeps a FAILED probe distinguishable in the
      // logs from tables that are legitimately absent: an office skipped for want of 0223 is routine and
      // logs at INFO; a probe that threw means the office's state is unknown and logs at ERROR.
      let missing: string[];
      try {
        const present = await query(
          `SELECT t.qualified, to_regclass(t.qualified) AS reg FROM UNNEST($1::text[]) AS t(qualified)`,
          [REQUIRED_TENANT_TABLES.map((table) => `${tenantSchema}.${table}`)],
        );
        missing = present.rows.filter((row) => row.reg == null).map((row) => String(row.qualified));
      } catch (err) {
        logger.error("[WeeklyReportReminders] Weekly-report table probe failed - skipping office", {
          tenantSchema,
          err,
        });
        summary.failed += 1;
        continue;
      }
      if (missing.length > 0) {
        logger.log("[WeeklyReportReminders] Weekly-report tables not present - skipping office", {
          tenantSchema,
          missing,
        });
        continue;
      }

      summary.offices += 1;
      try {
        await processOffice({
          query,
          sendEmail: deps.sendEmail ?? sendSystemEmailWithMetadata,
          logger,
          summary,
          tenantSchema,
          officeId: (office.id as string | null) ?? null,
          today,
          frontendUrl,
          appDeepLinksEnabled,
        });
      } catch (err) {
        // One broken office must not stop the rest. Whatever it did not claim is retried by the day's
        // catch-up ticks, not by tomorrow's run — by then the due date has moved buckets.
        logger.error("[WeeklyReportReminders] Office run failed", { tenantSchema, err });
        summary.failed += 1;
      }
    }
  } finally {
    await releaseLock().catch(() => undefined);
  }

  logger.log("[WeeklyReportReminders] Run complete", summary);
  return summary;
}

interface OfficeRunArgs {
  query: PgQuery;
  sendEmail: SendEmail;
  logger: Pick<Console, "log" | "warn" | "error">;
  summary: WeeklyReportReminderRunSummary;
  tenantSchema: string;
  officeId: string | null;
  today: string;
  frontendUrl: string;
  appDeepLinksEnabled: boolean;
}

async function processOffice(args: OfficeRunArgs): Promise<void> {
  const { query, summary, tenantSchema, officeId, today, frontendUrl } = args;

  // The SAME project predicate the CRM dashboard uses (`is_active AND status = 'active'`, joined to the
  // deal). A reminder for a project the board does not list, or silence for one it does, is drift.
  const projectsResult = await query(
    `SELECT wrp.id, wrp.property_display_name, wrp.client_name,
            wrp.cadence_weekday, wrp.cadence_start_date, wrp.cadence_end_date,
            d.name AS deal_name, d.project_number,
            sup.display_name AS super_name, sup.email AS super_email, sup.is_active AS super_is_active,
            pm.display_name  AS pm_name,    pm.email    AS pm_email,    pm.is_active    AS pm_is_active
       FROM ${tenantSchema}.weekly_report_projects wrp
       JOIN ${tenantSchema}.deals d ON d.id = wrp.deal_id
       LEFT JOIN public.users sup ON sup.id = wrp.trock_super_user_id
       LEFT JOIN public.users pm  ON pm.id  = wrp.trock_pm_user_id
      WHERE wrp.is_active AND wrp.status = 'active'`,
  );
  if (projectsResult.rows.length === 0) return;

  // The pause ledger (0223), loaded exactly as dashboard-service does. Every project here is
  // `status = 'active'`, so nothing is paused right now — these are the stretches it was stopped for and
  // has since come back from. Without them a project paused for six weeks returns with six never-owed
  // reports in the leadership digest, contradicting the board those same recipients click through to.
  const pausesResult = await query(
    `SELECT weekly_report_project_id, paused_from, resumed_on
       FROM ${tenantSchema}.weekly_report_pauses
      ORDER BY weekly_report_project_id, paused_from`,
  );
  const pausesByProject = new Map<string, WeeklyReportPauseInterval[]>();
  for (const row of pausesResult.rows) {
    const key = String(row.weekly_report_project_id);
    const intervals = pausesByProject.get(key) ?? [];
    intervals.push({ from: toIsoDate(row.paused_from)!, to: toIsoDate(row.resumed_on) });
    pausesByProject.set(key, intervals);
  }

  const projects: ProjectRow[] = projectsResult.rows.map((row) => {
    const cadenceWeekday = Number(row.cadence_weekday);
    const cadenceStartDate = toIsoDate(row.cadence_start_date)!;
    const cadenceEndDate = toIsoDate(row.cadence_end_date);
    const candidate = weeklyReportWeekOf(cadenceWeekday, today);
    // A candidate due date is only real if the cadence actually expects that week — before the start
    // date, or after `cadence_end_date`, `weeklyReportWeekOf` still returns the next matching weekday.
    // Asking the shared generator (rather than re-deriving the bounds here) is what keeps the reminder
    // and the dashboard agreeing about which weeks exist.
    const pausedIntervals = pausesByProject.get(String(row.id)) ?? null;
    const expected = weeklyReportExpectedWeeks({
      cadenceWeekday,
      cadenceStartDate,
      cadenceEndDate,
      throughDate: candidate,
      pausedIntervals,
    });
    return {
      id: String(row.id),
      officeId,
      projectName: normalizeText(row.property_display_name) ?? normalizeText(row.deal_name) ?? "Project",
      projectNumber: normalizeText(row.project_number),
      clientName: normalizeText(row.client_name),
      cadenceWeekday,
      cadenceStartDate,
      cadenceEndDate,
      pausedIntervals,
      superName: normalizeText(row.super_name),
      superEmail: row.super_is_active === false ? null : normalizeText(row.super_email),
      pmName: normalizeText(row.pm_name),
      pmEmail: row.pm_is_active === false ? null : normalizeText(row.pm_email),
      dueDate: expected[expected.length - 1] === candidate ? candidate : null,
    };
  });

  const withDue = projects.filter((project): project is ProjectRow & { dueDate: string } => project.dueDate != null);
  const byLead = new Map<WeeklyReportReminderKind, Array<ProjectRow & { dueDate: string }>>();
  for (const project of withDue) {
    const kind = reminderKindForLeadDays(daysBetweenIsoDates(today, project.dueDate));
    if (!kind) continue;
    const bucket = byLead.get(kind) ?? [];
    bucket.push(project);
    byLead.set(kind, bucket);
  }

  const tMinus2 = byLead.get("t_minus_2") ?? [];
  const tMinus1 = byLead.get("t_minus_1") ?? [];
  const dueToday = byLead.get("due_digest") ?? [];
  if (tMinus2.length === 0 && tMinus1.length === 0 && dueToday.length === 0) return;

  // Live report + dismissal state, read ONCE per office. Only fetched when something actually needs it:
  // the t−2 heads-up is unconditional, so a day with only t−2 work touches neither table.
  //
  // Unfiltered by week, exactly as the dashboard reads it. A `week_of >=` bound would look like a cheap
  // optimisation and would silently break the backlog's "+N older" count, which by definition needs the
  // weeks outside the window.
  const needsState = tMinus1.length > 0 || dueToday.length > 0;
  const projectIds = projects.map((project) => project.id);
  const statusByWeek = new Map<string, string>();
  const filedWeeks = new Set<string>();
  const deliveredWeeks = new Set<string>();
  const dismissedWeeks = new Set<string>();
  if (needsState) {
    // DISTINCT ON …, version DESC mirrors the dashboard: only the LIVE version of a week decides its
    // state. A superseded report keeps its row for history but must not make a corrected week look filed.
    const reportsResult = await query(
      `SELECT DISTINCT ON (weekly_report_project_id, week_of)
              weekly_report_project_id, week_of, status
         FROM ${tenantSchema}.weekly_reports
        WHERE weekly_report_project_id = ANY($1::uuid[])
          AND is_active
          AND superseded_by_id IS NULL
        ORDER BY weekly_report_project_id, week_of, version DESC`,
      [projectIds],
    );
    for (const row of reportsResult.rows) {
      const key = `${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`;
      const status = String(row.status);
      statusByWeek.set(key, status);
      if (FILED_REPORT_STATUSES.has(status)) filedWeeks.add(key);
      if (DELIVERED_REPORT_STATUSES.has(status)) deliveredWeeks.add(key);
    }
    const dismissalsResult = await query(
      `SELECT weekly_report_project_id, week_of
         FROM ${tenantSchema}.weekly_report_dismissals
        WHERE weekly_report_project_id = ANY($1::uuid[])`,
      [projectIds],
    );
    for (const row of dismissalsResult.rows) {
      dismissedWeeks.add(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`);
    }
  }

  // Each send is isolated. An error reaching ONE project — a rejected claim, an unreachable row — must
  // not take down the rest of the office's reminders or, worse, its leadership digest; there is no
  // per-project retry beyond the day's catch-up ticks, so a shared failure is a silent week.
  for (const project of tMinus2) {
    await guarded(args, `t_minus_2 ${project.id}`, () => sendProjectReminder(args, project, "t_minus_2"));
  }

  for (const project of tMinus1) {
    const weekKey = `${project.id}|${project.dueDate}`;
    // FILED or DISMISSED. Silence is the feature: a super who filed on time is not chased, so a reminder
    // that DOES arrive is always genuine — and no ledger row is written, because nothing was sent and the
    // ledger is a record of deliveries, not of decisions.
    //
    // A DISMISSED week is the same case reached from the other side. Somebody with the board open decided
    // this week is not owed, and the digest tomorrow morning will print it under Filed and call it
    // "neither filed nor chaseable" — while this loop was still emailing the super tonight that "this
    // week's report has not been submitted yet". One of the two is wrong about the same week on the same
    // day, and it is not the digest: chasing a report the office has written off is how a reminder stops
    // meaning anything.
    //
    // `dismissedWeeks` is already loaded whenever this loop can run at all (`needsState`), so this costs
    // no extra read.
    //
    // Reachable today because the server's own guard is thin: dismissWeeklyReportWeek rejects
    // `weekOf > asOf` (server/src/modules/weekly-reports/dashboard-service.ts), but `asOf` is
    // client-supplied and validated only as a well-formed date (`asOfFrom` in that module's routes.ts),
    // never against the clock — so tomorrow's week can be dismissed today. That hole is PRE-EXISTING and
    // is deliberately NOT fixed here; the worker must not be inconsistent with itself regardless of how
    // the row got there, and a dismissal can equally arrive from a backfill or a repaired cadence.
    if (filedWeeks.has(weekKey) || dismissedWeeks.has(weekKey)) {
      summary.tMinus1Suppressed += 1;
      continue;
    }
    await guarded(args, `t_minus_1 ${project.id}`, () => sendProjectReminder(args, project, "t_minus_1"));
  }

  if (dueToday.length > 0) {
    await guarded(args, "due_digest", () =>
      sendLeadershipDigest(args, {
        dueToday,
        allProjects: projects,
        statusByWeek,
        filedWeeks,
        deliveredWeeks,
        dismissedWeeks,
        frontendUrl,
        officeId,
        today,
      }),
    );
  }
}

/** Run one send in isolation: a throw is recorded and the office's remaining work continues. */
async function guarded(args: OfficeRunArgs, label: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    args.logger.error("[WeeklyReportReminders] Send unit failed", {
      tenantSchema: args.tenantSchema,
      label,
      err,
    });
    args.summary.failed += 1;
  }
}

async function sendProjectReminder(
  args: OfficeRunArgs,
  project: ProjectRow & { dueDate: string },
  kind: Exclude<WeeklyReportReminderKind, "due_digest">,
): Promise<void> {
  const { query, sendEmail, logger, summary, tenantSchema, officeId, frontendUrl, appDeepLinksEnabled } = args;

  const recipients = reminderRecipients(project);
  if (recipients.length === 0) {
    // Nothing to claim: leaving the ledger untouched means assigning a super later today still gets them
    // a reminder, instead of the slot being permanently burned by a run that emailed nobody.
    logger.warn("[WeeklyReportReminders] No deliverable super/PM email - skipping reminder", {
      tenantSchema,
      weeklyReportProjectId: project.id,
      kind,
    });
    summary.skipped += 1;
    return;
  }

  const links = weeklyReportReminderLinks({
    frontendUrl,
    officeId,
    weeklyReportProjectId: project.id,
    weekOf: project.dueDate,
    appDeepLinksEnabled,
  });
  const email = buildWeeklyReportReminderEmail({
    kind,
    projectName: project.projectName,
    projectNumber: project.projectNumber,
    clientName: project.clientName,
    weekOf: project.dueDate,
    appUrl: links.appUrl,
    webUrl: links.webUrl,
  });

  // Claim LAST — everything that can throw happens above it. The claim must sit before the send (that
  // ordering is what stops a restart mid-window double-emailing), but anything between the two is a
  // window in which a throw burns the slot: `guarded` swallows it, the ledger row stays, and the day's
  // catch-up ticks find the reminder already "sent". Building first costs nothing when the claim then
  // loses, and removes the window entirely.
  const claimed = await claimReminder(query, tenantSchema, project.id, project.dueDate, kind);
  if (!claimed) return;

  try {
    const result = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `weekly-report-reminder-${tenantSchema}-${project.id}-${project.dueDate}-${kind}`,
    });
    if (!result.success) throw new Error("Email provider returned unsuccessful result");
    if (kind === "t_minus_2") summary.tMinus2Sent += 1;
    else summary.tMinus1Sent += 1;
  } catch (err) {
    // Release the claim so a CATCH-UP TICK can retry (see the cron registration: 07:00 plus 09:00 and
    // 11:00 CT). Those exist precisely for this path — the following DAY's tick is no retry at all,
    // because by then the due date has moved into a different bucket and this reminder is simply never
    // sent. The claim is taken BEFORE the send so a concurrent run or a restart mid-window cannot
    // double-email; the cost of that ordering is this rollback, and a crash between the two leaves the
    // slot claimed, erring toward one missed nudge rather than a second copy of every reminder.
    //
    // Released on an UNKNOWN outcome too: this key is fixed by (project, week, kind), so if the send
    // really was accepted before the socket died, the catch-up re-send presents the SAME key with the SAME
    // payload and Resend dedups it. Nothing can rotate it, so a retry cannot produce a second copy. The
    // digest releases on `unknown` for the same reason, with the one caveat that its key tracks the due
    // cohort rather than a single project — see the outcome handling in sendLeadershipDigest.
    //
    // A rollback that itself FAILS is logged as such. The row then outlives a reminder that may never have
    // gone out, and the digest reads that row — so an operator must not be told the slot was freed when it
    // was not. See WeeklyReportDigestEntry.remindersSent for what the digest is allowed to say about it.
    let released = true;
    try {
      await releaseReminderClaim(query, tenantSchema, project.id, project.dueDate, kind);
    } catch {
      released = false;
    }
    logger.error(
      released
        ? "[WeeklyReportReminders] Reminder send failed - claim released for retry"
        : "[WeeklyReportReminders] Reminder send failed AND the claim rollback FAILED - the slot stays claimed, so no catch-up tick will retry it",
      {
        tenantSchema,
        weeklyReportProjectId: project.id,
        kind,
        err,
      },
    );
    summary.failed += 1;
  }
}

async function sendLeadershipDigest(
  args: OfficeRunArgs,
  input: {
    dueToday: Array<ProjectRow & { dueDate: string }>;
    allProjects: ProjectRow[];
    statusByWeek: Map<string, string>;
    filedWeeks: Set<string>;
    deliveredWeeks: Set<string>;
    dismissedWeeks: Set<string>;
    frontendUrl: string;
    officeId: string | null;
    today: string;
  },
): Promise<void> {
  const { query, sendEmail, logger, summary, tenantSchema } = args;

  const settings = await query(
    `SELECT leadership_recipient_emails FROM ${tenantSchema}.weekly_report_settings LIMIT 1`,
  );
  const recipients = dedupeEmails(
    (Array.isArray(settings.rows[0]?.leadership_recipient_emails)
      ? (settings.rows[0].leadership_recipient_emails as unknown[])
      : []
    )
      .map((value) => normalizeText(value))
      .filter((email): email is string => email != null && isBasicValidEmail(email)),
  );
  if (recipients.length === 0) {
    // No roster configured yet. Claiming nothing keeps the digest live for the moment somebody fills the
    // list in — the alternative burns the day's slot on an email that was never addressed to anyone.
    //
    // WARN, not log: `leadership_recipient_emails` defaults to '{}', so this is the state of a freshly
    // migrated office, and it means the entire leadership half of the feature is doing nothing. At INFO
    // that is indistinguishable from routine chatter — the reminder side's equivalent path warns for the
    // same reason.
    logger.warn("[WeeklyReportReminders] No leadership recipients configured - no digest", { tenantSchema });
    summary.skipped += 1;
    return;
  }

  // The ledger is keyed per PROJECT, so an office-wide digest claims one row per project it covers. A
  // re-run finds every row present and sends nothing; a project whose cadence starts covering today
  // AFTER the digest went out claims its own row and triggers a fresh digest, which is the right answer —
  // it was never in the first one.
  //
  // (An office running two different cadence weekdays therefore gets one digest per due-date COHORT, not
  // one per week. That follows from cadence being per project; each digest is about the reports due that
  // day, and merging cohorts would mean reporting a Monday project as outstanding on a Thursday.)
  //
  // Read before claiming. The claim has to be the last thing before the send, so what the email needs to
  // KNOW — which of today's projects an earlier tick already reported on, and which of them anybody was
  // actually reminded about — is a separate read. It is advisory only: the claim below is what actually
  // decides whether this run sends, so a concurrent run cannot turn this read into a double send. (The
  // advisory lock makes concurrency impossible anyway.)
  //
  // ALL kinds, not just `due_digest`. The t−2/t−1 rows for this same week are the only record of who was
  // genuinely chased, and the digest asserts that in print — see reminderNote.
  const dueTodayIds = input.dueToday.map((project) => project.id);
  const ledger = await reminderLedgerByProject(query, tenantSchema, dueTodayIds, input.today);
  const alreadyDigested = new Set(
    [...ledger].filter(([, kinds]) => kinds.has("due_digest")).map(([projectId]) => projectId),
  );
  const newlyDue = dueTodayIds.filter((id) => !alreadyDigested.has(id));
  if (newlyDue.length === 0) return;

  const filed: WeeklyReportDigestEntry[] = [];
  const dismissed: WeeklyReportDigestEntry[] = [];
  const outstanding: WeeklyReportDigestEntry[] = [];
  for (const project of input.dueToday) {
    const key = `${project.id}|${project.dueDate}`;
    const state = weekStateFor({
      status: input.statusByWeek.get(key) ?? null,
      isDismissed: input.dismissedWeeks.has(key),
    });
    const kinds = ledger.get(project.id);
    const entry: WeeklyReportDigestEntry = {
      projectName: project.projectName,
      projectNumber: project.projectNumber,
      superName: project.superName,
      pmName: project.pmName,
      stateLabel: weeklyReportWeekStateLabel(state),
      // Reachability, not merely assignment: `superEmail`/`pmEmail` are already nulled for deactivated
      // accounts upstream, and this is the same predicate sendProjectReminder addresses its mail with.
      // It describes THIS MOMENT, so it answers only "can the next reminder land".
      superReachable: isDeliverableEmail(project.superEmail),
      pmReachable: isDeliverableEmail(project.pmEmail),
      // ...and what the job already attempted comes from the CLAIM ledger (see the field's doc for the
      // difference, and for why the note it feeds says "logged" rather than "sent").
      //
      // CHASE kinds only. `due_digest` is this project's own receipt for the email being composed right
      // now — counting it would make every project on a FOLLOW-UP digest look chased, which silences the
      // "with no reminder on record" heading and the note beneath it for exactly the never-chased project
      // they exist to surface.
      remindersSent: CHASE_REMINDER_KINDS.filter((kind) => kinds?.has(kind)).length,
    };
    // A dismissed week is neither filed nor chaseable — it was consciously written off — so it is listed
    // in the Filed section with its own label rather than inflating an outstanding count nobody can act
    // on. It is COUNTED separately, because "filed" in the subject means a report exists.
    if (state === "dismissed") dismissed.push(entry);
    else if (input.filedWeeks.has(key)) filed.push(entry);
    else outstanding.push(entry);
  }

  const backlog = buildBacklog(input.allProjects, input.today, input.deliveredWeeks, input.dismissedWeeks);
  const email = buildWeeklyReportLeadershipDigestEmail({
    dueDate: input.today,
    filed,
    outstanding,
    dismissed,
    backlog,
    dashboardUrl: weeklyReportDashboardUrl(input.frontendUrl, input.officeId),
    followUpForProjects:
      alreadyDigested.size > 0
        ? input.dueToday
            .filter((project) => !alreadyDigested.has(project.id))
            .map((project) => project.projectName)
        : null,
  });

  // Claimed only now that the email exists. The filed/outstanding split, buildBacklog — which walks EVERY
  // active project in the office, not just today's cohort — and the render all used to run between the
  // claim and the send: a throw anywhere in there is swallowed by `guarded`, the claims stay, and the
  // 09:00 and 11:00 catch-up ticks find the day already digested. No email, no retry, and a ledger
  // recording a send that never happened.
  const claimed = await claimDigest(query, tenantSchema, newlyDue, input.today);
  if (claimed.length === 0) return;

  // What we LEARNED about the send, which is not the same question as whether it succeeded. See
  // SendSystemEmailOutcome: a socket hang-up, a gateway timeout and a 409 "still in flight" are all
  // `unknown` — the digest may already be in leadership's inbox — while a validation error is `rejected`
  // and provably created nothing.
  let outcome: SendSystemEmailOutcome;
  let sendError: unknown = null;
  try {
    const result = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      // Scoped to the COVERED SET, not just the day. A day-stable key looks right and is a trap: when a
      // newly-due project triggers a second digest, that email's subject counts and project list differ,
      // so Resend answers the reused key with `invalid_idempotent_request` — which sendSystemEmailWithMetadata
      // deliberately treats as already-delivered. The run would stamp `digestsSent`, keep the claims, and
      // deliver nothing. Hashing the projects covered rotates the key exactly when the payload changes,
      // while a true duplicate (same cohort, same day) still dedups.
      //
      // That dedup is now LOAD-BEARING, not merely tidy: it is what makes a catch-up tick's re-send of an
      // ambiguous digest safe, and therefore what lets an `unknown` outcome release its claims instead of
      // costing leadership the day's digest. `input.dueToday` — not `newlyDue` — is what is hashed, so the
      // key is stable for a stable cohort across all three of the day's ticks.
      idempotencyKey: `weekly-report-digest-${tenantSchema}-${input.today}-${digestCohortKey(input.dueToday.map((project) => project.id))}`,
    });
    outcome = result.outcome;
  } catch (err) {
    // Defence in depth, and NOT the transport's failure path. `sendSystemEmailWithMetadata` does not throw
    // for any provider or network failure — resend@6 catches its own `fetch` and returns an error result —
    // so nothing here fires on a socket timeout. What can still reach it is an injected transport in a
    // test, or a programming error in the send path. Either way we learned nothing about delivery, so it
    // classifies with the ambiguous cases rather than being treated as a rejection.
    sendError = err;
    outcome = "unknown";
  }

  if (outcome === "delivered") {
    summary.digestsSent += 1;
    return;
  }

  // NEITHER remaining outcome keeps its claims. `rejected` is provably undelivered; `unknown` may have
  // been delivered, and is released anyway — for the reason set out below, which is the same one the
  // per-project reminder path already gives for its own `unknown` release.
  //
  // WHY `unknown` RELEASES, having previously been kept.
  //
  // The case for keeping it was that releasing "is precisely how leadership gets two unlabelled copies":
  // roll the ledger back, and when a project becomes due later in the morning the next tick's cohort hash
  // rotates so Resend cannot dedup, while the follow-up prefix — gated on that same ledger — disappears
  // with it. The second half of that is true. The first half is not, and it is what the trade was priced
  // on: the idempotency key hashes `dueToday`, the WHOLE due cohort, not the rows this run claimed. So
  // when the cohort grows, the key rotates and a second email goes out WHETHER OR NOT the claims were
  // kept — as the follow-up path immediately above this one exists to do. Keeping them never prevented an
  // email; it only decided whether that email admitted an earlier one had been logged.
  //
  // What keeping them DID prevent is the retry, and the two cases split cleanly:
  //
  //   • COHORT UNCHANGED — overwhelmingly the common shape. The catch-up tick re-sends under the SAME
  //     idempotency key (same schema, same day, same cohort hash). If the first request reached Resend,
  //     Resend answers the repeat from the original — a plain dedup when the payload is identical, and
  //     `invalid_idempotent_request` when a report was filed at 08:00 and the counts moved, which
  //     sendSystemEmailWithMetadata deliberately reads as already-delivered. If it never reached Resend,
  //     the key is unseen and the digest is finally delivered. There is no third answer, so this retry
  //     cannot produce a second copy. It is the same argument, on the same mechanism, that the reminder
  //     rollback makes for `unknown` sends of the t−2/t−1 nudges.
  //   • COHORT GREW — rare, and it needs the ambiguous send AND a project becoming due between two ticks
  //     of one morning. The next tick sends the same email it would have sent anyway; the only thing lost
  //     is the "Another digest — " prefix on it, because the ledger it is read from is now empty.
  //
  // So the price of keeping was an unconditional, silent, unrecoverable loss of the day's digest on the
  // MOST COMMON transport failure there is — a Resend 5xx, a 502/504 from a gateway, a pool blip, all of
  // which classify `unknown` — bought with a label on a rare second email. That is the wrong way round for
  // a digest whose whole purpose is that leadership can trust the number in it, and it contradicted the
  // catch-up ticks' own reason for existing (see the cron registration in worker/src/index.ts).
  //
  // It also fixes what the day looked like from outside: with the claims kept, 09:00 and 11:00 found
  // everything already claimed, sent nothing, logged nothing and returned `{digestsSent: 0, failed: 0}` —
  // a clean run over a digest nobody had. Now every tick re-attempts, so a digest that never lands is
  // reported as a failure with an error line at 07:00, 09:00 AND 11:00 until it does.
  //
  // Release ONLY the rows this run claimed: deleting every due_digest row for the day would also erase an
  // earlier run's successful send and re-digest leadership about projects it already reported on.
  //
  // The rollback's own failure is REPORTED, not swallowed. A DELETE that never lands (the saturated pool
  // this job already guards against elsewhere) leaves the claims standing, which means no catch-up tick
  // will retry — and a log line asserting "claims released for retry" over that is how an operator comes
  // to believe a retry is coming when none is. That is also the one path that still leaves a digest
  // stranded silently, and the only signal it has is this line; it is the reason the follow-up copy may
  // not say a previous digest was SENT.
  let released = true;
  let rollbackError: unknown = null;
  try {
    await releaseDigestClaims(query, tenantSchema, claimed, input.today);
  } catch (err) {
    released = false;
    rollbackError = err;
  }
  const label = outcome === "rejected" ? "REJECTED" : "outcome UNKNOWN";
  logger.error(
    released
      ? `[WeeklyReportReminders] Digest send ${label} - claims released for retry`
      : `[WeeklyReportReminders] Digest send ${label} and the claim rollback FAILED - claims stand, so no catch-up tick will re-send this digest`,
    // `sendError` is null for every provider failure — the transport returns rather than throwing — so it
    // is only carried when something actually threw, which is the case worth seeing a stack for.
    {
      tenantSchema,
      ...(sendError == null ? {} : { err: sendError }),
      ...(released ? {} : { rollbackErr: rollbackError }),
    },
  );
  summary.failed += 1;
}

/** Stable short digest of the project set an email covers, so the idempotency key tracks the payload. */
function digestCohortKey(weeklyReportProjectIds: string[]): string {
  return createHash("sha256").update([...weeklyReportProjectIds].sort().join(",")).digest("hex").slice(0, 16);
}

/**
 * Weeks that are still unfiled and undismissed, older than the current cadence week.
 *
 * Generated from the cadence and left-joined in memory, the same direction the dashboard reads: a week
 * nobody ever started has no `weekly_reports` row, so counting rows would make exactly the projects worth
 * chasing invisible.
 */
export function buildBacklog(
  projects: ProjectRow[],
  today: string,
  deliveredWeeks: Set<string>,
  dismissedWeeks: Set<string>,
): WeeklyReportDigestBacklogEntry[] {
  const entries: WeeklyReportDigestBacklogEntry[] = [];
  for (const project of projects) {
    const currentWeek = weeklyReportWeekOf(project.cadenceWeekday, today);
    const expected = weeklyReportExpectedWeeks({
      cadenceWeekday: project.cadenceWeekday,
      cadenceStartDate: project.cadenceStartDate,
      cadenceEndDate: project.cadenceEndDate,
      throughDate: currentWeek,
      // Same ledger the board uses. A digest that bills a resumed project for its paused weeks tells
      // leadership to chase reports nobody ever owed.
      pausedIntervals: project.pausedIntervals,
    });
    // A COUNT cutoff over the expected weeks, byte-for-byte the dashboard's `expected.length - lookback`.
    // A date range instead would drift a week away from the board at the window edge.
    const cutoffIndex = Math.max(0, expected.length - WEEKLY_REPORT_DIGEST_LOOKBACK_WEEKS);
    const isOutstanding = (weekOf: string) => {
      const key = `${project.id}|${weekOf}`;
      return !deliveredWeeks.has(key) && !dismissedWeeks.has(key);
    };

    // `oldestWeekOf` is tracked across BOTH loops. Assigning it only inside the in-window slice made
    // the digest read "(+5 older) · oldest Thursday, Feb 19" while one of those five older weeks was
    // in fact the oldest — understating the backlog's age to the people whose job is to act on it.
    // `expected` is ascending, so the first outstanding week seen is the earliest.
    let oldestWeekOf: string | null = null;
    const noteOldest = (weekOf: string) => {
      if (oldestWeekOf == null) oldestWeekOf = weekOf;
    };

    let olderOutstandingCount = 0;
    for (let i = 0; i < cutoffIndex; i += 1) {
      const weekOf = expected[i]!;
      if (weekOf !== currentWeek && isOutstanding(weekOf)) {
        olderOutstandingCount += 1;
        noteOldest(weekOf);
      }
    }

    let outstandingWeeks = 0;
    for (let i = cutoffIndex; i < expected.length; i += 1) {
      const weekOf = expected[i]!;
      // The current cadence week is the digest's own subject — it belongs in Filed/Outstanding above, not
      // in the backlog, or every outstanding project would be counted twice in one email.
      if (weekOf === currentWeek) continue;
      if (!isOutstanding(weekOf)) continue;
      outstandingWeeks += 1;
      noteOldest(weekOf);
    }
    // Gated on ANY outstanding week, in-window or older. Requiring an in-window one dropped a project
    // whose recent weeks are all filed but whose older backlog is not — it would disappear from the
    // digest entirely, which is the opposite of what a backlog report is for.
    if ((outstandingWeeks > 0 || olderOutstandingCount > 0) && oldestWeekOf != null) {
      entries.push({ projectName: project.projectName, outstandingWeeks, oldestWeekOf, olderOutstandingCount });
    }
  }
  // Worst first — the list is read top-down and truncated by attention, not by length.
  return entries.sort(
    (a, b) =>
      b.outstandingWeeks + b.olderOutstandingCount - (a.outstandingWeeks + a.olderOutstandingCount) ||
      a.projectName.localeCompare(b.projectName),
  );
}

function weekStateFor(input: { status: string | null; isDismissed: boolean }): WeeklyReportWeekState {
  if (input.status != null) return REPORT_STATE_BY_STATUS[input.status] ?? "not_started";
  return input.isDismissed ? "dismissed" : "not_started";
}

async function claimReminder(
  query: PgQuery,
  tenantSchema: string,
  weeklyReportProjectId: string,
  weekOf: string,
  kind: WeeklyReportReminderKind,
): Promise<boolean> {
  const result = await query(
    `INSERT INTO ${tenantSchema}.weekly_report_reminders_sent (weekly_report_project_id, week_of, kind)
     VALUES ($1::uuid, $2::date, $3)
     ON CONFLICT (weekly_report_project_id, week_of, kind) DO NOTHING
     RETURNING id`,
    [weeklyReportProjectId, weekOf, kind],
  );
  return result.rows.length > 0;
}

async function releaseReminderClaim(
  query: PgQuery,
  tenantSchema: string,
  weeklyReportProjectId: string,
  weekOf: string,
  kind: WeeklyReportReminderKind,
): Promise<void> {
  await query(
    `DELETE FROM ${tenantSchema}.weekly_report_reminders_sent
      WHERE weekly_report_project_id = $1::uuid AND week_of = $2::date AND kind = $3`,
    [weeklyReportProjectId, weekOf, kind],
  );
}

/** The two reminders that CHASE a person. `due_digest` reports to leadership and chases nobody. */
const CHASE_REMINDER_KINDS = ["t_minus_2", "t_minus_1"] as const satisfies readonly WeeklyReportReminderKind[];

/**
 * Every reminder the ledger records for these projects in `weekOf`, keyed by project.
 *
 * Reads ALL kinds. `due_digest` answers "has an earlier tick already reported on this project today"; the
 * t−2/t−1 rows answer "was anybody actually chased about it", which the digest states in print and used to
 * infer from present-tense reachability instead.
 *
 * ONE WEEK, always. `due_digest` rows accumulate one per project per week and are never cleaned up, so
 * dropping the `week_of` bound would make `alreadyDigested` hold every project ever digested: `newlyDue`
 * empties, and the leadership digest silently stops sending after its first week — no error, no log line,
 * just nothing. The bound is load-bearing for both consumers of this read, and both are pinned in the suite.
 */
async function reminderLedgerByProject(
  query: PgQuery,
  tenantSchema: string,
  weeklyReportProjectIds: string[],
  weekOf: string,
): Promise<Map<string, Set<WeeklyReportReminderKind>>> {
  const result = await query(
    `SELECT weekly_report_project_id, kind
       FROM ${tenantSchema}.weekly_report_reminders_sent
      WHERE weekly_report_project_id = ANY($1::uuid[]) AND week_of = $2::date`,
    [weeklyReportProjectIds, weekOf],
  );
  const byProject = new Map<string, Set<WeeklyReportReminderKind>>();
  for (const row of result.rows) {
    const projectId = String(row.weekly_report_project_id);
    const kinds = byProject.get(projectId) ?? new Set<WeeklyReportReminderKind>();
    kinds.add(String(row.kind) as WeeklyReportReminderKind);
    byProject.set(projectId, kinds);
  }
  return byProject;
}

/** Claims `due_digest` for every project due today; returns the ids this run actually won. */
async function claimDigest(
  query: PgQuery,
  tenantSchema: string,
  weeklyReportProjectIds: string[],
  weekOf: string,
): Promise<string[]> {
  const result = await query(
    `INSERT INTO ${tenantSchema}.weekly_report_reminders_sent (weekly_report_project_id, week_of, kind)
     SELECT id, $2::date, 'due_digest' FROM UNNEST($1::uuid[]) AS t(id)
     ON CONFLICT (weekly_report_project_id, week_of, kind) DO NOTHING
     RETURNING weekly_report_project_id`,
    [weeklyReportProjectIds, weekOf],
  );
  return result.rows.map((row) => String(row.weekly_report_project_id));
}

async function releaseDigestClaims(
  query: PgQuery,
  tenantSchema: string,
  weeklyReportProjectIds: string[],
  weekOf: string,
): Promise<void> {
  await query(
    `DELETE FROM ${tenantSchema}.weekly_report_reminders_sent
      WHERE weekly_report_project_id = ANY($1::uuid[]) AND week_of = $2::date AND kind = 'due_digest'`,
    [weeklyReportProjectIds, weekOf],
  );
}

/**
 * Who a per-project reminder goes to. The digest's "(unreachable)" annotation is decided by the same
 * predicate — but only as a statement about the NEXT reminder. What already went out comes from the ledger.
 */
function reminderRecipients(project: Pick<ProjectRow, "superEmail" | "pmEmail">): string[] {
  return dedupeEmails([project.superEmail, project.pmEmail].filter(isDeliverableEmail));
}

/** De-duplicate a recipient list case-insensitively, preserving the first spelling encountered. */
function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of emails) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/** The advisory lock's key. "WRRM" — stable and arbitrary; changing it splits the single-flight guard. */
export const WEEKLY_REPORT_REMINDER_LOCK_KEY = 0x57_52_52_4d;

/**
 * Postgres session advisory lock, global across worker instances, so a second replica's 07:00 tick skips
 * rather than racing this one for the same claims. It is the only thing standing between two replicas and
 * a doubled reminder to every superintendent in the office.
 *
 * The mechanism moved to `../lib/advisory-lock.js` when the weekly-report send sweep needed the same
 * primitive under its own key; this keeps the name, the key and the tests that pin them. `poolLike` is a
 * parameter purely so this can be exercised without a live Postgres — every run of the job in the suite
 * injects `acquireLock`, so nothing else executes a line of it.
 */
export async function acquireReminderAdvisoryLock(
  poolLike: AdvisoryLockPool = pool,
): Promise<null | (() => Promise<void>)> {
  return acquirePgAdvisoryLock(WEEKLY_REPORT_REMINDER_LOCK_KEY, poolLike);
}
