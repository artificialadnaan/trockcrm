// Weekly Reports — the ONE definition of the feature's status ladder and cadence arithmetic.
//
// This lives in `shared` rather than in the server because FOUR surfaces need identical answers: the CRM
// dashboard generates expected weeks, T-Rock Cam stamps `week_of` on a draft, the API validates it, and
// the worker decides who to remind. A second implementation anywhere produces a report filed under a
// week the dashboard is not looking for.
//
// DATE ARITHMETIC. Every function here operates on YYYY-MM-DD strings and parses them at UTC NOON, the
// same technique as server/src/lib/period.ts. Anchoring at noon means adding or subtracting days can
// never trip a DST midnight boundary, and never touching the local timezone means a laptop in Karachi
// and a worker in Railway's UTC container compute the same due date. Do NOT "simplify" these to
// `new Date(iso)` — that parses as UTC midnight and then reads back in local time, which is off by a day
// for every user west of Greenwich.

/** Report lifecycle. A strict ladder — see `canTransitionWeeklyReport`. */
export const WEEKLY_REPORT_STATUSES = ["draft", "pending_review", "approved", "sent"] as const;
export type WeeklyReportStatus = (typeof WEEKLY_REPORT_STATUSES)[number];

/** Setup-row lifecycle. `paused` stops cadence generation without destroying history. */
export const WEEKLY_REPORT_PROJECT_STATUSES = ["active", "paused", "completed"] as const;
export type WeeklyReportProjectStatus = (typeof WEEKLY_REPORT_PROJECT_STATUSES)[number];

/**
 * Reminder kinds, matching the `weekly_report_reminders_sent.kind` CHECK (widened by migration 0229).
 *
 * `rep_escalation` is scheduled on a DIFFERENT AXIS from the other three, which is why the lead-day
 * table below no longer covers this whole union — see WEEKLY_REPORT_LEAD_DAY_REMINDER_KINDS.
 */
export const WEEKLY_REPORT_REMINDER_KINDS = [
  "t_minus_2",
  "t_minus_1",
  "due_digest",
  "rep_escalation",
] as const;
export type WeeklyReportReminderKind = (typeof WEEKLY_REPORT_REMINDER_KINDS)[number];

/**
 * The kinds selected by HOW MANY DAYS ARE LEFT until the report is due.
 *
 * `rep_escalation` is deliberately absent. It fires on the due day, like `due_digest`, but is chosen by
 * the CLOCK — 17:00 CT, after the day's 07:00/09:00/11:00 ticks have been and gone. Putting it in the
 * offset table below would give two kinds an offset of 0, and `reminderKindForLeadDays` returns the
 * FIRST match: the due-day digest and the evening escalation would become the same slot, and whichever
 * lost the iteration order would silently never fire again.
 *
 * Two axes, two lists. The full union above is what the database constrains; this narrower one is what
 * the day scheduler may choose from.
 */
export const WEEKLY_REPORT_LEAD_DAY_REMINDER_KINDS = [
  "t_minus_2",
  "t_minus_1",
  "due_digest",
] as const satisfies readonly WeeklyReportReminderKind[];
export type WeeklyReportLeadDayReminderKind = (typeof WEEKLY_REPORT_LEAD_DAY_REMINDER_KINDS)[number];

/**
 * What the dashboard shows for one expected week. `not_started` and `dismissed` are NOT report statuses —
 * neither has a `weekly_reports` row — which is exactly why the dashboard's row set is generated from the
 * cadence and left-joined, rather than read out of the reports table.
 */
export const WEEKLY_REPORT_WEEK_STATES = [
  "not_started",
  "draft",
  "pending_review",
  "approved",
  "sent",
  "dismissed",
] as const;
export type WeeklyReportWeekState = (typeof WEEKLY_REPORT_WEEK_STATES)[number];

/** How many days of photos the picker offers, ending on `week_of` inclusive. */
export const WEEKLY_REPORT_PHOTO_WINDOW_DAYS = 14;

/**
 * Longest one narrative section may be — the API's validation limit AND the ceiling both renderers honour.
 *
 * Shared because the PDF and the public web page are the SAME document seen two ways, and a client compares
 * them side by side. A renderer with a tighter cap of its own silently prints less than the page does, on
 * the surface the client is most likely to forward.
 */
export const WEEKLY_REPORT_SECTION_MAX_CHARS = 20_000;

/**
 * Longest one photo caption may be — the API's validation limit AND the ceiling both renderers honour.
 *
 * Shared for the same reason as the section limit, and it was missed the first time round: the API accepted
 * 500 characters and the picker pre-fills a caption from the file's description, while the PDF drew the
 * caption into a fixed two-line box with `ellipsis: true`. A 250-character caption therefore printed in
 * full on the client's web page and as two lines and an ellipsis in the PDF attached to the same email.
 *
 * 250 rather than 500 because the caption shares its cell with the photograph it describes. Measured
 * against the shipped 8pt Geist in the 218.67pt photo cell: 250 characters of ordinary prose is ~5 lines
 * (57pt), 250 of the widest glyph in the font is 9 lines (103pt), and the true worst case — 250 characters
 * of 15-wide words, every line breaking early — is 171pt, which the renderer prints by stepping the caption
 * down a size or two rather than truncating it (see photoCaptionLayout). At 500 characters that worst case
 * is ~340pt, more than the whole cell, and no font step recovers it.
 */
export const WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS = 250;

/**
 * Most photos one report may carry — the API's validation limit AND the ceiling the render budget is sized
 * from.
 *
 * Shared because those two must move together: the render is all-or-nothing and its deadline is
 * `base + per-photo × count`, so a cap raised here without the budget following makes a full report
 * PERMANENTLY undownloadable rather than merely slow. See weeklyReportRenderTimeoutMs.
 */
export const WEEKLY_REPORT_MAX_PHOTOS = 60;

/** Days before the due date that each reminder fires. `due_digest` fires ON the due date. */
export const WEEKLY_REPORT_REMINDER_OFFSET_DAYS: Record<WeeklyReportLeadDayReminderKind, number> = {
  t_minus_2: 2,
  t_minus_1: 1,
  due_digest: 0,
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  // Rejects shaped-but-impossible dates like 2026-02-30, which pass the regex and then silently roll
  // over into March when parsed.
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertIsoDate(value: string, label: string): void {
  if (!isIsoDateString(value)) {
    throw new RangeError(`${label} must be a YYYY-MM-DD date, received ${JSON.stringify(value)}`);
  }
}

/** Calendar day arithmetic on YYYY-MM-DD. DST-safe (UTC-noon anchored), date-only. */
export function shiftIsoDate(isoDate: string, days: number): string {
  assertIsoDate(isoDate, "isoDate");
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Day of week for a YYYY-MM-DD date. 0=Sunday .. 6=Saturday, matching Postgres EXTRACT(DOW). */
export function isoDateWeekday(isoDate: string): number {
  assertIsoDate(isoDate, "isoDate");
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

/** Whole days from `from` to `to` (negative when `to` precedes `from`). */
export function daysBetweenIsoDates(from: string, to: string): number {
  assertIsoDate(from, "from");
  assertIsoDate(to, "to");
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function assertWeekday(cadenceWeekday: number): void {
  if (!Number.isInteger(cadenceWeekday) || cadenceWeekday < 0 || cadenceWeekday > 6) {
    throw new RangeError(`cadenceWeekday must be an integer 0-6, received ${cadenceWeekday}`);
  }
}

/**
 * The `week_of` a report being prepared on `onDate` belongs to: the first cadence weekday ON OR AFTER
 * `onDate`.
 *
 * Cadence Thursday, asked on Monday the 10th → the 13th, the report the super is currently working on.
 * Asked ON Thursday the 13th → the 13th, because the report is due today and is not yet late. Asked on
 * Friday the 14th → the 20th; the 13th has become an OUTSTANDING past week rather than the current one,
 * which is what keeps a missed week visible instead of being silently absorbed into the next.
 */
export function weeklyReportWeekOf(cadenceWeekday: number, onDate: string): string {
  assertWeekday(cadenceWeekday);
  const delta = (cadenceWeekday - isoDateWeekday(onDate) + 7) % 7;
  return shiftIsoDate(onDate, delta);
}

/**
 * One stretch during which the project was not reporting — `weekly_report_pauses`. `to` is null while
 * reporting is still stopped.
 */
export interface WeeklyReportPauseInterval {
  from: string;
  to: string | null;
}

/**
 * Was this cadence date inside a stretch when reporting was stopped?
 *
 * HALF-OPEN, [from, to). A week falling on the day reporting stopped is not owed — pausing is a decision
 * about the weeks still ahead — while a week falling on the day it resumed is. The asymmetry is the
 * point: pausing must never act as an amnesty for the weeks already missed BEFORE it, which is exactly
 * what an inclusive lower bound plus a backdated pause would buy.
 */
export function isWeeklyReportWeekPaused(
  weekOf: string,
  pausedIntervals: ReadonlyArray<WeeklyReportPauseInterval> | null | undefined,
): boolean {
  if (!pausedIntervals || pausedIntervals.length === 0) return false;
  return pausedIntervals.some(
    (interval) =>
      daysBetweenIsoDates(interval.from, weekOf) >= 0 &&
      (interval.to == null || daysBetweenIsoDates(weekOf, interval.to) > 0),
  );
}

/**
 * Every `week_of` this project is expected to produce, from its cadence start through `throughDate`
 * (clamped by `cadenceEndDate` when set, and skipping any stretch reporting was paused for). Ascending.
 *
 * This is the dashboard's row set. A returned week with neither a report nor a dismissal is
 * "not_started" and keeps aging — reading `weekly_reports` alone would make an untouched week invisible,
 * which is precisely the case the page exists to surface.
 *
 * `pausedIntervals` is what keeps the CRM's promise that a paused project stops generating weeks true
 * after it comes back: `status` describes only where the setup stands today, so without the intervals a
 * resumed project is billed for every week it spent stopped. The weeks missed BEFORE the pause are
 * untouched by this and stay outstanding.
 */
export function weeklyReportExpectedWeeks(input: {
  cadenceWeekday: number;
  cadenceStartDate: string;
  cadenceEndDate?: string | null;
  throughDate: string;
  pausedIntervals?: ReadonlyArray<WeeklyReportPauseInterval> | null;
}): string[] {
  assertWeekday(input.cadenceWeekday);
  const last = input.cadenceEndDate
    ? minIsoDate(input.cadenceEndDate, input.throughDate)
    : input.throughDate;
  // Clamp before generating: an end date in the past, or a cadence that has not started, yields nothing
  // rather than a backwards range.
  if (daysBetweenIsoDates(input.cadenceStartDate, last) < 0) return [];

  const weeks: string[] = [];
  let cursor = weeklyReportWeekOf(input.cadenceWeekday, input.cadenceStartDate);
  while (daysBetweenIsoDates(cursor, last) >= 0) {
    if (!isWeeklyReportWeekPaused(cursor, input.pausedIntervals)) weeks.push(cursor);
    cursor = shiftIsoDate(cursor, 7);
  }
  return weeks;
}

function minIsoDate(a: string, b: string): string {
  // daysBetweenIsoDates(a, b) is b - a, so a positive result means `a` is the earlier date.
  return daysBetweenIsoDates(a, b) >= 0 ? a : b;
}

/**
 * The photo window offered by the picker: the 14 days ENDING ON `week_of`, inclusive at both ends.
 *
 * Anchored on `week_of` rather than on "today" deliberately. A report filed four days late must still
 * show the photos from the week it covers, not the days since.
 */
export function weeklyReportPhotoWindow(weekOf: string): { from: string; to: string } {
  return { from: shiftIsoDate(weekOf, -(WEEKLY_REPORT_PHOTO_WINDOW_DAYS - 1)), to: weekOf };
}

/**
 * Weeks left on the schedule as of `weekOf`, floored at 0.
 *
 * A project with no start date has not begun, so its FULL projected duration remains. (The reference PDF
 * prints Remaining 0 alongside Projected 19 for a project whose start is "TBD Permit" — that is a blank
 * cell in the spreadsheet it came from, not a rule. Reporting 0 weeks remaining on a job that has not
 * broken ground would be wrong on the one number a client reads first.)
 *
 * Returns null only when there is no projected duration to subtract from.
 */
export function weeklyReportRemainingWeeks(input: {
  projectedDurationWeeks: number | null | undefined;
  projectStartDate: string | null | undefined;
  weekOf: string;
}): number | null {
  const projected = input.projectedDurationWeeks;
  if (projected == null || !Number.isFinite(projected)) return null;
  if (!input.projectStartDate) return Math.max(0, Math.trunc(projected));

  const elapsedDays = daysBetweenIsoDates(input.projectStartDate, input.weekOf);
  // Before the start date nothing has elapsed; a negative elapsed would otherwise INFLATE remaining
  // past the projected duration.
  const elapsedWeeks = elapsedDays <= 0 ? 0 : Math.floor(elapsedDays / 7);
  return Math.max(0, Math.trunc(projected) - elapsedWeeks);
}

/**
 * Legal status transitions. The PM gate is mandatory: nothing reaches `sent` without passing through
 * `approved`, and `approved` is only reachable from `pending_review`.
 *
 * `draft -> approved` is deliberately absent even for a PM authoring their own report — the service
 * walks such a report through `pending_review` in one call so that `submitted_at` is always populated
 * and the audit trail reads the same regardless of who wrote it.
 */
const WEEKLY_REPORT_TRANSITIONS: Record<WeeklyReportStatus, readonly WeeklyReportStatus[]> = {
  draft: ["pending_review"],
  // Sent back for rework by the PM, or resubmitted after edits.
  pending_review: ["draft", "approved"],
  // A PM who approves and then spots something can drop it back into review before it goes out.
  approved: ["pending_review", "sent"],
  // Terminal. Corrections are a NEW version, never a mutation of a report a client already received.
  sent: [],
};

export function canTransitionWeeklyReport(
  from: WeeklyReportStatus,
  to: WeeklyReportStatus,
): boolean {
  return WEEKLY_REPORT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function weeklyReportNextStatuses(from: WeeklyReportStatus): readonly WeeklyReportStatus[] {
  return WEEKLY_REPORT_TRANSITIONS[from] ?? [];
}

export function isWeeklyReportStatus(value: unknown): value is WeeklyReportStatus {
  return typeof value === "string" && (WEEKLY_REPORT_STATUSES as readonly string[]).includes(value);
}

const WEEK_STATE_LABELS: Record<WeeklyReportWeekState, string> = {
  not_started: "Not started",
  draft: "With super",
  pending_review: "Pending PM review",
  approved: "Approved, not sent",
  sent: "Sent",
  dismissed: "Dismissed",
};

export function weeklyReportWeekStateLabel(state: WeeklyReportWeekState): string {
  return WEEK_STATE_LABELS[state] ?? state;
}

/** How late an outstanding week is, as of `today`. 0 when it is not yet past due. */
export function weeklyReportDaysLate(weekOf: string, today: string): number {
  return Math.max(0, daysBetweenIsoDates(weekOf, today));
}
