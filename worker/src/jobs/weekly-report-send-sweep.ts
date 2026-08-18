import { createHash } from "node:crypto";
import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailOutcome,
  type SendSystemEmailResult,
} from "../lib/system-email.js";
import { escapeHtml, isSafeTenantSchema, normalizeText } from "../lib/email-format.js";
import { acquirePgAdvisoryLock } from "../lib/advisory-lock.js";
import { resolveFrontendUrl } from "./project-number-email.js";
// The reminder cron owns the branded shell and the leadership dashboard link. Both emails go to the SAME
// roster about the SAME feature, so they share one look and one URL builder rather than two copies that
// drift.
import {
  renderBrandedEmail,
  renderDetailRows,
  weeklyReportDashboardUrl,
} from "./weekly-report-reminders.js";
import {
  WEEKLY_REPORT_SEND_STALL_MINUTES,
  weeklyReportLastSendActivityAt,
  weeklyReportSendHasStalled,
} from "@trock-crm/shared/lib/weeklyReportSendStall";

/**
 * THE DEAD-LETTER SWEEP: tell somebody when a weekly report's delivery stops moving.
 *
 * PR5 shipped SURFACING, not alerting. An undelivered send is drawn on the weekly-reports board and on the
 * Projects tab, and nothing tells a human it is there — somebody has to go and look. The failure this whole
 * feature exists to catch (a client who was promised a weekly report and never receives one) can therefore
 * still pass unnoticed for as long as nobody opens the page. This job is the part that speaks.
 *
 * WHAT IT SWEEPS. Exactly the row set migration 0226 built its partial index for — `is_active`,
 * `status = 'sent'`, `send_delivered_at IS NULL` — narrowed by 0227's `send_stall_alerted_at IS NULL` so
 * the read stays inside an index that holds only the handful of sends currently in flight.
 *
 * WHAT IT AGES AGAINST. `weeklyReportSendHasStalled`, the SAME shared predicate the CRM board derives its
 * chip from, which measures from the LATER of `sent_at` and `send_last_attempt_at`. Ageing off `sent_at`
 * alone is the specific bug 0226 was written to fix: it is stamped once when the sender commits and never
 * moves, so every legitimate retry read as "Send stuck". And `send_attempts` alone cannot tell "failed
 * twice an hour ago and gave up" from "failed twice in the last minute and is still retrying" — which is
 * the entire difference between a report somebody must act on and one they should leave alone.
 *
 * ONCE, NOT EVERY PASS. This runs every fifteen minutes; a job that emailed leadership every fifteen
 * minutes about the same stuck report would have a filter rule built for it inside a day, and the next real
 * failure would then be invisible for exactly the reason it was before this feature existed. So the alert
 * fires on the TRANSITION into stalled and `send_stall_alerted_at` records that it did. Only a human
 * pressing Retry re-arms it (see `retryWeeklyReportSend`), because that is the only event that means
 * somebody acted and could need telling again.
 *
 * WHAT IT DOES NOT CLAIM. `send_delivered_at` records that the mail PROVIDER accepted the message, not
 * that a human received it; there is no bounce webhook in this codebase yet. So the email says the CRM has
 * no record of the message being accepted — it does not say the client did not get their report, and it
 * must not, because the one case where a delivery succeeds and the stamp does not land (the database going
 * away between the two) looks identical from here.
 */

/** Cron identity, for logs. */
const LOG = "[WeeklyReportSendSweep]";

/**
 * The advisory lock's key. "WRSW" — stable and arbitrary; changing it splits the single-flight guard.
 *
 * Deliberately NOT the reminder cron's key: sharing one would make the two jobs block each other, and a
 * sweep that happened to overlap the 07:00 reminder tick would silently do nothing.
 */
export const WEEKLY_REPORT_SEND_SWEEP_LOCK_KEY = 0x57_52_53_57;

/**
 * How far back a stalled send can be and still be worth ALERTING about.
 *
 * The alert is for a failure that has just happened. A send that stopped moving a month ago is a backlog
 * item, and the board — which applies no such bound — is where a backlog belongs.
 *
 * Without this bound the sweep's FIRST pass in any office would announce every undelivered send in its
 * history at once, because none of them carries `send_stall_alerted_at` yet. That is the single most
 * reliable way to teach a roster of directors to filter this sender, and it would happen on the very
 * deploy that introduces the alert.
 *
 * A week rather than a day, so a worker that was down over a long weekend still reports what it missed
 * when it comes back. The cost is the one case this deliberately gives up on: a send that stalls while the
 * worker is down for longer than a week is never alerted, only drawn on the board.
 */
export const WEEKLY_REPORT_SEND_ALERT_MAX_AGE_HOURS = 24 * 7;

/** Every tenant table the sweep reads. Probed per office before a single query touches them — see below. */
const REQUIRED_TENANT_TABLES = ["weekly_reports", "weekly_report_projects", "weekly_report_settings"] as const;

/**
 * Every `weekly_reports` column the sweep reads or writes that arrived AFTER the table did.
 *
 * MIGRATIONS DO NOT RUN ON THE WORKER IN THIS REPO. The API runs the migration runner before it starts;
 * the worker does not. So there is a real deploy window — every deploy, in fact, since the two services
 * are separate Railway deployments — in which this cron is live against a database that has 0222's
 * `weekly_reports` and neither 0226's nor 0227's columns. An unguarded SELECT throws 42703 (undefined
 * column) for every office on every tick, forever, until the API happens to deploy.
 *
 * The probe makes that window a no-op instead: each office logs once per tick at INFO and is skipped, and
 * the sweep starts working by itself the moment the API applies the migration. Nothing is lost by waiting
 * — the rows are still there and still undelivered, and `send_stall_alerted_at` is NULL for all of them,
 * so the first pass after the column exists alerts on exactly what it would have alerted on before.
 *
 * The columns are probed rather than the migration being assumed, because the table probe alone cannot see
 * this: `weekly_reports` exists in every office from 0222 onward, so a to_regclass check passes happily
 * while the column the query needs is missing.
 */
const REQUIRED_REPORT_COLUMNS = [
  "sent_at",
  "send_error",
  "send_attempts",
  // 0226
  "send_delivered_at",
  "send_last_attempt_at",
  // 0227
  "send_stall_alerted_at",
] as const;

const BUSINESS_TIMEZONE = "America/Chicago";

type PgQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

type SendEmail = (
  to: string | string[],
  subject: string,
  html: string,
  options: { text: string; idempotencyKey: string },
) => Promise<SendSystemEmailResult>;

export interface WeeklyReportSendSweepDeps {
  query?: PgQuery;
  sendEmail?: SendEmail;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** The reference instant every age is measured from. Injected so tests can pin it absolutely. */
  now?: Date;
  /**
   * Single-flight guard: resolves to a release fn if this run acquired the lock, or null if another run
   * holds it. Default = a Postgres session advisory lock, which is global across worker replicas.
   */
  acquireLock?: () => Promise<null | (() => Promise<void>)>;
}

export interface WeeklyReportSendSweepSummary {
  /** Offices actually swept — one whose tables or columns are not there yet is not counted. */
  offices: number;
  /** Undelivered, un-superseded, not-yet-alerted sends inside the alert window that the sweep examined. */
  candidates: number;
  /** Of those, the ones that have stopped moving. */
  stalled: number;
  /** Reports this run claimed and announced. */
  alerted: number;
  /** Stalled reports that could not be announced — no leadership roster configured. Nothing is claimed. */
  skipped: number;
  failed: number;
}

/** One undelivered send, as the sweep reads it. */
export interface StalledSendRow {
  id: string;
  weeklyReportProjectId: string;
  projectName: string;
  projectNumber: string | null;
  clientName: string | null;
  pmName: string | null;
  weekOf: string;
  version: number;
  sentAt: Date | null;
  sendLastAttemptAt: Date | null;
  sendAttempts: number;
  sendError: string | null;
}

function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return null;
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A `2026-08-13` week label, pinned at noon UTC and rendered in UTC so no offset can move the day. */
export function formatWeekOf(isoDate: string): string {
  const at = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(at);
}

/** An instant, in the timezone the office actually works in. */
export function formatBusinessTimestamp(value: Date): string {
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value)} CT`;
}

/** "43 min", "2h 05m", "3d 4h" — how long this delivery has been silent, in words. */
export function formatElapsed(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Is this send worth waking somebody for?
 *
 * Stalled (the shared, board-identical age test) AND recent enough to still be an incident rather than
 * history. Both halves read the same clock — the later of `sent_at` and `send_last_attempt_at` — so a
 * retry moves a report out of BOTH: it stops being stalled, and if it stalls again it is a fresh incident
 * inside the window rather than an old one that has aged out.
 */
export function weeklyReportSendIsAlertable(
  row: { sent_at?: unknown; send_last_attempt_at?: unknown },
  now: Date,
): boolean {
  if (!weeklyReportSendHasStalled(row, now)) return false;
  const since = weeklyReportLastSendActivityAt(row);
  if (since == null) return false;
  return now.getTime() - since.getTime() <= WEEKLY_REPORT_SEND_ALERT_MAX_AGE_HOURS * 3_600_000;
}

function isBasicValidEmail(email: string): boolean {
  if (email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const domain = email.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

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

/** Stable short digest of the report set an email covers, so the idempotency key tracks the payload. */
function alertCohortKey(reportIds: string[]): string {
  return createHash("sha256").update([...reportIds].sort().join(",")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------------------
// Email composition
// ---------------------------------------------------------------------------------------------------

/**
 * WHAT THE ROW ACTUALLY EVIDENCES, in one line.
 *
 * The two shapes an undelivered send comes in, and they need different words. With an error, somebody can
 * read what went wrong. Without one, NOTHING was written down — which is the more dangerous case and the
 * reason this feature exists: the queue dead-lettered having recorded nothing, and only the passage of
 * time says anything is wrong at all.
 */
export function sendFailureSummary(row: Pick<StalledSendRow, "sendError" | "sendAttempts">): string {
  const error = normalizeText(row.sendError);
  if (error) return error.length > 300 ? `${error.slice(0, 300)}…` : error;
  return row.sendAttempts > 0
    ? "No error recorded on the last attempt"
    : "No delivery attempt was ever recorded — the job never reported back";
}

export interface WeeklyReportSendAlertEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildWeeklyReportSendAlertEmail(input: {
  officeName: string;
  reports: StalledSendRow[];
  dashboardUrl: string;
  now: Date;
}): WeeklyReportSendAlertEmail {
  const { reports, dashboardUrl, now } = input;
  // Unreachable from the sweep, which returns before composing anything when it claims no rows. Stated
  // rather than assumed because the alternative is a TypeError inside the send try, which would classify
  // as an unknown transport outcome and roll back claims that were never announced.
  if (reports.length === 0) throw new Error("A weekly-report stall alert needs at least one report");
  const many = reports.length > 1;

  // "Delivery not confirmed", never "not delivered". `send_delivered_at` records that the mail provider
  // ACCEPTED the message, and the one path where a delivery genuinely succeeds and the stamp does not land
  // — the database going away between the provider answering and the row being updated — is
  // indistinguishable from here. Telling a director a client did not get their report, when they did, is
  // how the next four alerts get ignored.
  const subject = many
    ? `${reports.length} weekly report deliveries not confirmed`
    : `Weekly report delivery not confirmed — ${reports[0]!.projectName}`;

  const detailBlocks = reports
    .map((report) => {
      const since = weeklyReportLastSendActivityAt({
        sent_at: report.sentAt,
        send_last_attempt_at: report.sendLastAttemptAt,
      });
      const rows: Array<readonly [string, string]> = [
        ["Project", report.projectNumber ? `${report.projectName} (${report.projectNumber})` : report.projectName],
        ["Client", report.clientName ?? "—"],
        ["Week of", formatWeekOf(report.weekOf)],
        ["Project manager", report.pmName ?? "Unassigned"],
        ["Sent", report.sentAt ? formatBusinessTimestamp(report.sentAt) : "—"],
        [
          "Last attempt",
          report.sendLastAttemptAt ? formatBusinessTimestamp(report.sendLastAttemptAt) : "None recorded",
        ],
        ["Silent for", since ? formatElapsed(now.getTime() - since.getTime()) : "—"],
        ["Attempts", String(report.sendAttempts)],
        ["Last error", sendFailureSummary(report)],
      ];
      return `
              <p style="margin:18px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#111111;font-weight:bold;">${escapeHtml(
                report.projectName,
              )}${report.version > 1 ? escapeHtml(` — correction v${report.version}`) : ""}</p>${renderDetailRows(rows)}`;
    })
    .join("");

  const lead = many
    ? `${reports.length} weekly reports were sent from ${input.officeName} and the CRM has no record of the email being accepted by the mail provider.`
    : `A weekly report was sent from ${input.officeName} and the CRM has no record of the email being accepted by the mail provider.`;

  const bodyHtml = `
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;line-height:22px;color:#111111;">${escapeHtml(
                lead,
              )}</p>
              <p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;line-height:22px;color:#111111;">Nothing has moved ${escapeHtml(
                many ? "these deliveries" : "this delivery",
              )} on for more than ${WEEKLY_REPORT_SEND_STALL_MINUTES} minutes, so ${escapeHtml(
                many ? "they are" : "it is",
              )} no longer in flight. Open the weekly reports board to retry the send, or issue a correction if the report itself needs changing.</p>${detailBlocks}
              <p style="margin:22px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:19px;color:#64748b;">Delivery is recorded when the mail provider accepts the message. The CRM does not yet track bounces, so this means the CRM never saw the message accepted — not that the client definitely did or did not receive it.</p>
              <p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:19px;color:#64748b;">You are told once per stuck send. Retrying one from the board arms this alert again, so a retry that also goes quiet is reported.</p>`;

  const html = renderBrandedEmail({
    title: many ? `${reports.length} weekly report deliveries not confirmed` : "Weekly report delivery not confirmed",
    preheader: many
      ? `${reports.length} sends have gone quiet in ${input.officeName}.`
      : `${reports[0]!.projectName} — ${formatWeekOf(reports[0]!.weekOf)}`,
    bodyHtml,
    primaryLabel: "Open the weekly reports board",
    primaryUrl: dashboardUrl,
  });

  const textLines = [
    lead,
    "",
    `Nothing has moved ${many ? "these deliveries" : "this delivery"} on for more than ${WEEKLY_REPORT_SEND_STALL_MINUTES} minutes.`,
    "",
  ];
  for (const report of reports) {
    const since = weeklyReportLastSendActivityAt({
      sent_at: report.sentAt,
      send_last_attempt_at: report.sendLastAttemptAt,
    });
    textLines.push(
      `- ${report.projectName}${report.projectNumber ? ` (${report.projectNumber})` : ""}${
        report.version > 1 ? ` — correction v${report.version}` : ""
      }`,
      `  Client: ${report.clientName ?? "—"}`,
      `  Week of: ${formatWeekOf(report.weekOf)}`,
      `  Project manager: ${report.pmName ?? "Unassigned"}`,
      `  Sent: ${report.sentAt ? formatBusinessTimestamp(report.sentAt) : "—"}`,
      `  Last attempt: ${report.sendLastAttemptAt ? formatBusinessTimestamp(report.sendLastAttemptAt) : "None recorded"}`,
      `  Silent for: ${since ? formatElapsed(now.getTime() - since.getTime()) : "—"}`,
      `  Attempts: ${report.sendAttempts}`,
      `  Last error: ${sendFailureSummary(report)}`,
      "",
    );
  }
  textLines.push(
    `Open the weekly reports board: ${dashboardUrl}`,
    "",
    "Delivery is recorded when the mail provider accepts the message. The CRM does not yet track bounces, so",
    "this means the CRM never saw the message accepted — not that the client definitely did or did not receive it.",
    "",
    "You are told once per stuck send. Retrying one from the board arms this alert again.",
  );

  return { subject, html, text: textLines.join("\n") };
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

export async function runWeeklyReportSendSweep(
  deps: WeeklyReportSendSweepDeps = {},
): Promise<WeeklyReportSendSweepSummary> {
  const logger = deps.logger ?? console;
  const query = deps.query ?? (pool.query.bind(pool) as PgQuery);
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const frontendUrl = resolveFrontendUrl(env);
  const summary: WeeklyReportSendSweepSummary = {
    offices: 0,
    candidates: 0,
    stalled: 0,
    alerted: 0,
    skipped: 0,
    failed: 0,
  };

  const acquireLock = deps.acquireLock ?? (() => acquirePgAdvisoryLock(WEEKLY_REPORT_SEND_SWEEP_LOCK_KEY));
  const releaseLock = await acquireLock();
  if (!releaseLock) {
    logger.log(`${LOG} Another run holds the lock - skipping this tick`);
    return summary;
  }

  try {
    const offices = await query(`SELECT id, slug, name FROM public.offices WHERE is_active = true ORDER BY slug`);
    for (const office of offices.rows) {
      const slug = String(office.slug ?? "");
      const tenantSchema = `office_${slug}`;
      // `tenantSchema` is interpolated straight into every query below — identifiers cannot be
      // $-parametrized — so it is validated with the same guard the other weekly-report jobs use.
      if (!isSafeTenantSchema(tenantSchema)) {
        logger.error(`${LOG} Invalid office slug "${office.slug}" - skipping`);
        continue;
      }

      // Its OWN try, and not merely because a query can fail: an unguarded probe is a per-office statement
      // running outside the office's own try, so a pool-acquisition timeout on office 1 — the known
      // saturation failure mode — would throw straight out of the run and offices 2..N would never execute.
      // A FAILED probe also has to stay distinguishable in the logs from a schema that legitimately has not
      // been migrated yet: the first means the office's state is unknown (ERROR), the second is the routine
      // deploy window (INFO).
      let ready: boolean;
      try {
        ready = await officeIsReady(query, tenantSchema, logger);
      } catch (err) {
        logger.error(`${LOG} Schema probe failed - skipping office`, { tenantSchema, err });
        summary.failed += 1;
        continue;
      }
      if (!ready) continue;

      summary.offices += 1;
      try {
        await sweepOffice({
          query,
          sendEmail: deps.sendEmail ?? sendSystemEmailWithMetadata,
          logger,
          summary,
          tenantSchema,
          officeId: (office.id as string | null) ?? null,
          officeName: normalizeText(office.name) ?? slug,
          frontendUrl,
          now,
        });
      } catch (err) {
        // One broken office must not cost the others their alert. Nothing is claimed on a throw, so the
        // next tick — fifteen minutes away — retries this office from scratch.
        logger.error(`${LOG} Office sweep failed`, { tenantSchema, err });
        summary.failed += 1;
      }
    }
  } finally {
    await releaseLock().catch(() => undefined);
  }

  logger.log(`${LOG} Run complete`, summary);
  return summary;
}

/**
 * Does this office have the tables AND the columns the sweep reads?
 *
 * See REQUIRED_REPORT_COLUMNS for why the column half exists at all. Both halves log at INFO and skip: an
 * office that has never had a weekly-report project is not a fault, and neither is one whose API has not
 * yet applied 0226/0227.
 */
async function officeIsReady(
  query: PgQuery,
  tenantSchema: string,
  logger: Pick<Console, "log" | "warn" | "error">,
): Promise<boolean> {
  const tables = await query(
    `SELECT t.qualified, to_regclass(t.qualified) AS reg FROM UNNEST($1::text[]) AS t(qualified)`,
    [REQUIRED_TENANT_TABLES.map((table) => `${tenantSchema}.${table}`)],
  );
  const missingTables = tables.rows.filter((row) => row.reg == null).map((row) => String(row.qualified));
  if (missingTables.length > 0) {
    logger.log(`${LOG} Weekly-report tables not present - skipping office`, { tenantSchema, missingTables });
    return false;
  }

  const columns = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'weekly_reports' AND column_name = ANY($2::text[])`,
    [tenantSchema, [...REQUIRED_REPORT_COLUMNS]],
  );
  const present = new Set(columns.rows.map((row) => String(row.column_name)));
  const missingColumns = REQUIRED_REPORT_COLUMNS.filter((column) => !present.has(column));
  if (missingColumns.length > 0) {
    logger.log(`${LOG} Weekly-report send columns not migrated yet - skipping office`, {
      tenantSchema,
      missingColumns,
    });
    return false;
  }
  return true;
}

interface OfficeSweepArgs {
  query: PgQuery;
  sendEmail: SendEmail;
  logger: Pick<Console, "log" | "warn" | "error">;
  summary: WeeklyReportSendSweepSummary;
  tenantSchema: string;
  officeId: string | null;
  officeName: string;
  frontendUrl: string;
  now: Date;
}

async function sweepOffice(args: OfficeSweepArgs): Promise<void> {
  const { query, logger, summary, tenantSchema, now } = args;

  // THE ROW SET, and every predicate on it earns its place:
  //
  //   is_active / status='sent' / send_delivered_at IS NULL   0226's partial index — the undelivered sends.
  //   send_stall_alerted_at IS NULL                           0227's — the ones nobody has been told about.
  //   superseded_by_id IS NULL                                A report replaced by a correction is NOT a
  //                                                           delivery failure. The client has been sent
  //                                                           the newer version, and the worker refuses to
  //                                                           deliver this one at all; alerting on it would
  //                                                           send somebody to retry an email that must
  //                                                           never go out. This is the same conjunct the
  //                                                           board's undelivered query carries.
  //   wrp.is_active                                           The board's project predicate. A send whose
  //                                                           setup has been deleted is not drawn there, so
  //                                                           alerting on it would announce a failure with
  //                                                           nowhere to click.
  //   GREATEST(...) > cutoff                                  The alert window — see
  //                                                           WEEKLY_REPORT_SEND_ALERT_MAX_AGE_HOURS. This
  //                                                           is a bound on the SQL side only; the STALL
  //                                                           test itself is the shared predicate below, so
  //                                                           the threshold has exactly one implementation.
  //                                                           GREATEST ignores NULLs in Postgres and is
  //                                                           NULL only when both are, which is the same
  //                                                           "a row with neither stamp cannot be aged"
  //                                                           rule `weeklyReportLastSendActivityAt` states.
  const cutoff = new Date(now.getTime() - WEEKLY_REPORT_SEND_ALERT_MAX_AGE_HOURS * 3_600_000);
  const candidates = await query(
    `SELECT wr.id, wr.weekly_report_project_id, wr.week_of, wr.version, wr.sent_at, wr.send_error,
            wr.send_attempts, wr.send_last_attempt_at,
            wrp.property_display_name, wrp.client_name,
            d.name AS deal_name, d.project_number,
            pm.display_name AS pm_name
       FROM ${tenantSchema}.weekly_reports wr
       JOIN ${tenantSchema}.weekly_report_projects wrp
         ON wrp.id = wr.weekly_report_project_id AND wrp.is_active
       JOIN ${tenantSchema}.deals d ON d.id = wr.deal_id
       LEFT JOIN public.users pm ON pm.id = wrp.trock_pm_user_id
      WHERE wr.is_active
        AND wr.status = 'sent'
        AND wr.send_delivered_at IS NULL
        AND wr.send_stall_alerted_at IS NULL
        AND wr.superseded_by_id IS NULL
        AND GREATEST(wr.sent_at, wr.send_last_attempt_at) > $1::timestamptz
      ORDER BY wr.week_of, wrp.property_display_name, wr.version`,
    [cutoff.toISOString()],
  );
  summary.candidates += candidates.rows.length;
  if (candidates.rows.length === 0) return;

  // THE AGE TEST, in TypeScript, through the shared predicate the CRM board draws its chip from. Doing it
  // here rather than in the WHERE above is what stops the sweep and the board being two implementations of
  // "has this stopped moving" — the failure mode where an email announces a stalled send that the page it
  // links to is still calling "Sending…". The candidate set is tiny by construction, so the row cost of
  // filtering in memory is nothing.
  const stalled: StalledSendRow[] = [];
  for (const row of candidates.rows) {
    if (!weeklyReportSendIsAlertable(row, now)) continue;
    const weekOf = toIsoDate(row.week_of);
    if (weekOf == null) continue;
    stalled.push({
      id: String(row.id),
      weeklyReportProjectId: String(row.weekly_report_project_id),
      projectName: normalizeText(row.property_display_name) ?? normalizeText(row.deal_name) ?? "Untitled project",
      projectNumber: normalizeText(row.project_number),
      clientName: normalizeText(row.client_name),
      pmName: normalizeText(row.pm_name),
      weekOf,
      version: Number(row.version ?? 1),
      sentAt: toDate(row.sent_at),
      sendLastAttemptAt: toDate(row.send_last_attempt_at),
      sendAttempts: Number(row.send_attempts ?? 0),
      sendError: normalizeText(row.send_error),
    });
  }
  summary.stalled += stalled.length;
  if (stalled.length === 0) return;

  const recipients = await leadershipRecipients(query, tenantSchema);
  if (recipients.length === 0) {
    // Claim NOTHING. Burning the one alert each of these sends will ever get on an email addressed to
    // nobody is the worst possible outcome here: the report stays undelivered, the flag says somebody was
    // told, and nobody was. Leaving it unclaimed means the alert goes out the moment the roster is filled
    // in — and `leadership_recipient_emails` defaults to '{}', so a freshly migrated office is exactly the
    // shape this hits.
    //
    // WARN, not log: it means the alerting half of this feature is doing nothing for this office.
    logger.warn(`${LOG} No leadership recipients configured - stalled sends cannot be announced`, {
      tenantSchema,
      stalled: stalled.length,
    });
    summary.skipped += stalled.length;
    return;
  }

  // CLAIM FIRST, then send. A restart between the two errs toward one missed alert rather than an alert
  // every fifteen minutes; the reverse ordering means a crash after the email re-announces the same sends
  // on the next tick, forever.
  //
  // The claim re-checks every predicate the SELECT used, so a delivery, a correction or a retry that
  // landed in the milliseconds since cancels the alert rather than stamping a row that has moved on. It is
  // also what makes two replicas safe if the advisory lock is ever lost: only one UPDATE can win a row.
  const claimStamp = now.toISOString();
  const claimed = await claimAlerts(
    query,
    tenantSchema,
    stalled.map((report) => report.id),
    claimStamp,
  );
  if (claimed.size === 0) return;
  const announced = stalled.filter((report) => claimed.has(report.id));

  const email = buildWeeklyReportSendAlertEmail({
    officeName: args.officeName,
    reports: announced,
    dashboardUrl: weeklyReportDashboardUrl(args.frontendUrl, args.officeId),
    now,
  });

  let outcome: SendSystemEmailOutcome;
  let sendError: unknown = null;
  try {
    const result = await args.sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      // Keyed on the COHORT, so a re-send after an ambiguous outcome presents the same key with the same
      // payload and the provider dedupes it. A cohort that has grown by the next tick is a genuinely
      // different email and gets a different key.
      idempotencyKey: `weekly-report-stall-${tenantSchema}-${alertCohortKey([...claimed])}`,
    });
    outcome = result.outcome ?? (result.success ? "delivered" : "unknown");
  } catch (err) {
    // NOT the transport's failure path — `sendSystemEmailWithMetadata` returns rather than throwing for
    // every provider and network failure, because resend@6 catches its own fetch. What can still reach
    // here is an injected transport in a test or a bug in the send path. Either way nothing was learned
    // about delivery, so it classifies with the ambiguous cases.
    sendError = err;
    outcome = "unknown";
  }

  if (outcome === "delivered") {
    summary.alerted += announced.length;
    logger.log(`${LOG} Announced stalled weekly-report sends`, {
      tenantSchema,
      reports: announced.length,
      recipients: recipients.length,
    });
    return;
  }

  // NEITHER remaining outcome keeps its claims. `rejected` is provably undelivered. `unknown` may have
  // gone out and is released anyway, for the reason the reminder cron gives for the same decision: the
  // idempotency key is fixed by the cohort, so if the first request did reach the provider the retry
  // presents the same key and the same payload and is deduped — there is no third answer, and a retry
  // therefore cannot produce a second copy. Against that, keeping the claim on the most common transport
  // failure there is (a 5xx, a gateway 502, a pool blip — all `unknown`) would silently and permanently
  // suppress the only alert these sends will ever get.
  let released = true;
  let rollbackError: unknown = null;
  try {
    await releaseAlertClaims(query, tenantSchema, [...claimed], claimStamp);
  } catch (err) {
    released = false;
    rollbackError = err;
  }
  logger.error(
    released
      ? `${LOG} Alert send ${outcome === "rejected" ? "REJECTED" : "outcome UNKNOWN"} - claims released, the next tick retries`
      : `${LOG} Alert send failed AND the claim rollback FAILED - the reports read as already announced, so no tick will retry them`,
    {
      tenantSchema,
      reports: announced.length,
      ...(sendError == null ? {} : { err: sendError }),
      ...(released ? {} : { rollbackErr: rollbackError }),
    },
  );
  summary.failed += 1;
}

/** The roster the leadership digest already uses. One list per office, so both emails reach the same desk. */
async function leadershipRecipients(query: PgQuery, tenantSchema: string): Promise<string[]> {
  const settings = await query(
    `SELECT leadership_recipient_emails FROM ${tenantSchema}.weekly_report_settings LIMIT 1`,
  );
  const raw = settings.rows[0]?.leadership_recipient_emails;
  return dedupeEmails(
    (Array.isArray(raw) ? (raw as unknown[]) : [])
      .map((value) => normalizeText(value))
      .filter((email): email is string => email != null && isBasicValidEmail(email)),
  );
}

/**
 * Stamp the reports this run is about to announce, and return the ones it actually won.
 *
 * The WHERE is the concurrency control and the correctness check at once: `send_stall_alerted_at IS NULL`
 * means only one run can claim a row, and the rest of it means a row that was delivered, superseded or
 * retried between the SELECT and here is silently dropped instead of being announced as stuck.
 *
 * `updated_at` is deliberately NOT touched. It is the report's PDF generation marker (see pdf-artifact.ts)
 * — moving it would invalidate a published client artifact and force a full re-render, for a write that
 * records who we emailed and changes nothing a reader of the report can see.
 */
async function claimAlerts(
  query: PgQuery,
  tenantSchema: string,
  reportIds: string[],
  claimStamp: string,
): Promise<Set<string>> {
  const result = await query(
    `UPDATE ${tenantSchema}.weekly_reports
        SET send_stall_alerted_at = $2::timestamptz
      WHERE id = ANY($1::uuid[])
        AND is_active
        AND status = 'sent'
        AND send_delivered_at IS NULL
        AND send_stall_alerted_at IS NULL
        AND superseded_by_id IS NULL
      RETURNING id`,
    [reportIds, claimStamp],
  );
  return new Set(result.rows.map((row) => String(row.id)));
}

/**
 * Give the claims back after a send that did not land.
 *
 * Conditioned on the exact stamp this run wrote, so a concurrent claim — or a retry that has since re-armed
 * the alert and stalled again — cannot be cleared by somebody else's rollback.
 */
async function releaseAlertClaims(
  query: PgQuery,
  tenantSchema: string,
  reportIds: string[],
  claimStamp: string,
): Promise<void> {
  await query(
    `UPDATE ${tenantSchema}.weekly_reports
        SET send_stall_alerted_at = NULL
      WHERE id = ANY($1::uuid[]) AND send_stall_alerted_at = $2::timestamptz`,
    [reportIds, claimStamp],
  );
}
