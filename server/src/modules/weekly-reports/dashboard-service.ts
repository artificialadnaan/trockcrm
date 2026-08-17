import {
  weeklyReportDaysLate,
  weeklyReportExpectedWeeks,
  weeklyReportWeekOf,
  type WeeklyReportWeekState,
} from "@trock-crm/shared/types";
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
 * Three queries total regardless of project count: projects, their reports, their dismissals. The join
 * happens in memory because the expected-week set is generated in TypeScript (shared with the CRM, the
 * app and the reminder worker) rather than in SQL, and duplicating that generator as a recursive CTE
 * would be a second definition of the cadence.
 */
export async function getWeeklyReportDashboard(
  client: QueryExecutor,
  options: { asOf: string; lookbackWeeks?: number },
): Promise<WeeklyReportDashboard> {
  const asOf = options.asOf;
  const lookbackWeeks = Math.max(1, Math.min(options.lookbackWeeks ?? DEFAULT_OUTSTANDING_LOOKBACK_WEEKS, 260));

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
            id, weekly_report_project_id, week_of, status, version, sent_at, send_error
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

  const reportByKey = new Map<string, Record<string, any>>();
  for (const row of reportsResult.rows) {
    reportByKey.set(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`, row);
  }
  const dismissalByKey = new Map<string, Record<string, any>>();
  for (const row of dismissalsResult.rows) {
    dismissalByKey.set(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`, row);
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

      // A settled week that is not the current one carries no signal — drop it so the page shows what
      // needs attention rather than an ever-growing archive. History lives on the History tab.
      if (!isCurrentWeek && (state === "sent" || state === "dismissed")) continue;

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
        waitingOn: waitingOnFor({ state, ...base }),
        dismissalReason: dismissal?.reason ?? null,
      });
    }
  }

  // Most overdue first, then the projects with the most at stake this week. A director opens this page
  // to find what is broken, not to browse alphabetically.
  rows.sort((a, b) => b.daysLate - a.daysLate || a.projectName.localeCompare(b.projectName));

  return { asOf, rows, olderOutstandingCounts, lookbackWeeks };
}

export interface WeeklyReportProjectSummary {
  weeklyReportProjectId: string;
  reportsSent: number;
  lastSentAt: string | null;
  lastSentWeekOf: string | null;
  nextDueWeekOf: string;
}

/** Per-project counters for the Projects tab. One query, aggregated in SQL. */
export async function listWeeklyReportProjectSummaries(
  client: QueryExecutor,
  asOf: string,
): Promise<WeeklyReportProjectSummary[]> {
  const result = await client.query(
    `SELECT wrp.id,
            wrp.cadence_weekday,
            COUNT(wr.id) FILTER (WHERE wr.status = 'sent')::int AS reports_sent,
            MAX(wr.sent_at) FILTER (WHERE wr.status = 'sent')   AS last_sent_at,
            MAX(wr.week_of) FILTER (WHERE wr.status = 'sent')   AS last_sent_week_of
       FROM weekly_report_projects wrp
       LEFT JOIN weekly_reports wr
              ON wr.weekly_report_project_id = wrp.id AND wr.is_active
      WHERE wrp.is_active
      GROUP BY wrp.id, wrp.cadence_weekday`,
  );

  return result.rows.map((row) => ({
    weeklyReportProjectId: row.id,
    reportsSent: Number(row.reports_sent ?? 0),
    lastSentAt: toIsoTimestamp(row.last_sent_at),
    lastSentWeekOf: toIsoDate(row.last_sent_week_of),
    nextDueWeekOf: weeklyReportWeekOf(Number(row.cadence_weekday), asOf),
  }));
}

export async function dismissWeeklyReportWeek(
  client: QueryExecutor,
  input: { weeklyReportProjectId: string; weekOf: string; reason: string; actorUserId: string },
): Promise<void> {
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
