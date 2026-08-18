import {
  formatWeeklyReportDate,
  weeklyReportScheduleValue,
  type WeeklyReportPdfContact,
  type WeeklyReportPdfData,
  type WeeklyReportPdfPhoto,
} from "./pdf.js";

// ONE view model, built once, rendered twice — as the PDF and as the page behind the client's link.
//
// The two surfaces must agree absolutely: a client who opens the link and then downloads the attachment is
// comparing them side by side, and "the web page says Melissa Garcia, the PDF says someone else" is not a
// cosmetic defect on a document whose whole job is to be the record of a week. Deriving both from this
// function means the snapshot-vs-live decision below is made in exactly one place.

/**
 * The header block frozen at send time (see buildWeeklyReportSnapshot in reports-service.ts). Typed loosely
 * on purpose: it is a jsonb column written by an earlier release, and a field that is missing from an older
 * row must degrade to null rather than throw while a client is waiting for the page.
 */
interface WeeklyReportSnapshot {
  propertyDisplayName?: string | null;
  clientName?: string | null;
  clientTeam?: Partial<Record<"doc" | "pm" | "rm" | "cm", { name?: string | null; email?: string | null } | null>>;
  trockTeam?: {
    pmUserId?: string | null;
    pmName?: string | null;
    superUserId?: string | null;
    superName?: string | null;
  } | null;
  schedule?: {
    contractDate?: string | null;
    contractDateNote?: string | null;
    projectStartDate?: string | null;
    projectStartDateNote?: string | null;
    projectCompletionDate?: string | null;
    projectCompletionDateNote?: string | null;
    projectedDurationWeeks?: number | null;
  } | null;
}

export interface WeeklyReportViewInput {
  /** The `weekly_reports` row, snake_case, straight from the driver. */
  report: Record<string, any>;
  /**
   * The LIVE `weekly_report_projects` row joined to the PM/super display names. Consulted only when the
   * report has no snapshot — i.e. it has not been sent yet.
   */
  project: Record<string, any> | null;
  /**
   * Last-resort property label when neither the snapshot nor the setup row names one.
   *
   * This is the ONE value a sent report can still read live, and only because a snapshot that recorded no
   * property name has nothing frozen to fall back to — a blank header is worse than a deal name that could
   * later be edited. The delivered PDF is immutable in storage either way; only the web page could drift.
   */
  dealName?: string | null;
  photos: WeeklyReportPdfPhoto[];
}

export interface WeeklyReportView {
  pdf: WeeklyReportPdfData;
  /** ISO `week_of`, for keys and filenames rather than for print. */
  weekOf: string;
  sentAt: string | null;
  status: string;
  /**
   * The T-Rock PM this report belongs to. Carried out separately because the expired-link page names them
   * as the person to contact, and that page renders no report at all.
   */
  trockPm: { userId: string | null; name: string | null };
  /** True when the header came from the report's own frozen copy rather than from the live setup row. */
  fromSnapshot: boolean;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return null;
}

function isoTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function integerOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** numeric(5,2) arrives as a STRING. "12.50" must print as 12.5 and "0.00" as 0, not as themselves. */
function numericLabel(value: unknown): string {
  if (value == null) return "—";
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? String(parsed) : "—";
}

const CLIENT_ROLE_LABELS: Array<["doc" | "pm" | "rm" | "cm", string]> = [
  ["doc", "DOC"],
  ["pm", "PM"],
  ["rm", "RM"],
  ["cm", "CM"],
];

/**
 * Resolve everything the two renderers print, choosing the snapshot over the live setup row whenever one
 * exists.
 *
 * THE SNAPSHOT WINS, UNCONDITIONALLY. `transitionWeeklyReport` writes it in the same statement that moves a
 * report to `sent`, so a sent report always has one — and reading the live row instead would mean swapping a
 * PM in September silently rewrote the team block, the client contacts and the contract date on every report
 * already delivered in August, including inside the PDF the client downloaded and the page behind a link
 * they may have bookmarked. A draft has no snapshot yet and reads live, which is what makes the PM's review
 * screen show the current setup.
 */
export function buildWeeklyReportView(input: WeeklyReportViewInput): WeeklyReportView {
  const report = input.report;
  const project = input.project ?? {};
  const snapshot: WeeklyReportSnapshot | null =
    report.snapshot && typeof report.snapshot === "object" ? (report.snapshot as WeeklyReportSnapshot) : null;
  const fromSnapshot = snapshot != null;

  const clientTeam: WeeklyReportPdfContact[] = CLIENT_ROLE_LABELS.map(([role, label]) => ({
    label,
    name: fromSnapshot
      ? text(snapshot?.clientTeam?.[role]?.name)
      : text(project[`client_${role}_name`]),
  }));

  const trockPmName = fromSnapshot ? text(snapshot?.trockTeam?.pmName) : text(project.trock_pm_name);
  const trockPmUserId = fromSnapshot
    ? text(snapshot?.trockTeam?.pmUserId)
    : text(project.trock_pm_user_id);
  const trockSuperName = fromSnapshot ? text(snapshot?.trockTeam?.superName) : text(project.trock_super_name);

  const schedule = fromSnapshot
    ? {
        contractDate: weeklyReportScheduleValue(
          snapshot?.schedule?.contractDate,
          snapshot?.schedule?.contractDateNote,
        ),
        projectStartDate: weeklyReportScheduleValue(
          snapshot?.schedule?.projectStartDate,
          snapshot?.schedule?.projectStartDateNote,
        ),
        projectCompletionDate: weeklyReportScheduleValue(
          snapshot?.schedule?.projectCompletionDate,
          snapshot?.schedule?.projectCompletionDateNote,
        ),
      }
    : {
        contractDate: weeklyReportScheduleValue(isoDate(project.contract_date), project.contract_date_note),
        projectStartDate: weeklyReportScheduleValue(
          isoDate(project.project_start_date),
          project.project_start_date_note,
        ),
        projectCompletionDate: weeklyReportScheduleValue(
          isoDate(project.project_completion_date),
          project.project_completion_date_note,
        ),
      };

  const weekOf = isoDate(report.week_of) ?? "";
  // The report's OWN stored duration, not the project's. It is written at submit precisely so a later
  // revision of the schedule cannot rewrite the arithmetic a client already read; falling back to the
  // snapshot (then the live row) only covers a report that never reached submit.
  const projectedWeeks =
    integerOrNull(report.projected_duration_weeks) ??
    (fromSnapshot
      ? integerOrNull(snapshot?.schedule?.projectedDurationWeeks)
      : integerOrNull(project.projected_duration_weeks));

  return {
    pdf: {
      propertyName:
        (fromSnapshot ? text(snapshot?.propertyDisplayName) : text(project.property_display_name)) ??
        text(input.dealName) ??
        "—",
      weekOfLabel: formatWeeklyReportDate(weekOf) ?? "—",
      clientName: fromSnapshot ? text(snapshot?.clientName) : text(project.client_name),
      clientTeam,
      trockTeam: [
        { label: "PM", name: trockPmName },
        { label: "SUPER", name: trockSuperName },
      ],
      workCompleted: text(report.work_completed),
      nextWeekLookAhead: text(report.next_week_look_ahead),
      issuesConcerns: text(report.issues_concerns),
      schedule: {
        ...schedule,
        completionPercent: numericLabel(report.completion_percent),
        weatherDelayDays: numericLabel(report.weather_delay_days),
      },
      duration: {
        projectedWeeks,
        remainingWeeks: integerOrNull(report.remaining_weeks),
      },
      photos: input.photos,
      version: integerOrNull(report.version) ?? 1,
      // Read here so BOTH surfaces get it from the same place. The web page used to be told separately by
      // its route while the PDF was never told at all, which is how a client could download an unmarked
      // copy of a report the page had just warned them was out of date.
      superseded: report.superseded_by_id != null,
      // The report's own content generation, so the same content always renders to the same bytes. See
      // WeeklyReportPdfData.creationDate — without a fixed value, content-addressing addresses the clock.
      // The epoch fallback only fires for a row with no updated_at, which the schema does not permit; it
      // exists so the renderer is never handed an Invalid Date.
      creationDate: toDate(report.updated_at) ?? new Date(0),
    },
    weekOf,
    sentAt: isoTimestamp(report.sent_at),
    status: String(report.status ?? "draft"),
    trockPm: { userId: trockPmUserId, name: trockPmName },
    fromSnapshot,
  };
}
