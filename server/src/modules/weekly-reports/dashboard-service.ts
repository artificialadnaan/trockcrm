import {
  weeklyReportDaysLate,
  weeklyReportExpectedWeeks,
  weeklyReportWeekOf,
  type WeeklyReportPauseInterval,
  type WeeklyReportWeekState,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import type { QueryExecutor } from "./projects-service.js";

/**
 * How many weeks of OUTSTANDING history the dashboard renders by default.
 *
 * A project set up a year ago with nothing filed would otherwise generate 52 rows of guilt, and the page
 * would spend its whole viewport on ancient history instead of this week. Anything older than the window
 * is COUNTED rather than dropped — `olderOutstandingCount` on each row group — so the page can say "and
 * 9 older" instead of silently pretending they do not exist.
 */
export const DEFAULT_OUTSTANDING_LOOKBACK_WEEKS = 26;

export interface WeeklyReportDashboardRow {
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  projectNumber: string | null;
  clientName: string | null;
  trockPmUserId: string | null;
  trockPmName: string | null;
  trockSuperUserId: string | null;
  trockSuperName: string | null;
  weekOf: string;
  /** True for the cadence week currently in flight; false for an outstanding earlier week. */
  isCurrentWeek: boolean;
  state: WeeklyReportWeekState;
  daysLate: number;
  reportId: string | null;
  reportVersion: number | null;
  sentAt: string | null;
  sendError: string | null;
  /** When the mail provider accepted it. Null on a `sent` week means it has NOT reached the client yet. */
  sendDeliveredAt: string | null;
  sendAttempts: number;
  /**
   * The week is `sent` but the client has not been proven to have received it, and the last attempt failed.
   *
   * Derived on the server so the CRM and the app cannot disagree about what "Send failed" means — the two
   * facts it combines (an error, and no delivery) are individually misleading: an error left over from a
   * failed attempt that a retry then succeeded is not a failure, and a null delivery on a send queued
   * thirty seconds ago is not one either.
   */
  sendFailed: boolean;
  /** Who the week is waiting on, in plain words — the column a director actually reads. */
  waitingOn: string | null;
  dismissalReason: string | null;
}

export interface WeeklyReportDashboard {
  asOf: string;
  rows: WeeklyReportDashboardRow[];
  /** Outstanding weeks older than the lookback window, per project id. Never silently dropped. */
  olderOutstandingCounts: Record<string, number>;
  lookbackWeeks: number;
}

function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return null;
}

function toIsoTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const REPORT_STATE_BY_STATUS: Record<string, WeeklyReportWeekState> = {
  draft: "draft",
  pending_review: "pending_review",
  approved: "approved",
  sent: "sent",
};

function waitingOnFor(row: {
  state: WeeklyReportWeekState;
  trockSuperName: string | null;
  trockPmName: string | null;
}): string | null {
  switch (row.state) {
    case "not_started":
    case "draft":
      return row.trockSuperName ?? "Unassigned superintendent";
    case "pending_review":
    case "approved":
      return row.trockPmName ?? "Unassigned PM";
    default:
      return null;
  }
}

/**
 * The dashboard's row set, GENERATED FROM THE CADENCE and left-joined against reports and dismissals.
 *
 * The generation direction is the whole design. Reading `weekly_reports` and listing what is there
 * answers "what has been written", which is the opposite of the question this page exists for — an
 * untouched week has no row, so the projects nobody has filed for would be exactly the ones that never
 * appear.
 *
 * Four queries total regardless of project count: projects, their reports, their dismissals, their
 * pauses. The join happens in memory because the expected-week set is generated in TypeScript (shared
 * with the CRM, the app and the reminder worker) rather than in SQL, and duplicating that generator as a
 * recursive CTE would be a second definition of the cadence.
 */
export async function getWeeklyReportDashboard(
  client: QueryExecutor,
  options: { asOf: string; lookbackWeeks?: number },
): Promise<WeeklyReportDashboard> {
  const asOf = options.asOf;
  // A non-integer must not reach the arithmetic below. `NaN` (from `?lookbackWeeks=abc`) survives both
  // Math.min and Math.max, makes `expected.length - NaN` NaN, and turns both loops into no-ops — the
  // board renders EMPTY, which reads as "nothing outstanding". A fractional value indexes the expected
  // array at a fraction and reads undefined.
  const requested = options.lookbackWeeks;
  const lookbackWeeks =
    requested == null || !Number.isFinite(requested)
      ? DEFAULT_OUTSTANDING_LOOKBACK_WEEKS
      : Math.max(1, Math.min(Math.trunc(requested), 260));

  const projectsResult = await client.query(
    `SELECT wrp.id, wrp.deal_id, wrp.property_display_name, wrp.client_name,
            wrp.cadence_weekday, wrp.cadence_start_date, wrp.cadence_end_date,
            wrp.trock_pm_user_id, wrp.trock_super_user_id,
            d.name AS deal_name, d.project_number,
            pm.display_name AS trock_pm_name, sup.display_name AS trock_super_name
       FROM weekly_report_projects wrp
       JOIN deals d ON d.id = wrp.deal_id
       LEFT JOIN public.users pm  ON pm.id = wrp.trock_pm_user_id
       LEFT JOIN public.users sup ON sup.id = wrp.trock_super_user_id
      WHERE wrp.is_active AND wrp.status = 'active'`,
  );
  if (projectsResult.rows.length === 0) {
    return { asOf, rows: [], olderOutstandingCounts: {}, lookbackWeeks };
  }

  const projectIds = projectsResult.rows.map((row) => row.id);

  // Only the LIVE version of each week is joined. A superseded report keeps its row for history but must
  // not decide the week's state — the correction that replaced it does.
  const reportsResult = await client.query(
    `SELECT DISTINCT ON (weekly_report_project_id, week_of)
            id, weekly_report_project_id, week_of, status, version, sent_at, send_error,
            send_delivered_at, send_attempts
       FROM weekly_reports
      WHERE weekly_report_project_id = ANY($1::uuid[])
        AND is_active
        AND superseded_by_id IS NULL
      ORDER BY weekly_report_project_id, week_of, version DESC`,
    [projectIds],
  );
  const dismissalsResult = await client.query(
    `SELECT weekly_report_project_id, week_of, reason
       FROM weekly_report_dismissals
      WHERE weekly_report_project_id = ANY($1::uuid[])`,
    [projectIds],
  );
  // Every project here is `status = 'active'`, so nothing is paused RIGHT NOW — these are the stretches
  // it was stopped for and has since come back from. Without them a project paused for six weeks returns
  // owing all six, which is the opposite of what the CRM told whoever paused it.
  const pausesResult = await client.query(
    `SELECT weekly_report_project_id, paused_from, resumed_on
       FROM weekly_report_pauses
      WHERE weekly_report_project_id = ANY($1::uuid[])
      ORDER BY weekly_report_project_id, paused_from`,
    [projectIds],
  );

  const reportByKey = new Map<string, Record<string, any>>();
  for (const row of reportsResult.rows) {
    reportByKey.set(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`, row);
  }
  const dismissalByKey = new Map<string, Record<string, any>>();
  for (const row of dismissalsResult.rows) {
    dismissalByKey.set(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`, row);
  }
  const pausesByProject = new Map<string, WeeklyReportPauseInterval[]>();
  for (const row of pausesResult.rows) {
    const intervals = pausesByProject.get(row.weekly_report_project_id) ?? [];
    intervals.push({ from: toIsoDate(row.paused_from)!, to: toIsoDate(row.resumed_on) });
    pausesByProject.set(row.weekly_report_project_id, intervals);
  }

  const rows: WeeklyReportDashboardRow[] = [];
  const olderOutstandingCounts: Record<string, number> = {};

  for (const project of projectsResult.rows) {
    const cadenceWeekday = Number(project.cadence_weekday);
    const currentWeekOf = weeklyReportWeekOf(cadenceWeekday, asOf);
    const expected = weeklyReportExpectedWeeks({
      cadenceWeekday,
      cadenceStartDate: toIsoDate(project.cadence_start_date)!,
      cadenceEndDate: toIsoDate(project.cadence_end_date),
      throughDate: currentWeekOf,
      pausedIntervals: pausesByProject.get(project.id) ?? null,
    });
    if (expected.length === 0) continue;

    const cutoffIndex = Math.max(0, expected.length - lookbackWeeks);
    let olderOutstanding = 0;
    // Weeks beyond the window still get counted when they are genuinely outstanding, so the page can
    // surface "and N older" rather than implying the backlog stops at the window edge.
    for (let i = 0; i < cutoffIndex; i += 1) {
      const key = `${project.id}|${expected[i]}`;
      const report = reportByKey.get(key);
      if (!dismissalByKey.has(key) && report?.status !== "sent") olderOutstanding += 1;
    }
    if (olderOutstanding > 0) olderOutstandingCounts[project.id] = olderOutstanding;

    for (let i = cutoffIndex; i < expected.length; i += 1) {
      const weekOf = expected[i]!;
      const key = `${project.id}|${weekOf}`;
      const report = reportByKey.get(key);
      const dismissal = dismissalByKey.get(key);
      const isCurrentWeek = weekOf === currentWeekOf;

      const state: WeeklyReportWeekState = report
        ? REPORT_STATE_BY_STATUS[report.status] ?? "not_started"
        : dismissal
          ? "dismissed"
          : "not_started";

      // A `sent` report whose email never reached the client is NOT settled. It is the one failure this
      // feature has no other way of surfacing — nobody is waiting on it, the super has finished, and the
      // client is simply never going to receive their report. Dropping it with the rest of the archive
      // was how a send that failed three weeks ago became invisible on the page that exists to catch it.
      const sendFailed =
        state === "sent" && report != null && report.send_delivered_at == null && report.send_error != null;

      // A settled week that is not the current one carries no signal — drop it so the page shows what
      // needs attention rather than an ever-growing archive. History lives on the History tab.
      if (!isCurrentWeek && (state === "sent" || state === "dismissed") && !sendFailed) continue;

      const base = {
        trockSuperName: project.trock_super_name ?? null,
        trockPmName: project.trock_pm_name ?? null,
      };
      rows.push({
        weeklyReportProjectId: project.id,
        dealId: project.deal_id,
        projectName: project.property_display_name ?? project.deal_name ?? "Untitled project",
        projectNumber: project.project_number ?? null,
        clientName: project.client_name ?? null,
        trockPmUserId: project.trock_pm_user_id ?? null,
        trockSuperUserId: project.trock_super_user_id ?? null,
        ...base,
        weekOf,
        isCurrentWeek,
        state,
        daysLate: state === "sent" || state === "dismissed" ? 0 : weeklyReportDaysLate(weekOf, asOf),
        reportId: report?.id ?? null,
        reportVersion: report ? Number(report.version) : null,
        sentAt: toIsoTimestamp(report?.sent_at),
        sendError: report?.send_error ?? null,
        sendDeliveredAt: toIsoTimestamp(report?.send_delivered_at),
        sendAttempts: Number(report?.send_attempts ?? 0),
        sendFailed,
        // A failed send is waiting on the PM to retry it. Left null, the column read "—" on the one row
        // on the board that needs a person.
        waitingOn: sendFailed ? (base.trockPmName ?? "Unassigned PM") : waitingOnFor({ state, ...base }),
        dismissalReason: dismissal?.reason ?? null,
      });
    }
  }

  // Most overdue first, then SOONEST DUE, then alphabetical. The middle term matters: before their
  // deadlines every row has daysLate === 0, so falling straight to the name would put a Saturday
  // report above one due tomorrow purely because of how it is spelled.
  rows.sort(
    (a, b) =>
      b.daysLate - a.daysLate ||
      a.weekOf.localeCompare(b.weekOf) ||
      a.projectName.localeCompare(b.projectName),
  );

  return { asOf, rows, olderOutstandingCounts, lookbackWeeks };
}

export interface WeeklyReportProjectSummary {
  weeklyReportProjectId: string;
  reportsSent: number;
  lastSentAt: string | null;
  lastSentWeekOf: string | null;
  /** Null when reporting has stopped — paused, completed, or past its cadence end date. */
  nextDueWeekOf: string | null;
}

/** Per-project counters for the Projects tab. One query, aggregated in SQL. */
export async function listWeeklyReportProjectSummaries(
  client: QueryExecutor,
  asOf: string,
): Promise<WeeklyReportProjectSummary[]> {
  const result = await client.query(
    `SELECT wrp.id,
            wrp.cadence_weekday,
            wrp.cadence_start_date,
            wrp.cadence_end_date,
            wrp.status,
            COUNT(wr.id) FILTER (WHERE wr.status = 'sent')::int AS reports_sent,
            MAX(wr.sent_at) FILTER (WHERE wr.status = 'sent')   AS last_sent_at,
            MAX(wr.week_of) FILTER (WHERE wr.status = 'sent')   AS last_sent_week_of
       FROM weekly_report_projects wrp
       LEFT JOIN weekly_reports wr
              ON wr.weekly_report_project_id = wrp.id AND wr.is_active
      WHERE wrp.is_active
      GROUP BY wrp.id, wrp.cadence_weekday, wrp.cadence_start_date, wrp.cadence_end_date, wrp.status`,
  );

  return result.rows.map((row) => {
    // A paused, completed or past-its-end-date project owes nothing. Printing a next-due date for one
    // would contradict the board, which excludes it from the cadence entirely.
    //
    // Computed from the LATER of today and the cadence start, so a setup that begins next month reports
    // its first real obligation rather than a date inside a window that has not opened — the board
    // correctly generates nothing for that date, and the two must not disagree.
    const startDate = toIsoDate(row.cadence_start_date)!;
    const anchor = startDate > asOf ? startDate : asOf;
    const nextDue = weeklyReportWeekOf(Number(row.cadence_weekday), anchor);
    const endDate = toIsoDate(row.cadence_end_date);
    const stopped = row.status !== "active" || (endDate != null && nextDue > endDate);

    return {
      weeklyReportProjectId: row.id,
      reportsSent: Number(row.reports_sent ?? 0),
      lastSentAt: toIsoTimestamp(row.last_sent_at),
      lastSentWeekOf: toIsoDate(row.last_sent_week_of),
      nextDueWeekOf: stopped ? null : nextDue,
    };
  });
}

/**
 * Write off a week that was genuinely missed.
 *
 * Validated rather than trusted, because an unchecked insert lets a caller PRE-dismiss a future date:
 * the week later enters the generated board already settled, having never been missed and never been
 * anybody's problem. That is exactly the accountability the ledger exists to create, so the three
 * conditions below are the feature, not defensive noise — the week must be a real cadence date for
 * this project, it must already be due, and it must not already have a live report.
 */
export async function dismissWeeklyReportWeek(
  client: QueryExecutor,
  input: {
    weeklyReportProjectId: string;
    weekOf: string;
    reason: string;
    actorUserId: string;
    asOf: string;
  },
): Promise<void> {
  const projectResult = await client.query(
    `SELECT cadence_weekday, cadence_start_date, cadence_end_date
       FROM weekly_report_projects WHERE id = $1::uuid AND is_active LIMIT 1`,
    [input.weeklyReportProjectId],
  );
  const project = projectResult.rows[0];
  if (!project) throw new AppError(404, "Weekly report project not found");

  const cadenceWeekday = Number(project.cadence_weekday);
  if (weeklyReportWeekOf(cadenceWeekday, input.weekOf) !== input.weekOf) {
    throw new AppError(400, "That date is not one of this project's reporting days");
  }
  const start = toIsoDate(project.cadence_start_date)!;
  const end = toIsoDate(project.cadence_end_date);
  if (input.weekOf < start || (end && input.weekOf > end)) {
    throw new AppError(400, "That week falls outside this project's reporting window");
  }
  if (input.weekOf > input.asOf) {
    throw new AppError(400, "A future week cannot be dismissed before it is due");
  }

  const existing = await client.query(
    `SELECT id FROM weekly_reports
      WHERE weekly_report_project_id = $1::uuid AND week_of = $2::date AND is_active
      LIMIT 1`,
    [input.weeklyReportProjectId, input.weekOf],
  );
  if (existing.rows[0]) {
    throw new AppError(409, "That week already has a report — finish or discard it instead");
  }
  // ON CONFLICT DO UPDATE rather than DO NOTHING: re-dismissing a week with a better reason should
  // replace the note, not silently keep the first one somebody typed.
  await client.query(
    `INSERT INTO weekly_report_dismissals (weekly_report_project_id, week_of, reason, dismissed_by)
     VALUES ($1::uuid, $2::date, $3, $4::uuid)
     ON CONFLICT (weekly_report_project_id, week_of) DO UPDATE
        SET reason = EXCLUDED.reason,
            dismissed_by = EXCLUDED.dismissed_by,
            dismissed_at = now()`,
    [input.weeklyReportProjectId, input.weekOf, input.reason, input.actorUserId],
  );
}
