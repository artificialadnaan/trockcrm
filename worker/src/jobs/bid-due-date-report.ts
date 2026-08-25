import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailResult,
} from "../lib/system-email.js";
import { escapeHtml, isSafeTenantSchema, normalizeText } from "../lib/email-format.js";
import { acquirePgAdvisoryLock } from "../lib/advisory-lock.js";
import { renderBrandedEmail, resolveFrontendUrl } from "../lib/branded-email.js";
import {
  aliasedDealEstimatingValueSqlText,
  bidBoardTerminalSqlPredicate,
  effectiveOnHoldConditionSqlPredicate,
  genuineEstimatingStageSqlPredicate,
} from "@trock-crm/shared/types";

/**
 * THE WEDNESDAY BID-DUE-DATE REPORT.
 *
 * "a weekly report of projects in estimating stage and their approaching bid due date sorted by closest vs
 * furthest every week on wednesday at 5 pm" — one email, ranked, to the estimator, cc the requester.
 *
 * WHY A CRON AND NOT A RAILWAY SCHEDULE. Railway crons are UTC-only, which is why daily-summary-email has
 * to fire twice and gate in code. node-cron's `timezone` option is DST-aware, so one expression is correct
 * in both CDT and CST — and this report's entire value proposition is arriving at 5pm, before people leave.
 *
 * WHY IT NEVER SENDS TO NOBODY. The recipients are data (`notification_recipient_groups`), which means the
 * list can be empty, which means the mail can go to nobody. Resend answers `to: []` with a rejection, the
 * job would log a failure that reads like a provider blip, and the same thing would happen every Wednesday
 * with nobody told. So an empty `to` list is a THROW, before the send: the failure has to look like a
 * broken configuration, because that is what it is.
 */

const LOG = "[BidDueDateReport]";

/**
 * Wednesday and Thursday at 17:00 America/Chicago.
 *
 * EXPORTED, and consumed by worker/src/index.ts rather than written there, because index.ts boots the
 * worker on import and can never be loaded from a test. No test in this repo asserts a cron expression;
 * without this constant the DST test can only build its own Intl formatter and check that 17 === 17, which
 * is green whether the source says "0 17 * * 3", "0 18 * * 3" or omits the timezone entirely.
 *
 * THURSDAY IS A CATCH-UP TICK, not a second report. node-cron 3.0.3 only recovers a missed execution when
 * `recoverMissedExecutions` is set, and passing `{ timezone }` leaves it undefined; scheduler.js makes only
 * the CURRENT SECOND eligible. This process also runs pollJobs, PDF generation and Procore syncs, so a >1s
 * event-loop block across 17:00:00 drops the run with no error and no receipt. A daily job self-heals in
 * twenty-four hours. A weekly one loses seven days, silently. The `(tenant_schema, week_of)` receipt makes
 * the second tick free — it reads the receipt and returns — and bidDueReportWeekOf anchors BACKWARD, so
 * Thursday resolves to the same Wednesday and therefore the same receipt key.
 *
 * Precedent for a catch-up: worker/src/index.ts:240 (`0 7,9,11 * * *`), not :261.
 */
export const BID_DUE_REPORT_CRON = "0 17 * * 3,4";

/**
 * Containers run UTC — there is no TZ env var anywhere in this repo and Dockerfile.worker sets only
 * NODE_ENV — so the business timezone comes per-cron from node-cron's DST-aware option. The literal rather
 * than an import: `server/src/lib/period.ts`'s BUSINESS_TIMEZONE is unreachable from worker/ (rootDir is
 * ./src), and weekly-report-reminders.ts:48-52 already documents that decision for the same reason.
 */
export const BID_DUE_REPORT_TZ = "America/Chicago";

/**
 * "BDDR". Stable and arbitrary; changing it splits the single-flight guard.
 *
 * Deliberately not shared with any other job's key — two jobs on one key block each other, and a tick that
 * happened to overlap another job's run would silently send nothing. No ASCII key is provably
 * collision-free (the ai-* jobs hash their keys over the full uint32 range), so this is a convention, not a
 * proof; it is checked against the three other literal keys in this codebase and is distinct from all of them.
 */
export const BID_DUE_REPORT_LOCK_KEY = 0x42_44_44_52;

/** How far forward the report looks. */
export const BID_DUE_REPORT_HORIZON_DAYS = 30;

/**
 * How far BACK the Overdue section reaches.
 *
 * Bounded rather than open-ended, and stated in the email. Unbounded, the first send in any office would
 * announce every estimating deal whose bid date has ever passed — the most reliable way to teach the one
 * recipient this report exists for to filter its sender, on the very deploy that introduces it. Ninety days
 * is long enough that a bid missed over a quarter still surfaces.
 */
export const BID_DUE_REPORT_OVERDUE_LOOKBACK_DAYS = 90;

/** Recipient group keys. Both are in NOTIFICATION_RECIPIENT_GROUPS, so both are admin-editable. */
export const BID_DUE_REPORT_GROUP_KEY = "bid_due_date_report";
export const BID_DUE_REPORT_CC_GROUP_KEY = "bid_due_date_report_cc";

type PgQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export interface BidDueDateReportRow {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  /** The bid due date as a CT calendar day, `YYYY-MM-DD`. Sort key, window bound and display, all three. */
  bidDueOn: string;
  value: number;
  repName: string | null;
}

export type BidDueDateReportSectionKey = "overdue" | "this_week" | "next_30";

export interface BidDueDateReportSection {
  key: BidDueDateReportSectionKey;
  label: string;
  rows: BidDueDateReportRow[];
}

export interface BidDueDateReportDeps {
  query?: PgQuery;
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string; cc?: string[] }
  ) => Promise<SendSystemEmailResult>;
  acquireLock?: () => Promise<null | (() => Promise<void>)>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
  now?: Date;
}

export interface BidDueDateReportSummary {
  /** Offices considered — every active office row, including any that then failed. */
  offices: number;
  sent: number;
  /** Already had a receipt for this week — the Thursday catch-up's normal outcome. */
  skipped: number;
  /** Offices that threw. Non-zero makes the whole run fail; see the end of runBidDueDateReport. */
  failed: number;
}

// ---------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------

const CT_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: BID_DUE_REPORT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The America/Chicago calendar day an instant falls on, `YYYY-MM-DD`. */
export function ctDateOf(instant: Date): string {
  return CT_DATE_FORMAT.format(instant);
}

/**
 * The Wednesday this run belongs to — the receipt key, the idempotency key and the subject's anchor.
 *
 * Looks BACKWARD, unlike `weeklyReportWeekOf`, which resolves to the NEXT cadence day. Forward is right for
 * a report somebody still owes; here it would make the Thursday catch-up resolve to next week's Wednesday,
 * which is a different receipt key, which is a second email about the same week — the exact duplicate the
 * receipt exists to prevent.
 */
export function bidDueReportWeekOf(ctDate: string): string {
  const parsed = new Date(`${ctDate}T00:00:00Z`);
  const daysSinceWednesday = (parsed.getUTCDay() - 3 + 7) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - daysSinceWednesday);
  return parsed.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------------------------------

/**
 * The report's population, spelled once and reused by the footer's NULL count.
 *
 * EVERY predicate here is a shared builder, not a hand-rolled slug list. This codebase already carries
 * three hand-rolled estimating-stage lists that disagree with each other — one of them in the job called
 * "bid deadline", which filters on `expected_close_date` rather than the bid date — and a fourth would make
 * this report quote a population no other surface agrees with.
 *
 * THE HOLD RULE is `NOT effectiveOnHoldConditionSqlPredicate`, and NOT that predicate plus
 * `activeDealCountFilterSqlPredicate`. The second is the first's own leading disjunct
 * (`COALESCE(on_hold,false) = true`), so composing both would add a predicate that cannot change a single
 * row and that no test could ever move.
 *
 * The far-out auto-park leg is PROVABLY INERT for this population, which is worth knowing before someone
 * "simplifies" it away: in the genuine estimating stage the hold horizon IS `bid_due_date`, and every row
 * here has a bid date inside [today-90, today+30], so it can never be more than the 90-day horizon out.
 * The predicate reduces to the stored flag today. It stays because it is correct if the window ever widens,
 * and because its terminal legs are what keep a realized deal from being auto-parked.
 *
 * DIFFERS DELIBERATELY from `/reports/operations/estimator-pipeline`, which excludes no on-hold deals at
 * all. That page is an inventory; this is a to-do list, and a bid on a parked project is not a to-do.
 */
function reportPopulationSql(): string {
  return `
      ${genuineEstimatingStageSqlPredicate("d")}
      AND d.is_active = true
      AND COALESCE(d.is_test_data, false) = false
      AND COALESCE(d.is_change_order, false) = false
      AND psc.is_terminal = false
      AND NOT (${bidBoardTerminalSqlPredicate("d")})
      AND NOT (${effectiveOnHoldConditionSqlPredicate("d")})`;
}

function reportFromSql(schema: string): string {
  return `
     FROM ${schema}.deals d
     JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id`;
}

/**
 * ONE DATE, ONE SOURCE — `deals.bid_due_date`, read `AT TIME ZONE 'UTC'` — for the window, the sort and the
 * display alike.
 *
 * `bid_due_date` is a timestamptz stored at UTC midnight (migration 0132). A bare `::date` resolves in the
 * SESSION timezone; prod runs Etc/UTC today, but a pooler or a `SET TIME ZONE` would shift the calendar day
 * by one — which on this report means a row sorting between the wrong two neighbours, or a bid due today
 * filed under Overdue.
 *
 * `resolveDealBidDueDateForRead`'s precedence (Bid-Board-landed column > source lead > deal column, behind
 * BID_BOARD_DUE_DATE_READBACK) is DELIBERATELY NOT ported. It is server-only, as is the flag reader, and
 * porting it to the display layer alone — the only layer a worker could cheaply reach it from — is how a
 * report renders "Sep 30" between two August rows, or files a row under Overdue that is not overdue. If the
 * readback ever becomes the canonical read, it belongs in this SQL as a CASE, driving all three at once.
 */
const BID_DUE_ON_SQL = "(d.bid_due_date AT TIME ZONE 'UTC')::date";

export async function findBidDueDateReportRows(
  query: PgQuery,
  input: {
    tenantSchema: string;
    /**
     * THE ONE ANCHOR — the Wednesday this report is FOR, never the day the process happens to be running.
     *
     * On the Thursday catch-up these differ by a day, and every boundary derived from the run date would
     * then shift: the window would slide, and a deal due the following Wednesday would file under NEXT 30
     * DAYS on the normal run and THIS WEEK on the catch-up, with both emails headed the same week. The
     * catch-up has to be indistinguishable from the run it replaces, in content as well as identity.
     */
    weekOf: string;
    horizonDays?: number;
    overdueLookbackDays?: number;
  }
): Promise<BidDueDateReportRow[]> {
  const schema = assertSafeSchema(input.tenantSchema);
  const horizon = input.horizonDays ?? BID_DUE_REPORT_HORIZON_DAYS;
  const lookback = input.overdueLookbackDays ?? BID_DUE_REPORT_OVERDUE_LOOKBACK_DAYS;

  // THE VALUE CHAIN IS THE ESTIMATING-STAGE ONE (awarded > dd > bid_board > bid), matching the page this
  // email's CTA lands on. NOT `workerCurrentDealValueSql`, the worker's generic open chain, which is
  // bid_board-FIRST: a deal carrying both a DD estimate and a Bid Board total would be emailed one number
  // and display another the moment the reader clicked through. A figure and its drill-down move together,
  // and an email is a drill-down with a longer wire. The digest and the rep rollup keep the generic chain —
  // their surfaces are not this one — which is why the two still exist side by side.
  //
  // `assigned_rep_id`, NOT `estimator_user_id`. They are different fields with different semantics, and
  // migration 0222's own header is why: of Colby Burling's 221 estimator rows, 167 are his OWN deals, so
  // that column identifies "who touched the estimate", not "who owns the bid". This report answers "who do
  // I chase about this", which is the owner. One column, never a COALESCE of the two — a COALESCE would
  // print a different person for two otherwise identical deals depending on which field happened to be set.
  //
  // LEFT JOIN, so a deal with no rep survives to render '—'. bid-deadline.ts:90 excludes null reps because
  // it CREATES A TASK and a task needs an owner; this report only informs, and an unowned bid with a
  // deadline is the single row most worth putting in front of somebody.
  const result = await query(
    `SELECT d.id::text AS id,
            d.name AS name,
            d.deal_number AS deal_number,
            d.project_number AS project_number,
            to_char(${BID_DUE_ON_SQL}, 'YYYY-MM-DD') AS bid_due_on,
            (${aliasedDealEstimatingValueSqlText("d")})::numeric AS value,
            u.display_name AS rep_name
       ${reportFromSql(schema)}
       LEFT JOIN public.users u ON u.id = d.assigned_rep_id
      WHERE ${reportPopulationSql()}
        AND d.bid_due_date IS NOT NULL
        AND ${BID_DUE_ON_SQL} >= $1::date - $2::int
        AND ${BID_DUE_ON_SQL} <= $1::date + $3::int
      ORDER BY ${BID_DUE_ON_SQL} ASC, d.name ASC`,
    [input.weekOf, lookback, horizon]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    dealNumber: normalizeText(row.deal_number),
    projectNumber: normalizeText(row.project_number),
    bidDueOn: String(row.bid_due_on),
    value: Number(row.value ?? 0),
    repName: normalizeText(row.rep_name),
  }));
}

/**
 * The footer's reconciliation number: estimating deals carrying NO bid due date.
 *
 * The SAME predicates as the list, minus the date filter — otherwise it reconciles with nothing, and a
 * footer that reconciles with nothing is worse than no footer. It exists because `bid_due_date` is NULL on
 * ~91% of deals: without it a short list reads as "nothing is due", when what it may mean is "nobody has
 * filled the field in".
 */
export async function countEstimatingDealsMissingBidDueDate(
  query: PgQuery,
  input: { tenantSchema: string }
): Promise<number> {
  const schema = assertSafeSchema(input.tenantSchema);
  const result = await query(
    `SELECT COUNT(*)::int AS missing_count
       ${reportFromSql(schema)}
      WHERE ${reportPopulationSql()}
        AND d.bid_due_date IS NULL`
  );
  return Number(result.rows[0]?.missing_count ?? 0);
}

function assertSafeSchema(tenantSchema: string): string {
  // Identifiers cannot be $-parametrized, so the schema is interpolated and therefore validated with the
  // same guard the other worker email jobs use.
  if (!isSafeTenantSchema(tenantSchema)) {
    throw new Error(`Unsafe tenant schema: ${tenantSchema}`);
  }
  return tenantSchema;
}

// ---------------------------------------------------------------------------------------------------
// Sectioning
// ---------------------------------------------------------------------------------------------------

const SECTION_LABELS: Record<BidDueDateReportSectionKey, string> = {
  overdue: "OVERDUE",
  this_week: "THIS WEEK",
  next_30: "NEXT 30 DAYS",
};

/**
 * Overdue -> this week -> next 30 days, each ascending, empty sections dropped.
 *
 * In TypeScript over the ONE ordered result set rather than three queries, so the section a row lands in is
 * derived from the same `bidDueOn` the row displays. Three queries would be three chances for a row to be
 * filed under a date it does not show.
 */
export function sectionBidDueDateReportRows(
  rows: readonly BidDueDateReportRow[],
  weekOf: string
): BidDueDateReportSection[] {
  const endOfWeek = addDays(weekOf, 6);
  const buckets: Record<BidDueDateReportSectionKey, BidDueDateReportRow[]> = {
    overdue: [],
    this_week: [],
    next_30: [],
  };
  for (const row of rows) {
    if (row.bidDueOn < weekOf) buckets.overdue.push(row);
    else if (row.bidDueOn <= endOfWeek) buckets.this_week.push(row);
    else buckets.next_30.push(row);
  }
  return (["overdue", "this_week", "next_30"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: SECTION_LABELS[key], rows: buckets[key] }));
}

// ---------------------------------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------------------------------

/**
 * Who a notification group's mail goes to FOR ONE OFFICE, resolved in RAW SQL.
 *
 * `officeId` IS REQUIRED, and that is the whole point of this signature.
 *
 * The groups are keyed UNIQUE in `public`, so an assignment is GLOBAL — it says "this person receives this
 * notification", not "…for this office". Sending an office's report to that unfiltered list mails one
 * office's estimating pipeline — deal names, project numbers and dollar values — to people who cannot open
 * a single one of those deals in the CRM. That is an authorization leak, not a preference: access here is
 * granted by a user's PRIMARY office or an explicit `user_office_access` row, and neither was being
 * consulted. It is latent at one office and the thing that fires it is somebody adding a second, which
 * nobody will connect to this job.
 *
 * The predicate is the SQL twin of `getOfficeAccess` (server/src/modules/auth/office-access.ts) and applies
 * BOTH of its legs, because the helper applies both: the primary office passes on its own, any other office
 * needs a grant. Copying only the grant leg would drop every ordinary single-office user; copying only the
 * primary leg would drop exactly the cross-office people the grants exist for. That module's own header
 * says the rule is needed by background work as well as by request middleware — this is that background
 * work, reaching it the only way a worker can, since importing it would pull `server/src` into `worker/`.
 *
 * `is_active` is enforced for the same reason it is server-side: a deactivated person is not a recipient,
 * and a group that resolves entirely to deactivated (or unauthorized) people is EMPTY — which the caller
 * must treat as a hard failure, never a quiet skip.
 */
export async function resolveGroupRecipients(
  query: PgQuery,
  key: string,
  officeId: string | null
): Promise<string[]> {
  const result = await query(
    `SELECT u.email AS email
       FROM public.notification_recipient_groups g
       JOIN public.notification_recipient_assignments a ON a.group_id = g.id
       JOIN public.users u ON u.id = a.user_id
      WHERE g.key = $1
        AND u.is_active = true
        AND (
          u.office_id = $2::uuid
          OR EXISTS (
            SELECT 1 FROM public.user_office_access uoa
             WHERE uoa.user_id = u.id AND uoa.office_id = $2::uuid
          )
        )
      ORDER BY lower(u.email)`,
    [key, officeId]
  );
  // The blank/NULL address filter is HERE and not in the WHERE above, deliberately: normalizeText has to
  // run anyway to type the value, so a SQL guard beside it would be a predicate that cannot change a
  // single result and that no test could ever move.
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const row of result.rows) {
    const email = normalizeText(row.email);
    if (!email) continue;
    const dedupeKey = email.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    emails.push(email);
  }
  return emails;
}

// ---------------------------------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(day)}`;
}

function formatRelativeDays(bidDueOn: string, deliveryDate: string): string {
  const delta = daysBetween(deliveryDate, bidDueOn);
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta === -1) return "yesterday";
  if (delta < 0) return `${-delta} days ago`;
  return `in ${delta} days`;
}

function formatMoney(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** "Sidney Gibson" -> "S. Gibson"; a single-word name is left alone; no name at all is an em dash. */
function formatRepName(repName: string | null): string {
  if (!repName) return "—";
  const parts = repName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return repName;
  return `${parts[0]![0]}. ${parts.slice(1).join(" ")}`;
}

function rowCells(row: BidDueDateReportRow, deliveryDate: string): string[] {
  return [
    formatShortDate(row.bidDueOn),
    formatRelativeDays(row.bidDueOn, deliveryDate),
    row.name,
    row.projectNumber ?? row.dealNumber ?? "—",
    formatMoney(row.value),
    formatRepName(row.repName),
  ];
}

/**
 * A SIX-column row, which is why this is not `renderDetailRows`: that renders a two-column label/value
 * table and is the wrong primitive for a ranked list. Same typography, same rule colour, so the two still
 * read as one product.
 */
function renderSectionHtml(section: BidDueDateReportSection, deliveryDate: string): string {
  const rows = section.rows
    .map((row) => {
      const cells = rowCells(row, deliveryDate);
      const [date, relative, name, number, value, rep] = cells;
      return `
                <tr>
                  <td style="padding:8px 8px 8px 0;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#111111;font-weight:bold;white-space:nowrap;vertical-align:top;">${escapeHtml(date!)}</td>
                  <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#64748b;white-space:nowrap;vertical-align:top;">${escapeHtml(relative!)}</td>
                  <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#111111;vertical-align:top;">${escapeHtml(name!)}</td>
                  <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#64748b;white-space:nowrap;vertical-align:top;">${escapeHtml(number!)}</td>
                  <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#111111;white-space:nowrap;text-align:right;vertical-align:top;">${escapeHtml(value!)}</td>
                  <td style="padding:8px 0 8px 8px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#64748b;white-space:nowrap;vertical-align:top;">${escapeHtml(rep!)}</td>
                </tr>`;
    })
    .join("");
  return `
            <p style="margin:20px 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;color:${section.key === "overdue" ? "#CC0000" : "#64748b"};font-weight:bold;letter-spacing:0.06em;">${escapeHtml(section.label)} (${section.rows.length})</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${rows}
            </table>`;
}

export interface BidDueDateReportEmailInput {
  /**
   * THE CONTENT ANCHOR — the Wednesday this report is FOR. Decides the SQL window, the sectioning, the
   * subject and the receipt key, so the Thursday catch-up contains exactly what the run it replaces would
   * have contained.
   */
  weekOf: string;
  /**
   * THE READING ANCHOR — the CT day this email is actually delivered on. Decides ONLY the
   * "today / tomorrow / in N days" prose beside each row.
   *
   * A SECOND anchor, deliberately, after a first draft collapsed both into `weekOf`. The two answer
   * different questions and only coincide on the normal tick: `weekOf` is what the report is ABOUT, and
   * this is when a human is reading it. Anchoring the prose to `weekOf` told a Thursday reader that a bid
   * due Wednesday was due "today" — in the one column the report exists to make urgent — while anchoring
   * the CONTENT here made the catch-up silently disagree with the run it stood in for. Neither field can
   * do the other's job.
   */
  deliveryDate: string;
  sections: readonly BidDueDateReportSection[];
  missingBidDateCount: number;
  ctaUrl: string;
  overdueLookbackDays?: number;
}

export function buildBidDueDateReportEmail(input: BidDueDateReportEmailInput) {
  const lookback = input.overdueLookbackDays ?? BID_DUE_REPORT_OVERDUE_LOOKBACK_DAYS;
  const subject = `Bid due dates — week of ${formatShortDate(input.weekOf)}`;

  // THE PREHEADER IS DERIVED FROM THE SECTIONS, never counted separately.
  //
  // It used to state one total against a "next 30 days" sentence, and that total INCLUDED the overdue
  // section — so a report whose only row was a bid due yesterday read "1 project in estimating with bid
  // dates in the next 30 days". False, in the one line a phone shows before the body opens.
  //
  // The report spans two windows (90 days of overdue lookback, 30 days upcoming) and the honest summary
  // names both. Taking the numbers from `sections` rather than re-counting is what makes the preheader,
  // the section headings and the footer three views of one population instead of three chances to
  // disagree — the same rule the footer's NULL count already follows.
  const overdueCount = input.sections
    .filter((section) => section.key === "overdue")
    .reduce((sum, section) => sum + section.rows.length, 0);
  const upcomingCount = input.sections
    .filter((section) => section.key !== "overdue")
    .reduce((sum, section) => sum + section.rows.length, 0);
  const upcomingPhrase = `in the next ${BID_DUE_REPORT_HORIZON_DAYS} days`;
  const projects = (count: number) => `${count} ${count === 1 ? "project" : "projects"}`;

  // AN EMPTY REPORT STILL SENDS, and says it is empty. A silent week is indistinguishable from a broken
  // job, and this one runs 52 times a year in front of one person who would have no other way to tell.
  let preheader: string;
  if (overdueCount === 0 && upcomingCount === 0) {
    preheader = `No estimating deals have a bid due date ${upcomingPhrase} or overdue in the last ${lookback}.`;
  } else if (overdueCount === 0) {
    preheader = `${projects(upcomingCount)} in estimating with bid dates ${upcomingPhrase}.`;
  } else if (upcomingCount === 0) {
    preheader = `${overdueCount} overdue ${overdueCount === 1 ? "bid" : "bids"} in estimating, and nothing due ${upcomingPhrase}.`;
  } else {
    preheader = `${projects(overdueCount + upcomingCount)} in estimating: ${overdueCount} overdue, ${upcomingCount} due ${upcomingPhrase}.`;
  }

  const footerLines: string[] = [`Overdue covers the last ${lookback} days.`];
  if (input.missingBidDateCount > 0) {
    footerLines.push(
      `${input.missingBidDateCount} estimating ${input.missingBidDateCount === 1 ? "deal has" : "deals have"} no bid due date set and ${input.missingBidDateCount === 1 ? "is" : "are"} not listed.`
    );
  }

  const bodyHtml =
    input.sections.map((section) => renderSectionHtml(section, input.deliveryDate)).join("") +
    footerLines
      .map(
        (line) => `
            <p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">${escapeHtml(line)}</p>`
      )
      .join("");

  const html = renderBrandedEmail({
    title: "Bid due dates",
    preheader,
    bodyHtml,
    primaryLabel: "Open estimating deals",
    primaryUrl: input.ctaUrl,
  });

  const textLines: string[] = [preheader, ""];
  for (const section of input.sections) {
    textLines.push(`${section.label} (${section.rows.length})`);
    for (const row of section.rows) {
      textLines.push(`  ${rowCells(row, input.deliveryDate).join("  ·  ")}`);
    }
    textLines.push("");
  }
  textLines.push(`Open estimating deals: ${input.ctaUrl}`, "", ...footerLines);

  return { subject, html, text: textLines.join("\n") };
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

/**
 * MULTI-OFFICE MODEL, stated because the three mechanisms involved disagree by default.
 *
 * The run walks every ACTIVE office and sends one email per office, under ONE advisory lock, with receipts
 * keyed `(tenant_schema, week_of)`. Today there is one active office, so that is one email.
 *
 * RECIPIENTS ARE GLOBAL. `notification_recipient_groups.key` is UNIQUE in `public` and users are a global
 * table, so every office resolves to the same people. That is correct for one office and becomes wrong the
 * moment there are two — the same person would receive N emails with no way to tell them apart. Making
 * recipients per-office is the change that has to happen first, not a second schedule.
 *
 * THE SCHEDULE IS ONE CT CRON, and `public.offices` carries its own `timezone` column that this job does
 * NOT read. An office in another timezone would get its report at 5pm Central, not 5pm local, and would
 * need its own registration. Same limitation, same reasoning, as weekly-report-reminders.ts:48-52.
 */
export async function runBidDueDateReport(
  deps: BidDueDateReportDeps = {}
): Promise<BidDueDateReportSummary> {
  const logger = deps.logger ?? console;
  const query = deps.query ?? (pool.query.bind(pool) as PgQuery);
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const todayCt = ctDateOf(now);
  const weekOf = bidDueReportWeekOf(todayCt);
  const summary: BidDueDateReportSummary = { offices: 0, sent: 0, skipped: 0, failed: 0 };

  const acquireLock = deps.acquireLock ?? (() => acquirePgAdvisoryLock(BID_DUE_REPORT_LOCK_KEY));
  const releaseLock = await acquireLock();
  if (!releaseLock) {
    logger.log(`${LOG} Another run holds the lock - skipping this tick`);
    return summary;
  }

  try {
    // A GLOBAL pre-flight: is anybody assigned to the group AT ALL?
    //
    // Kept as an early throw even though the authoritative resolution is now per office, because the two
    // faults are different and an operator fixes them differently. "Nobody is configured" is one message
    // about one group; "nobody configured can see Atlanta" is a message about Atlanta. Reporting the first
    // once, before any office is read, beats reporting it N times as N office failures.
    const anyAssignment = await query(
      `SELECT 1
         FROM public.notification_recipient_groups g
         JOIN public.notification_recipient_assignments a ON a.group_id = g.id
         JOIN public.users u ON u.id = a.user_id
        WHERE g.key = $1 AND u.is_active = true
        LIMIT 1`,
      [BID_DUE_REPORT_GROUP_KEY]
    );
    if (anyAssignment.rows.length === 0) {
      // error + throw, never a warn-and-return. The resolver has no way to say "nobody" out loud: it
      // returns [], the send is rejected by the provider, and the log line reads like a delivery blip. Next
      // Wednesday it happens again. The job retries, then dead-letters, and somebody is told.
      const message =
        `${LOG} The "${BID_DUE_REPORT_GROUP_KEY}" recipient group resolves to nobody, so the weekly bid ` +
        `due date report has no audience. Assign at least one ACTIVE user to it on the admin ` +
        `Notification Recipients page. Not sending.`;
      logger.error(message, { weekOf });
      throw new Error(message);
    }

    const offices = await query(
      `SELECT id, slug, name FROM public.offices WHERE is_active = true ORDER BY slug`
    );
    for (const office of offices.rows) {
      // Counted BEFORE the slug guard and before the try, so `offices` means "considered" rather than
      // "reached the send" — otherwise the failure message below has to reconstruct the denominator from
      // two counters that do not add up.
      summary.offices += 1;
      const slug = String(office.slug ?? "");
      const tenantSchema = `office_${slug}`;
      if (!isSafeTenantSchema(tenantSchema)) {
        logger.error(`${LOG} Invalid office slug "${office.slug}" - skipping`);
        summary.failed += 1;
        continue;
      }
      const officeId = (office.id as string | null) ?? null;
      try {
        // RESOLVED PER OFFICE, because a recipient assignment is global and office access is not. See
        // resolveGroupRecipients.
        const recipients = await resolveGroupRecipients(query, BID_DUE_REPORT_GROUP_KEY, officeId);
        if (recipients.length === 0) {
          // The same loud failure as an empty group, scoped to one office — NOT a silent skip. An office
          // whose report reaches nobody is the exact fault this job refuses to perform quietly, and the
          // per-office catch below turns it into one failed office rather than a dead run.
          throw new Error(
            `${LOG} No ACTIVE member of "${BID_DUE_REPORT_GROUP_KEY}" has access to office ` +
              `${tenantSchema}, so its report would reach nobody. Give a recipient this office as their ` +
              `primary office or a user_office_access grant.`
          );
        }
        const ccRecipients = await resolveGroupRecipients(query, BID_DUE_REPORT_CC_GROUP_KEY, officeId);
        if (ccRecipients.length === 0) {
          // Oversight, not audience: an empty cc is a choice an admin may make, so the report still goes.
          logger.warn(`${LOG} No cc recipient has access to this office - sending with no copy`, {
            tenantSchema,
            weekOf,
          });
        }
        await sendOfficeReport({
          query,
          sendEmail: deps.sendEmail ?? sendSystemEmailWithMetadata,
          logger,
          summary,
          tenantSchema,
          officeId,
          recipients,
          ccRecipients,
          weekOf,
          deliveryDate: todayCt,
          frontendUrl: resolveFrontendUrl(env),
        });
      } catch (err) {
        // ONE BROKEN OFFICE MUST NOT COST THE OTHERS THEIR WEEK. Unguarded, any tenant-query or provider
        // error thrown here aborts the loop, so every office BEHIND this one in slug order misses the
        // report entirely — and the Thursday catch-up walks the same list in the same order, so a
        // persistently broken first office fails at exactly the same point and rescues nobody. The office
        // that failed wrote no receipt (the write is the last thing sendOfficeReport does, and only on a
        // delivered outcome), so the catch-up genuinely retries it.
        logger.error(`${LOG} Office report failed`, { tenantSchema, weekOf, err });
        summary.failed += 1;
      }
    }
  } finally {
    // Released on EVERY path out of the try, including the throw below. A stranded session advisory lock
    // makes every later tick a silent no-op — the catch-up and next week alike — which is how a transient
    // tenant error becomes a permanently dead job.
    await releaseLock().catch(() => undefined);
  }

  logger.log(`${LOG} Run complete`, summary);
  if (summary.failed > 0) {
    // A NON-ZERO FAILURE SIGNAL, not a quiet partial success. Every office got its attempt — that is what
    // the per-office catch above bought — but a run that resolves normally after dropping an office logs
    // identically to a week that fully worked, and the cron's catch block never fires. Throwing here is
    // the only thing that distinguishes them.
    throw new Error(`${LOG} ${summary.failed} of ${summary.offices} offices failed`);
  }
  return summary;
}

async function sendOfficeReport(input: {
  query: PgQuery;
  sendEmail: NonNullable<BidDueDateReportDeps["sendEmail"]>;
  logger: Pick<Console, "log" | "warn" | "error">;
  summary: BidDueDateReportSummary;
  tenantSchema: string;
  officeId: string | null;
  recipients: string[];
  ccRecipients: string[];
  weekOf: string;
  deliveryDate: string;
  frontendUrl: string;
}): Promise<void> {
  const { query, logger, tenantSchema, weekOf } = input;

  // Exactly-once for the week. Read BEFORE the work, so the Thursday catch-up usually costs one SELECT.
  //
  // ANY row here declines the send, stamped or not. An unstamped row is a claim whose outcome we never
  // learned — the message may already be in the inbox — and re-sending on a maybe is the duplicate this
  // ledger exists to prevent.
  const receipt = await query(
    `SELECT resend_message_id, sent_at, outcome
       FROM public.bid_due_date_report_receipts
      WHERE tenant_schema = $1 AND week_of = $2::date
      LIMIT 1`,
    [tenantSchema, weekOf]
  );
  if (receipt.rows.length > 0) {
    const confirmed = receipt.rows[0]?.sent_at != null;
    input.summary.skipped += 1;
    logger.log(
      confirmed
        ? `${LOG} Already sent this week - skipping`
        : `${LOG} A previous attempt this week never confirmed - declining rather than risk a duplicate. ` +
          `Delete the row to re-arm the week.`,
      {
        tenantSchema,
        weekOf,
        outcome: receipt.rows[0]?.outcome ?? null,
        messageId: receipt.rows[0]?.resend_message_id ?? null,
      }
    );
    return;
  }

  const rows = await findBidDueDateReportRows(query, { tenantSchema, weekOf });
  const missingBidDateCount = await countEstimatingDealsMissingBidDueDate(query, { tenantSchema });
  const sections = sectionBidDueDateReportRows(rows, weekOf);

  const email = buildBidDueDateReportEmail({
    weekOf,
    deliveryDate: input.deliveryDate,
    sections,
    missingBidDateCount,
    ctaUrl: await resolveEstimatingCtaUrl(query, input.frontendUrl, input.officeId),
  });

  // CLAIM THE WEEK BEFORE CALLING THE PROVIDER. A row written only after a successful send cannot protect
  // anything: the ambiguous outcome is exactly the case where that write never happens. ON CONFLICT DO
  // NOTHING makes the claim the atomic winner even though the advisory lock already serializes runs.
  const claim = await query(
    `INSERT INTO public.bid_due_date_report_receipts (
        tenant_schema, week_of, recipient_emails, deal_count, claimed_at, created_at, updated_at
      )
      VALUES ($1, $2::date, $3, $4, NOW(), NOW(), NOW())
      ON CONFLICT (tenant_schema, week_of) DO NOTHING
      RETURNING tenant_schema`,
    [
      tenantSchema,
      weekOf,
      [...input.recipients, ...input.ccRecipients].join(", "),
      rows.length,
    ]
  );
  if ((claim.rowCount ?? claim.rows.length) === 0) {
    input.summary.skipped += 1;
    logger.log(`${LOG} Another run claimed this week first - skipping`, { tenantSchema, weekOf });
    return;
  }

  const sendResult = await input.sendEmail(input.recipients, email.subject, email.html, {
    text: email.text,
    idempotencyKey: `bid-due-report-${tenantSchema}-${weekOf}`,
    // No bcc. SYSTEM_EMAIL_BCC is live in production and already bcc's every system email; adding one here
    // would double it. And under EMAIL_OVERRIDE_RECIPIENT the cc is discarded entirely, so the copy to
    // Adnaan is not observable in prod until that override is unset — the unit test is the proof until then.
    ...(input.ccRecipients.length > 0 ? { cc: input.ccRecipients } : {}),
  });

  // BRANCH ON `outcome`, never `success` — and branch on all THREE values, because `rejected` and
  // `unknown` need opposite handling. Treating them alike (the first draft threw on both and wrote
  // nothing) means the Thursday catch-up calls the provider again for a message that may already have
  // been delivered.
  if (sendResult.outcome === "rejected") {
    // The provider positively refused and created NOTHING, so a re-send is safe and the week must stay
    // open. Releasing the claim is what lets the catch-up genuinely retry.
    await query(
      `DELETE FROM public.bid_due_date_report_receipts WHERE tenant_schema = $1 AND week_of = $2::date`,
      [tenantSchema, weekOf]
    );
    const message = `${LOG} Send was REJECTED - claim released, the next tick will retry`;
    logger.error(message, { tenantSchema, weekOf, reason: sendResult.reason ?? null });
    throw new Error(message);
  }

  if (sendResult.outcome !== "delivered") {
    // `unknown`. The message MAY be in the inbox. The claim stays, unstamped, so the catch-up declines;
    // the outcome is recorded so an operator can tell "never confirmed" from "never attempted" and delete
    // the row to re-arm the week if they establish nothing arrived.
    await query(
      `UPDATE public.bid_due_date_report_receipts
          SET outcome = $3, updated_at = NOW()
        WHERE tenant_schema = $1 AND week_of = $2::date`,
      [tenantSchema, weekOf, sendResult.outcome]
    );
    const message =
      `${LOG} Send outcome UNKNOWN - the message may have been delivered, so the claim is kept and the ` +
      `catch-up will NOT re-send. Delete the receipt row to re-arm the week.`;
    logger.error(message, { tenantSchema, weekOf, reason: sendResult.reason ?? null });
    throw new Error(message);
  }

  await query(
    `UPDATE public.bid_due_date_report_receipts
        SET sent_at = NOW(), resend_message_id = $3, outcome = 'delivered', updated_at = NOW()
      WHERE tenant_schema = $1 AND week_of = $2::date`,
    [tenantSchema, weekOf, sendResult.messageId]
  );
  input.summary.sent += 1;
  logger.log(`${LOG} Sent`, {
    tenantSchema,
    weekOf,
    deals: rows.length,
    missingBidDateCount,
    recipientCount: input.recipients.length,
    ccCount: input.ccRecipients.length,
    messageId: sendResult.messageId,
  });
}

/**
 * A CTA the RECIPIENT CAN OPEN.
 *
 * NOT `/reports/operations/estimator-pipeline`: that route is `RequireRole allowedRoles={["admin",
 * "director"]}`, there is no estimator role, and Sidney is a `rep` — so the obvious link is a 403 for the
 * one person this report is written for. `renderBrandedEmail`'s primaryLabel/primaryUrl are required, so it
 * cannot be left blank either.
 *
 * `/deals/stages/:stageId` carries no RequireRole, and `?scope=all` is in a rep's allowed scope set. The
 * scope matters as much as the route: the stage page defaults to `scope=mine`, and migration 0222's header
 * records that Sidney owns 0 deals and estimates 137 — so the default would render her an empty board, the
 * same failure one level down.
 *
 * `officeId` carries the deal's tenant, so a recipient whose default office differs does not land on
 * somebody else's board. Degrades to `/deals` if the stage id cannot be resolved: a link to a list the
 * recipient can filter beats a link to a 404.
 */
async function resolveEstimatingCtaUrl(
  query: PgQuery,
  frontendUrl: string,
  officeId: string | null
): Promise<string> {
  const base = frontendUrl.replace(/\/+$/, "");
  const officeParam = officeId ? `&officeId=${encodeURIComponent(officeId)}` : "";
  const stage = await query(
    `SELECT id::text AS id FROM public.pipeline_stage_config WHERE slug = 'estimating' LIMIT 1`
  );
  const stageId = normalizeText(stage.rows[0]?.id ?? null);
  if (!stageId) {
    return `${base}/deals${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;
  }
  return `${base}/deals/stages/${encodeURIComponent(stageId)}?scope=all${officeParam}`;
}
