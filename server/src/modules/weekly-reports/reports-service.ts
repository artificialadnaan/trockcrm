import {
  WEEKLY_REPORT_DELETE_REASON_MAX_CHARS,
  WEEKLY_REPORT_MAX_PHOTOS,
  WEEKLY_REPORT_MAX_WEATHER_DELAY_DAYS,
  WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS,
  WEEKLY_REPORT_SECTION_MAX_CHARS,
  canTransitionWeeklyReport,
  isIsoDateString,
  isWeeklyReportStatus,
  weeklyReportPhotoWindow,
  weeklyReportRemainingWeeks,
  weeklyReportWeekOf,
  type WeeklyReportStatus,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import {
  getWeeklyReportProject,
  getWeeklyReportProjectRow,
  type QueryExecutor,
  type WeeklyReportProject,
} from "./projects-service.js";

/** Who is acting. `role` only ever GRANTS extra power (admin/director); it never removes assignment rights. */
export interface WeeklyReportActor {
  id: string;
  role: string;
}

const ELEVATED_ROLES = new Set(["admin", "director"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WeeklyReportPhoto {
  fileId: string;
  /** Report-specific. Defaults to the file's own description but never writes back to it. */
  caption: string | null;
  /** The capture-time description, sent so the UI can show what the caption was derived from. */
  originalDescription: string | null;
  sortOrder: number;
  takenAt: string | null;
  mimeType: string | null;
}

export interface WeeklyReportDetail {
  id: string;
  weeklyReportProjectId: string;
  dealId: string;
  weekOf: string;
  version: number;
  supersededById: string | null;
  status: WeeklyReportStatus;
  workCompleted: string | null;
  nextWeekLookAhead: string | null;
  issuesConcerns: string | null;
  completionPercent: number | null;
  weatherDelayDays: number | null;
  remainingWeeks: number | null;
  projectedDurationWeeks: number | null;
  /**
   * The report this week's starting values were carried from, or null.
   *
   * Set at draft creation and cleared the moment somebody edits the carried section. The phone reads it
   * to label Work Completed as last week's PLAN rather than a record of what happened — a distinction
   * that matters because the send gate only checks that the section is non-empty, and carried text
   * satisfies that check without anybody having written it.
   */
  carriedFromReportId: string | null;
  snapshot: Record<string, unknown> | null;
  authoredBy: string | null;
  authoredByName: string | null;
  authoredAt: string | null;
  /**
   * WHO, not just when. These three are the questions somebody opens a past week to answer — "who sent
   * this", "who signed off on it" — and until now the only surface that could answer them was the
   * per-project audit endpoint. A report's own detail could describe what was written and not one
   * person who handled it.
   */
  submittedByName: string | null;
  submittedAt: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  sentByName: string | null;
  sentAt: string | null;
  sendError: string | null;
  sendAttempts: number;
  /**
   * When the mail provider ACCEPTED the message — a different fact from `sentAt`, which is stamped when
   * the PM commits. Null on a `sent` report means the delivery is still in flight or has failed, which is
   * exactly the state the dashboard's "Send failed" chip exists to surface.
   *
   * AND NOTHING MORE THAN THAT, STILL. Acceptance is not delivery: a report addressed to `jay@examle.com`
   * is accepted, hard-bounces, and this field goes on reading as though it landed. That is not a defect in
   * the field, it is its meaning — the provider's later verdict lands in `sendDeliveryStatus` below, and
   * migration 0227 deliberately did NOT redefine this one, because the board, the History chip, the retry
   * gate and `weekly_reports_send_undelivered_idx` all read it as "handed over successfully" and are right
   * to. Read the two together to answer "did the client get it".
   */
  sendDeliveredAt: string | null;
  /**
   * What the provider said AFTERWARDS, on its delivery webhook (0227):
   * `delayed | delivered | complained | failed | bounced`, or null while nothing has spoken for the send.
   *
   * Null is the permanent state of every send made before that webhook existed, and of every send in an
   * environment where the webhook is not configured — so a null here means "unknown", never "fine".
   */
  sendDeliveryStatus: string | null;
  /** THE PROVIDER'S timestamp for the event behind `sendDeliveryStatus`, not the time we received it. */
  sendDeliveryStatusAt: string | null;
  /** Bounce class (hard/soft), the provider's own type/subtype and its message, verbatim. */
  sendDeliveryDetail: Record<string, unknown> | null;
  sendLastAttemptAt: string | null;
  pdfAvailable: boolean;
  photos: WeeklyReportPhoto[];
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

// numeric(5,2) arrives from node-postgres as a STRING, because JS numbers cannot represent every
// numeric exactly. Number() here is safe for a 0-100 two-decimal value and keeps the API contract a
// number rather than leaking "42.00" to four clients.
function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapReportRow(row: Record<string, any>, photos: WeeklyReportPhoto[]): WeeklyReportDetail {
  return {
    id: row.id,
    weeklyReportProjectId: row.weekly_report_project_id,
    dealId: row.deal_id,
    weekOf: toIsoDate(row.week_of)!,
    version: Number(row.version),
    supersededById: row.superseded_by_id ?? null,
    status: row.status,
    workCompleted: row.work_completed ?? null,
    nextWeekLookAhead: row.next_week_look_ahead ?? null,
    issuesConcerns: row.issues_concerns ?? null,
    completionPercent: toNumberOrNull(row.completion_percent),
    weatherDelayDays: row.weather_delay_days ?? null,
    remainingWeeks: row.remaining_weeks ?? null,
    projectedDurationWeeks: row.projected_duration_weeks ?? null,
    carriedFromReportId: row.carried_from_report_id ?? null,
    snapshot: row.snapshot ?? null,
    authoredBy: row.authored_by ?? null,
    authoredByName: row.authored_by_name ?? null,
    authoredAt: toIsoTimestamp(row.authored_at),
    submittedByName: row.submitted_by_name ?? null,
    submittedAt: toIsoTimestamp(row.submitted_at),
    reviewedByName: row.reviewed_by_name ?? null,
    reviewedAt: toIsoTimestamp(row.reviewed_at),
    sentByName: row.sent_by_name ?? null,
    sentAt: toIsoTimestamp(row.sent_at),
    sendError: row.send_error ?? null,
    sendAttempts: Number(row.send_attempts ?? 0),
    sendDeliveredAt: toIsoTimestamp(row.send_delivered_at),
    sendDeliveryStatus: row.send_delivery_status ?? null,
    sendDeliveryStatusAt: toIsoTimestamp(row.send_delivery_status_at),
    sendDeliveryDetail: (row.send_delivery_detail ?? null) as Record<string, unknown> | null,
    sendLastAttemptAt: toIsoTimestamp(row.send_last_attempt_at),
    pdfAvailable: Boolean(row.pdf_r2_key),
    photos,
  };
}

/**
 * The three extra joins are the WHO of a report, and they were missing.
 *
 * `authored_by` alone answers "who typed it", which is the least contested fact about a weekly report.
 * The questions people actually arrive with — who submitted it, who approved it, who pressed send —
 * were readable only through the per-project audit endpoint, so the History tab could show a week's
 * contents and not one name attached to them.
 *
 * AND THE PROJECT'S TWO ASSIGNMENT SLOTS, aliased so they cannot collide with `wr.*`.
 *
 * Every permission predicate in this module takes a project row alongside the report row — a report on
 * its own cannot say who the assigned superintendent is. `listWeeklyReports` had no such row and
 * therefore could not answer "may this person edit this?" for the History list at all; the alternative
 * was a second query per row, or the client re-deriving authorisation from a role string, which is how
 * a button that 403s gets shipped. LEFT JOIN on a primary key, so it costs the detail read nothing.
 */
const REPORT_SELECT = `
  SELECT wr.*,
         author.display_name    AS authored_by_name,
         submitter.display_name AS submitted_by_name,
         reviewer.display_name  AS reviewed_by_name,
         sender.display_name    AS sent_by_name,
         wrp.trock_super_user_id AS project_trock_super_user_id,
         wrp.trock_pm_user_id    AS project_trock_pm_user_id,
         wrp.is_active           AS project_is_active
    FROM weekly_reports wr
    LEFT JOIN public.users author    ON author.id    = wr.authored_by
    LEFT JOIN public.users submitter ON submitter.id = wr.submitted_by
    LEFT JOIN public.users reviewer  ON reviewer.id  = wr.reviewed_by
    LEFT JOIN public.users sender    ON sender.id    = wr.sent_by
    LEFT JOIN weekly_report_projects wrp ON wrp.id = wr.weekly_report_project_id
`;

export async function getWeeklyReportDetail(
  client: QueryExecutor,
  id: string,
): Promise<WeeklyReportDetail | null> {
  const result = await client.query(`${REPORT_SELECT} WHERE wr.id = $1::uuid AND wr.is_active LIMIT 1`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  return mapReportRow(row, await listWeeklyReportPhotos(client, id));
}

export async function listWeeklyReportPhotos(
  client: QueryExecutor,
  reportId: string,
): Promise<WeeklyReportPhoto[]> {
  const result = await client.query(
    `SELECT wrp.file_id, wrp.caption, wrp.sort_order,
            f.description AS original_description,
            f.taken_at, f.created_at, f.mime_type
       FROM weekly_report_photos wrp
       JOIN files f ON f.id = wrp.file_id
      WHERE wrp.weekly_report_id = $1::uuid
        AND f.is_active = true
        AND f.deleted_at IS NULL
      ORDER BY wrp.sort_order ASC, wrp.created_at ASC`,
    [reportId],
  );
  return result.rows.map((row) => ({
    fileId: row.file_id,
    caption: row.caption ?? null,
    originalDescription: row.original_description ?? null,
    sortOrder: Number(row.sort_order),
    takenAt: toIsoTimestamp(row.taken_at ?? row.created_at),
    mimeType: row.mime_type ?? null,
  }));
}

/**
 * `week_of` must be a date this project's cadence actually produces.
 *
 * Without this a client can file a Wednesday report on a Thursday-cadence project; the dashboard
 * generates Thursdays, so that report becomes invisible — present in the table, absent from every view
 * that matters, and the week it was meant to cover still shows as missing.
 */
export function assertValidWeekOf(projectRow: Record<string, any>, weekOf: string): void {
  if (!isIsoDateString(weekOf)) {
    throw new AppError(400, "weekOf must be a YYYY-MM-DD date");
  }
  const cadenceWeekday = Number(projectRow.cadence_weekday);
  if (weeklyReportWeekOf(cadenceWeekday, weekOf) !== weekOf) {
    throw new AppError(400, "weekOf does not fall on this project's reporting day");
  }
  const start = toIsoDate(projectRow.cadence_start_date)!;
  if (weekOf < start) {
    throw new AppError(400, "weekOf precedes the project's reporting start date");
  }
  const end = toIsoDate(projectRow.cadence_end_date);
  if (end && weekOf > end) {
    throw new AppError(400, "weekOf falls after the project's reporting end date");
  }
}

function isAssignedSuper(projectRow: Record<string, any>, actor: WeeklyReportActor): boolean {
  return Boolean(projectRow.trock_super_user_id) && projectRow.trock_super_user_id === actor.id;
}

function isAssignedPm(projectRow: Record<string, any>, actor: WeeklyReportActor): boolean {
  return Boolean(projectRow.trock_pm_user_id) && projectRow.trock_pm_user_id === actor.id;
}

function isElevated(actor: WeeklyReportActor): boolean {
  return ELEVATED_ROLES.has(actor.role);
}

/**
 * May put this project's reports in front of a client: the assigned PM, or an admin/director.
 *
 * The same set `canTransitionAs` requires for `approved` and `sent`, factored out because minting the
 * 180-day public link IS the act of publication — the link is what the client actually opens — and gating
 * it any lower than the send it accompanies would route around the PM gate rather than enforce it. Not
 * expressed through canTransitionAs itself because that also consults the status ladder, and `sent` has no
 * onward transition: re-issuing a link for an already-sent report is legitimate and must not be refused.
 */
export function canPublishWeeklyReport(
  projectRow: Record<string, any>,
  actor: WeeklyReportActor,
): boolean {
  return isAssignedPm(projectRow, actor) || isElevated(actor);
}

/** Whoever created the row. Survives a reassignment, which is the whole point of consulting it. */
function isAuthor(reportRow: Record<string, any>, actor: WeeklyReportActor): boolean {
  return Boolean(reportRow.authored_by) && reportRow.authored_by === actor.id;
}

/**
 * May write the report's content: the assigned super, the assigned PM, an admin/director — or the person
 * who started it, while it is still a draft.
 */
export function canEditWeeklyReport(
  projectRow: Record<string, any>,
  reportRow: Record<string, any>,
  actor: WeeklyReportActor,
): boolean {
  // A sent report is immutable for everyone, elevated roles included. Corrections are a new version —
  // the client may already have opened the link, and silently rewriting what they read is the one
  // outcome this feature must never produce.
  if (reportRow.status === "sent") return false;

  const pmPowers = isAssignedPm(projectRow, actor) || isElevated(actor);
  // Once APPROVED, only the PM may still edit. Letting the superintendent rewrite the narrative or swap
  // the photos of an already-approved report would let them put content in front of a client that the
  // PM never saw, while the status still reads "approved" — which defeats the review gate entirely
  // rather than merely bending it.
  if (reportRow.status === "approved") return pmPowers;

  // THE AUTHOR, WHILE IT IS STILL A DRAFT. `canViewWeeklyReport` already lets them open what they wrote
  // after a reassignment and `canTransitionAs` already lets them submit it, so without the matching write
  // right the payload advertised `canSubmit: true` on a report the same person could not save — and the
  // app's submit is a PATCH and a photo PUT *before* the transition, so both 403'd and the work they were
  // still holding on the phone could never be filed at all.
  //
  // DRAFT ONLY. Past submission the report is the PM's, and a former assignee has no more claim on it than
  // any other ex-assignee; extending this to `pending_review` would let somebody who is no longer on the
  // project rewrite what the PM is in the middle of reviewing.
  if (reportRow.status === "draft" && isAuthor(reportRow, actor)) return true;

  return isAssignedSuper(projectRow, actor) || pmPowers;
}

/**
 * May READ the report.
 *
 * Separate from `canEditWeeklyReport` because a SENT report is readable by everyone who could ever act on
 * it and editable by nobody — collapsing the two would either hide a delivered report from the crew that
 * wrote it or reopen it for editing. The author is included alongside the two assignments so a report
 * survives a reassignment: whoever wrote it can still open what they wrote.
 *
 * This exists for the field surface. The CRM router is gated to admin/director/rep as a whole, but
 * /api/field admits every superintendent in the company, so without a per-report check any of them could
 * read any project's report by id — including the client contact block frozen into its snapshot.
 */
export function canViewWeeklyReport(
  projectRow: Record<string, any>,
  reportRow: Record<string, any>,
  actor: WeeklyReportActor,
): boolean {
  return (
    isAssignedSuper(projectRow, actor) ||
    isAssignedPm(projectRow, actor) ||
    isElevated(actor) ||
    isAuthor(reportRow, actor)
  );
}

/**
 * May move the report to `to`.
 *
 * The PM gate lives here: `approved` and `sent` are reachable only by the assigned PM or an
 * admin/director. A superintendent who is not also the PM cannot approve their own work, which is the
 * entire point of the review step.
 */
export function canTransitionAs(
  projectRow: Record<string, any>,
  reportRow: Record<string, any>,
  to: WeeklyReportStatus,
  actor: WeeklyReportActor,
): boolean {
  if (!canTransitionWeeklyReport(reportRow.status, to)) return false;

  const pmPowers = isAssignedPm(projectRow, actor) || isElevated(actor);
  switch (to) {
    case "pending_review":
      // Two different acts share this target and they are NOT equally permissioned.
      //   draft -> pending_review is SUBMITTING: the super or the author may do it.
      //   approved -> pending_review is WITHDRAWING A PM'S APPROVAL, and only PM powers may.
      // Collapsing them let a superintendent revoke the PM's approval and then edit the reopened
      // report — the review gate unlocked from the inside.
      if (reportRow.status === "approved") return pmPowers;
      // Kept in step with `canEditWeeklyReport`'s draft-author clause: the app PATCHes the content and
      // PUTs the photos before asking for this transition, so a submit right the edit rules do not also
      // grant is a promise the write path cannot keep.
      return isAssignedSuper(projectRow, actor) || pmPowers || isAuthor(reportRow, actor);
    case "draft":
      return pmPowers;
    case "approved":
    case "sent":
      return pmPowers;
    default:
      return false;
  }
}

/**
 * What this actor may do with this report, resolved SERVER-SIDE and shipped with the payload.
 *
 * Both clients render the same wizard, so if each one re-derived "can I approve this?" from a status and
 * a pair of user ids, the two would eventually disagree with each other and with the service that
 * actually enforces it — and the visible failure is a button that 403s. One answer, computed by the same
 * predicates the mutations use.
 */
export interface WeeklyReportPermissions {
  canEdit: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canReturnToDraft: boolean;
  /**
   * May remove the report from the record entirely. See `canDeleteWeeklyReport`.
   *
   * It does NOT promise the delete will succeed: a report that supersedes a live predecessor is refused
   * with a 409 the service raises, because answering it here would need a per-row lookup on a list that
   * already returns 500 of them. The refusal is rare, explains itself, and costs a dialog rather than a
   * query per row.
   */
  canDelete: boolean;
}

/**
 * May DELETE the report: an admin or a director, and nobody else.
 *
 * Deliberately NOT `canEditWeeklyReport`. That predicate exists to answer "may this person write this
 * week's contents", and it says yes to the superintendent who authored the draft — which is right for
 * the text and wrong for the row. Deleting is not an edit: what disappears is the evidence the week was
 * filed at all, and the surfaces that read `is_active` — the board, the History list, the carry-over,
 * the correction wording, the reminder job — all then behave as though it never was.
 *
 * The request that prompted this asked for test data to be removable. There is no test-data flag on any
 * of the eight weekly-report tables and there cannot usefully be one: `createWeeklyReportProject`
 * refuses a test-data deal outright, so the e2e seed sets `is_test_data = false` on its deals and
 * reports written by the runbook are, by construction, indistinguishable from production ones. So the
 * gate is role, not provenance, and this comment is where that substitution is recorded.
 */
export function canDeleteWeeklyReport(actor: WeeklyReportActor): boolean {
  return isElevated(actor);
}

export interface WeeklyReportForActor {
  report: WeeklyReportDetail;
  project: WeeklyReportProject;
  permissions: WeeklyReportPermissions;
}

/**
 * Load a report for someone, refusing it outright if they have no business seeing it.
 *
 * 404 rather than 403 on a report the actor cannot view: a 403 confirms the id names a real report on a
 * project they are not on, which is exactly the probe a per-report check exists to defeat.
 */
export async function getWeeklyReportForActor(
  client: QueryExecutor,
  id: string,
  actor: WeeklyReportActor,
): Promise<WeeklyReportForActor> {
  const { reportRow, projectRow } = await loadReportWithProject(client, id);
  if (!canViewWeeklyReport(projectRow, reportRow, actor)) {
    throw new AppError(404, "Weekly report not found");
  }

  const report = await getWeeklyReportDetail(client, id);
  if (!report) throw new AppError(404, "Weekly report not found");
  const project = await getWeeklyReportProject(client, reportRow.weekly_report_project_id);
  if (!project) throw new AppError(404, "Weekly report project not found");

  return {
    report,
    project,
    permissions: permissionsFor(projectRow, reportRow, actor),
  };
}

/** The one place the five capability answers are assembled, for every surface. */
function permissionsFor(
  projectRow: Record<string, any>,
  reportRow: Record<string, any>,
  actor: WeeklyReportActor,
): WeeklyReportPermissions {
  return {
    // AND THE SETUP HAS TO STILL EXIST. `updateWeeklyReportContent` resolves the project through
    // `getWeeklyReportProjectRow`, which filters `is_active`, so an edit under a stopped setup answers
    // 404 "Weekly report project not found". The permissions join in REPORT_SELECT is a LEFT JOIN with
    // no such filter — it has to be, or a stopped setup's rows would lose their assignment data
    // entirely — so without this clause the payload advertised `canEdit: true` on a report whose PATCH
    // could only fail. Delete is deliberately the exception and keeps working; see deleteWeeklyReport.
    canEdit: projectRow.is_active !== false && canEditWeeklyReport(projectRow, reportRow, actor),
    canSubmit: canTransitionAs(projectRow, reportRow, "pending_review", actor),
    canApprove: canTransitionAs(projectRow, reportRow, "approved", actor),
    canReturnToDraft: canTransitionAs(projectRow, reportRow, "draft", actor),
    canDelete: canDeleteWeeklyReport(actor),
  };
}

export interface CreateWeeklyReportInput {
  clientSubmissionId: string;
  weeklyReportProjectId: string;
  weekOf: string;
}

/**
 * Machine-readable tag on "this week already has a row, started by somebody else".
 *
 * The phone has to tell this 409 apart from the other one `POST /reports` can answer ("Weekly reporting is
 * paused for this project"), because the two want opposite handling: the first is recoverable by adopting
 * the existing row for the week, the second is not recoverable at all. Matching on the prose would break
 * the moment the copy is improved.
 */
export const WEEKLY_REPORT_WEEK_EXISTS_CODE = "WEEKLY_REPORT_WEEK_EXISTS";

/** What last week's report said, for the values a new week starts from. */
export interface WeeklyReportCarryOver {
  reportId: string;
  completionPercent: string | null;
  weatherDelayDays: number | null;
  nextWeekLookAhead: string | null;
}

/**
 * The report a new week should start from.
 *
 * Each week used to be written as if no report ever came before it: percent blank, weather days blank,
 * and the plan the superintendent wrote last week readable only by going and opening last week's report.
 * This is the single row all three carried values come from — ONE row on purpose, so a percentage and a
 * weather total cannot arrive from two different weeks and quietly describe different states of the job.
 *
 * Three predicates, none of them decoration:
 *
 *   status <> 'draft'   A half-filled draft somebody abandoned is not a statement about the job.
 *                       Only a report that was actually submitted is.
 *   week_of < $2        The week being opened, not "the newest row". A week filed LATE must inherit
 *                       from the week before IT, not from a later week already on the board.
 *   is_active           A soft-deleted report is not a source of truth for the next one.
 *
 * `ORDER BY week_of DESC, version DESC` does the rest, and specifically does the work an
 * `AND superseded_by_id IS NULL` predicate looks like it should: a correction is written as a NEW row
 * with version + 1, so the surviving version always outranks the one it replaced. That predicate was
 * here and has been REMOVED, because mutation testing showed nothing could make it fire — and because
 * on the one case where it did change the answer it changed it to the wrong one. A correction that was
 * itself abandoned and soft-deleted leaves the original marked superseded and yet still the only live
 * version, which is exactly the report the client received; skipping it would carry from a week further
 * back and quietly under-report progress. The ordering handles the ordinary case and the `is_active`
 * predicate handles this one.
 */
export async function previousWeeklyReportForCarryOver(
  client: QueryExecutor,
  weeklyReportProjectId: string,
  weekOf: string,
): Promise<WeeklyReportCarryOver | null> {
  const result = await client.query(
    `SELECT id, completion_percent, weather_delay_days, next_week_look_ahead
       FROM weekly_reports
      WHERE weekly_report_project_id = $1::uuid
        AND is_active
        AND week_of < $2::date
        AND status <> 'draft'
      ORDER BY week_of DESC, version DESC
      LIMIT 1`,
    [weeklyReportProjectId, weekOf],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    reportId: row.id,
    // `numeric` arrives as a string from node-postgres and is written back as one; parsing it here
    // would lose the scale the column stores and round 45.50 to 45.5 on its way through.
    completionPercent: row.completion_percent == null ? null : String(row.completion_percent),
    weatherDelayDays: row.weather_delay_days ?? null,
    nextWeekLookAhead: row.next_week_look_ahead ?? null,
  };
}

/**
 * Create (or return) the draft for a project/week.
 *
 * IDEMPOTENT on `clientSubmissionId`: a phone retrying over flaky jobsite LTE must not produce a second
 * report. A retry answers 200 with the existing row rather than 201, matching the field capture
 * convention. A *different* submission id for a week that already has a live report is a genuine
 * conflict and answers 409 — that is two people starting the same week, not one person retrying.
 */
export async function createWeeklyReportDraft(
  client: QueryExecutor,
  input: CreateWeeklyReportInput,
  actor: WeeklyReportActor,
): Promise<{ report: WeeklyReportDetail; created: boolean }> {
  // FOR UPDATE: the status and cadence read here decide whether the draft may exist and which week it
  // belongs to. Without the lock a pause or a cadence change committing before the INSERT leaves a
  // draft that the dashboard no longer generates a slot for — present in the table, invisible on the
  // board, and the week it covers still reading as missing.
  const locked = await client.query(
    `SELECT * FROM weekly_report_projects WHERE id = $1::uuid AND is_active FOR UPDATE`,
    [input.weeklyReportProjectId],
  );
  const projectRow = locked.rows[0];
  if (!projectRow) throw new AppError(404, "Weekly report project not found");
  if (projectRow.status !== "active") {
    throw new AppError(409, `Weekly reporting is ${projectRow.status} for this project`);
  }
  if (!isAssignedSuper(projectRow, actor) && !isAssignedPm(projectRow, actor) && !isElevated(actor)) {
    throw new AppError(403, "You are not assigned to this project");
  }
  assertValidWeekOf(projectRow, input.weekOf);

  const existingBySubmission = await client.query(
    `SELECT id, is_active FROM weekly_reports WHERE client_submission_id = $1::uuid LIMIT 1`,
    [input.clientSubmissionId],
  );
  if (existingBySubmission.rows[0]) {
    return adoptOrRefuseSubmission(client, existingBySubmission.rows[0]);
  }

  const existingForWeek = await client.query(
    `SELECT id FROM weekly_reports
      WHERE weekly_report_project_id = $1::uuid AND week_of = $2::date AND is_active
      ORDER BY version DESC LIMIT 1`,
    [input.weeklyReportProjectId, input.weekOf],
  );
  if (existingForWeek.rows[0]) {
    throw new AppError(409, "A report already exists for this week", WEEKLY_REPORT_WEEK_EXISTS_CODE);
  }

  // What last week said. Everything carried forward comes off ONE row so the three values cannot come
  // from three different weeks — see previousWeeklyReportForCarryOver.
  const carry = await previousWeeklyReportForCarryOver(client, input.weeklyReportProjectId, input.weekOf);

  // ON CONFLICT DO NOTHING rather than trusting the pre-flight SELECTs. Those two lookups do not
  // serialise anything: two retries of the same submit, or two people opening the same week, can both
  // observe no row and both reach this INSERT. Without this the loser gets a raw 23505 surfaced as a
  // 500, which is precisely the flaky-LTE case the idempotency key exists to make boring.
  //
  // THE CARRY-OVER RIDES ON THAT IDEMPOTENCE. Writing the prefill here, rather than in a follow-up
  // UPDATE or on the phone, is what makes "applied exactly once, never over typed text" true: the
  // losing side of a race writes nothing at all, and a resumed draft never re-enters this statement.
  const result = await client.query(
    `INSERT INTO weekly_reports (
       client_submission_id, weekly_report_project_id, deal_id, week_of,
       projected_duration_weeks, completion_percent, weather_delay_days, work_completed,
       carried_from_report_id, authored_by, authored_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::numeric, $7, $8, $9::uuid, $10::uuid, now())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.clientSubmissionId,
      input.weeklyReportProjectId,
      projectRow.deal_id,
      input.weekOf,
      projectRow.projected_duration_weeks,
      // NULL carries as NULL, never as 0. "Nobody has said yet" and "zero percent complete" are
      // different claims about a job and the PDF prints them differently.
      carry?.completionPercent ?? null,
      carry?.weatherDelayDays ?? null,
      // Last week's PLAN becomes this week's starting point for what was done.
      carry?.nextWeekLookAhead ?? null,
      // Which report it came from — the phone reads this to label the section as carried rather than
      // written, and it is what lets that label disappear the moment the text is edited.
      carry?.reportId ?? null,
      actor.id,
    ],
  );

  if (result.rows.length === 0) {
    // Somebody won the race. Which conflict it was decides the answer: the SAME submission id is this
    // caller retrying (200, idempotent), a DIFFERENT one is two people starting the same week (409).
    const bySubmission = await client.query(
      `SELECT id, is_active FROM weekly_reports WHERE client_submission_id = $1::uuid LIMIT 1`,
      [input.clientSubmissionId],
    );
    if (bySubmission.rows[0]) {
      return adoptOrRefuseSubmission(client, bySubmission.rows[0]);
    }
    throw new AppError(409, "A report already exists for this week", WEEKLY_REPORT_WEEK_EXISTS_CODE);
  }

  const report = await getWeeklyReportDetail(client, result.rows[0].id);
  if (!report) throw new AppError(500, "Weekly report could not be read back after creation");
  return { report, created: true };
}

/**
 * What a matched `client_submission_id` means, now that a report can be deleted.
 *
 * A LIVE match is the phone retrying and is answered idempotently — the whole reason the key exists.
 * A DELETED match is answered 409, and the code matters: `weekly_reports_client_submission_id_key` is a
 * plain UNIQUE constraint, not a partial one, so that key can never produce a row again. Reading the id
 * without `is_active` and then dereferencing it through `getWeeklyReportDetail`, which DOES filter
 * `is_active`, answered 404 "Weekly report not found" — to a CREATE call, permanently, for the one
 * mechanism that exists to make flaky-LTE retries boring. The phone recovers from this 409 by adopting
 * the week's live report or starting a fresh submission; it cannot recover from a 404 at all.
 */
async function adoptOrRefuseSubmission(
  client: QueryExecutor,
  row: { id: string; is_active: boolean },
): Promise<{ report: WeeklyReportDetail; created: boolean }> {
  if (!row.is_active) {
    throw new AppError(
      409,
      "That report was deleted — start this week again",
      WEEKLY_REPORT_WEEK_EXISTS_CODE,
    );
  }
  const report = await getWeeklyReportDetail(client, row.id);
  if (!report) throw new AppError(404, "Weekly report not found");
  return { report, created: false };
}

export interface WeeklyReportContentPatch {
  workCompleted?: string | null;
  nextWeekLookAhead?: string | null;
  issuesConcerns?: string | null;
  completionPercent?: number | null;
  weatherDelayDays?: number | null;
}

export async function updateWeeklyReportContent(
  client: QueryExecutor,
  id: string,
  patch: WeeklyReportContentPatch,
  actor: WeeklyReportActor,
): Promise<WeeklyReportDetail> {
  const { reportRow, projectRow } = await loadReportWithProject(client, id);
  if (!canEditWeeklyReport(projectRow, reportRow, actor)) {
    throw new AppError(
      reportRow.status === "sent" ? 409 : 403,
      reportRow.status === "sent"
        ? "A sent report cannot be edited — issue a correction instead"
        : "You do not have permission to edit this report",
    );
  }

  const assignments: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown, cast = "") => {
    params.push(value);
    assignments.push(`${column} = $${params.length}${cast}`);
  };

  if (has(patch, "workCompleted")) {
    set("work_completed", normalizeBody(patch.workCompleted));
    // AND DROP THE CARRY POINTER. `carried_from_report_id` means "this section is still last week's PLAN,
    // untouched" — the phone reads it to label the text as something to edit rather than as a record of
    // what happened. It was set at draft creation and never cleared, so that label would have survived
    // the superintendent rewriting the section completely: the reader would be told a finished account
    // of the week was a plan. Worse than not labelling it at all, and the interface doc claimed this
    // clearing already happened.
    //
    // Cleared on ANY explicit patch of the section rather than on a text comparison. Somebody who opened
    // it, read it and saved it unchanged has adopted those words as their own, which is exactly what the
    // label should stop claiming.
    set("carried_from_report_id", null, "::uuid");
  }
  if (has(patch, "nextWeekLookAhead")) set("next_week_look_ahead", normalizeBody(patch.nextWeekLookAhead));
  if (has(patch, "issuesConcerns")) set("issues_concerns", normalizeBody(patch.issuesConcerns));
  if (has(patch, "completionPercent")) {
    set("completion_percent", normalizePercent(patch.completionPercent), "::numeric");
  }
  if (has(patch, "weatherDelayDays")) set("weather_delay_days", normalizeDelayDays(patch.weatherDelayDays));

  if (assignments.length === 0) {
    const unchanged = await getWeeklyReportDetail(client, id);
    if (!unchanged) throw new AppError(404, "Weekly report not found");
    return unchanged;
  }

  params.push(id);
  const idParam = params.length;
  params.push(reportRow.status);

  // CONDITIONED ON THE STATUS THE PERMISSION CHECK RAN AGAINST. `canEditWeeklyReport` can legitimately
  // authorise an edit to an `approved` report; if a concurrent request sends it in between, an
  // unconditional write lands on a report the client has already received — breaking the immutability
  // guarantee and making the public page differ from the PDF that was generated from it.
  //
  // KNOWN GAP (not closed here): this guards the STATUS, not the CONTENT. Two people editing the same
  // report at the same status are last-write-wins with no 409 and no prompt — a PM opens a review draft,
  // the superintendent edits the same report from their phone, the PM taps Approve, and this UPDATE and
  // the whole-set photo PUT below both succeed over work the PM never saw. The app reconciles at OPEN
  // time (mobile/src/weekly-reports/door.ts) and carries no precondition on the write, so the window is
  // "since the draft was opened". Closing it needs an If-Match / `updated_at` precondition on this
  // statement and on `replaceWeeklyReportPhotos`, plus the client sending what it last read.
  const result = await client.query(
    `UPDATE weekly_reports SET ${assignments.join(", ")}, updated_at = now()
      WHERE id = $${idParam}::uuid AND is_active AND status = $${params.length}
      RETURNING id`,
    params,
  );
  if (result.rows.length === 0) {
    throw new AppError(409, "This report changed while you were working on it — reload and try again");
  }

  const updated = await getWeeklyReportDetail(client, id);
  if (!updated) throw new AppError(404, "Weekly report not found");
  return updated;
}

function has<T extends object>(obj: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 20k characters is roughly 8x the longest section on the reference report. It exists to stop a runaway
// dictation loop writing an unbounded row, not to constrain anyone writing prose. Shared with both
// renderers, so what the API accepts is exactly what the PDF and the client's page print.
const MAX_SECTION_CHARS = WEEKLY_REPORT_SECTION_MAX_CHARS;

function normalizeBody(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new AppError(400, "Report sections must be text");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_SECTION_CHARS) {
    throw new AppError(400, `Report sections are limited to ${MAX_SECTION_CHARS} characters`);
  }
  return trimmed;
}

function normalizePercent(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new AppError(400, "completionPercent must be between 0 and 100");
  }
  // Two decimals to match numeric(5,2); rounding here rather than letting Postgres do it keeps the value
  // the API echoes back identical to the value it stored.
  return Math.round(parsed * 100) / 100;
}

function normalizeDelayDays(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(400, "weatherDelayDays must be a whole number of days");
  }
  // THE CEILING, from the shared constant rather than a literal — the form now enforces the same number,
  // and a limit written twice is a limit that drifts. Its own message, because "must be a whole number"
  // described a rule a caller sending 4000 had not broken.
  if (parsed > WEEKLY_REPORT_MAX_WEATHER_DELAY_DAYS) {
    throw new AppError(400, `weatherDelayDays is capped at ${WEEKLY_REPORT_MAX_WEATHER_DELAY_DAYS} days`);
  }
  return parsed;
}

async function loadReportWithProject(
  client: QueryExecutor,
  id: string,
  // REMOVING a report must survive the setup being archived, for the same reason revoking a share link
  // does. `getWeeklyReportProjectRow` filters `is_active`, so a stopped setup would make its reports
  // permanently undeletable — refused with "Weekly report project not found", which is not even true —
  // and a stopped setup is exactly where leftover test data comes to rest. Writing CONTENT stays gated:
  // a project nobody reports on any more is not a project whose weeks should still be edited.
  options: { allowInactiveProject?: boolean } = {},
) {
  const result = await client.query(
    `SELECT * FROM weekly_reports WHERE id = $1::uuid AND is_active LIMIT 1`,
    [id],
  );
  const reportRow = result.rows[0];
  if (!reportRow) throw new AppError(404, "Weekly report not found");

  const projectRow = options.allowInactiveProject
    ? (
        await client.query(`SELECT * FROM weekly_report_projects WHERE id = $1::uuid LIMIT 1`, [
          reportRow.weekly_report_project_id,
        ])
      ).rows[0]
    : await getWeeklyReportProjectRow(client, reportRow.weekly_report_project_id);
  if (!projectRow) throw new AppError(404, "Weekly report project not found");
  return { reportRow, projectRow };
}

export interface WeeklyReportDeleteInput {
  /** Why. Non-empty, matching the dismissal route and the deal archive — see the check below. */
  reason: string;
  /** The `week_of` of a SENT report, typed back by the person deleting it. ISO, `YYYY-MM-DD`. */
  confirmWeekOf?: string;
}

/** What was removed. Returned rather than `void` so the caller can log and audit the actual row. */
export interface WeeklyReportDeletion {
  id: string;
  status: WeeklyReportStatus;
  weekOf: string;
}

/**
 * SOFT-DELETE a report — the writer `weekly_reports.is_active` shipped without.
 *
 * The column has been read by ~20 queries and every worker job since 0222, and three separate comments in
 * this module reason about soft-deleted reports as though the feature existed. Nothing could produce one.
 * That is why the read side needs no changes here: it was already complete, and already consistent.
 *
 * ONE READ PATH DID NEED CHANGING and it is worth naming, because the interface note above claims
 * otherwise: `createWeeklyReportDraft` looked up `client_submission_id` without `is_active`. See
 * `adoptOrRefuseSubmission`.
 */
export async function deleteWeeklyReport(
  client: QueryExecutor,
  id: string,
  actor: WeeklyReportActor,
  input: WeeklyReportDeleteInput,
): Promise<WeeklyReportDeletion> {
  const { reportRow } = await loadReportWithProject(client, id, { allowInactiveProject: true });

  if (!canDeleteWeeklyReport(actor)) {
    throw new AppError(403, "Only an admin or director can delete a weekly report");
  }

  // A REPORT THAT REPLACED A LIVE PREDECESSOR CANNOT BE REMOVED, and the refusal is not fussiness.
  // `superseded_by_id` has exactly one writer (send-service, at send) and nothing ever clears it; the
  // FK's ON DELETE SET NULL never fires on a soft delete. So deleting v2 leaves v1 stamped as superseded
  // — excluded from the board — and v2 inactive, also excluded. The week reappears as never filed, the
  // reminder job emails the superintendent, the PM and leadership about a week the client has already
  // received twice, and History offers no action on either row. There is no way back out of that state.
  //
  // ASKED TWICE, AND THE SECOND TIME IS THE ONE THAT BINDS. This read is a plain SELECT and cannot hold
  // its answer until the write; the same condition rides on the UPDATE below, so a supersede committing
  // in between refuses there instead. This one exists to say WHY, in a sentence somebody can act on —
  // the write can only report that something changed.
  if (await supersedesLivePredecessor(client, id)) {
    throw new AppError(409, SUPERSEDES_LIVE_PREDECESSOR_MESSAGE);
  }

  const weekOf = toIsoDate(reportRow.week_of)!;
  // TYPE THE WEEK BACK, for a report the client is already holding. `week_of` is a `date` column, so
  // node-postgres hands back a Date and comparing the input string against the raw value is false for
  // every input including the right one — the guard would refuse the whole feature on exactly the
  // reports it exists to protect.
  if (reportRow.status === "sent" && input.confirmWeekOf !== weekOf) {
    throw new AppError(400, "Confirm the week of the sent report to delete it");
  }

  // NON-EMPTY, not some minimum length. The house idiom is `length === 0` — the deal archive, this
  // module's own dismiss route — and inventing a longer rule here would put the dialog's disabled button
  // and the server's 400 into disagreement about the same click.
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length === 0) {
    throw new AppError(400, "A reason is required to delete a weekly report");
  }
  // REFUSED, NOT TRIMMED TO FIT. `audit_log` is the only place this sentence is kept — `weekly_reports`
  // carries no reason column — so silently cutting it discards forensic record while answering 204, and
  // the person who wrote the explanation is told it was saved. Shared with the dialog's counter so the
  // two describe the same rule.
  if (reason.length > WEEKLY_REPORT_DELETE_REASON_MAX_CHARS) {
    throw new AppError(
      400,
      `A deletion reason is limited to ${WEEKLY_REPORT_DELETE_REASON_MAX_CHARS} characters`,
    );
  }

  // CONDITIONED ON THE STATUS THE CHECKS ABOVE RAN AGAINST, exactly as the content and transition writes
  // are. Without it this is check-then-act: the sent-report confirmation is read from a status fetched in
  // an earlier statement, so a send committing in that window lets an unconfirmed delete land on a report
  // the client has since been emailed — the one thing the confirmation exists to stop.
  //
  // AND ON THE SUPERSEDE, re-tested here rather than trusted from the SELECT above. A correction send
  // stamps `superseded_by_id` on its predecessor, and that write can commit between the precheck and
  // this statement; a delete landing in that window strands the week exactly as an unchecked delete
  // would. Expressed as NOT EXISTS on the write instead of FOR UPDATE on the predecessor because the row
  // to lock is not this one and may not exist yet — there is nothing to take a lock on until the send
  // creates the reference, so only a condition evaluated AT the write can see it.
  const result = await client.query(
    `UPDATE weekly_reports SET is_active = false, updated_at = now()
      WHERE id = $1::uuid AND is_active AND status = $2
        AND NOT EXISTS (
          SELECT 1 FROM weekly_reports predecessor
           WHERE predecessor.superseded_by_id = $1::uuid AND predecessor.is_active
        )
      RETURNING id, status, week_of`,
    [id, reportRow.status],
  );
  const deleted = result.rows[0];
  if (!deleted) {
    // WHICH condition refused it. Both answer 409 and they want different sentences: one says reload,
    // the other says delete the other version. Costs a query on the failure path only.
    if (await supersedesLivePredecessor(client, id)) {
      throw new AppError(409, SUPERSEDES_LIVE_PREDECESSOR_MESSAGE);
    }
    throw new AppError(409, "This report changed while you were working on it — reload and try again");
  }

  return { id: deleted.id, status: deleted.status, weekOf: toIsoDate(deleted.week_of)! };
}

const SUPERSEDES_LIVE_PREDECESSOR_MESSAGE =
  "This report replaced an earlier version of the same week. Deleting it would leave that week " +
  "reading as never filed — delete the earlier version instead, or leave both in place.";

/** Is there a LIVE report this one replaced? Deleting it would strand that week — see the caller. */
async function supersedesLivePredecessor(client: QueryExecutor, id: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM weekly_reports WHERE superseded_by_id = $1::uuid AND is_active LIMIT 1`,
    [id],
  );
  return Boolean(result.rows[0]);
}

export interface WeeklyReportPhotoSelection {
  fileId: string;
  caption?: string | null;
  sortOrder?: number;
}

/**
 * Replace the whole photo selection in one call.
 *
 * Whole-set replacement rather than add/remove endpoints because the picker is a multi-select whose
 * result IS the set — a partial API would need the client to diff, and a dropped diff leaves a photo on
 * a report nobody chose.
 *
 * Every file must belong to this report's deal. Without that check a caller could attach any photo in
 * the office to a client-facing report by guessing an id.
 */
export async function replaceWeeklyReportPhotos(
  client: QueryExecutor,
  id: string,
  selections: WeeklyReportPhotoSelection[],
  actor: WeeklyReportActor,
): Promise<WeeklyReportDetail> {
  const { reportRow, projectRow } = await loadReportWithProject(client, id);
  if (!canEditWeeklyReport(projectRow, reportRow, actor)) {
    throw new AppError(
      reportRow.status === "sent" ? 409 : 403,
      reportRow.status === "sent"
        ? "A sent report cannot be edited — issue a correction instead"
        : "You do not have permission to edit this report",
    );
  }
  if (!Array.isArray(selections)) {
    throw new AppError(400, "photos must be an array");
  }
  if (selections.length > MAX_REPORT_PHOTOS) {
    throw new AppError(400, `A weekly report is limited to ${MAX_REPORT_PHOTOS} photos`);
  }

  const seen = new Set<string>();
  const rows = selections.map((selection, index) => {
    const fileId = typeof selection?.fileId === "string" ? selection.fileId.trim() : "";
    if (!fileId) throw new AppError(400, "Each photo requires a fileId");
    // Shape-checked BEFORE the query, because the ownership check casts this list to uuid[] — a
    // malformed id would raise a Postgres cast error and surface as a generic 500 rather than the
    // 400 the caller can act on.
    if (!UUID_PATTERN.test(fileId)) throw new AppError(400, "Each photo fileId must be a valid UUID");
    if (seen.has(fileId)) throw new AppError(400, "The same photo cannot be selected twice");
    seen.add(fileId);
    return {
      fileId,
      caption: normalizeCaption(selection.caption),
      // Trust the array order over a client-supplied sortOrder: the order the user dragged them into IS
      // the array, and honouring a stale index would reorder the page against their intent.
      sortOrder: index,
    };
  });

  if (rows.length > 0) {
    const owned = await client.query(
      `SELECT id FROM files
        WHERE id = ANY($1::uuid[])
          AND deal_id = $2::uuid
          AND category = 'photo'
          AND is_active = true
          AND deleted_at IS NULL`,
      [rows.map((row) => row.fileId), reportRow.deal_id],
    );
    if (owned.rows.length !== rows.length) {
      throw new AppError(400, "One or more photos do not belong to this project");
    }
  }

  await client.query(`DELETE FROM weekly_report_photos WHERE weekly_report_id = $1::uuid`, [id]);
  for (const row of rows) {
    await client.query(
      `INSERT INTO weekly_report_photos (weekly_report_id, file_id, caption, sort_order)
       VALUES ($1::uuid, $2::uuid, $3, $4)`,
      [id, row.fileId, row.caption, row.sortOrder],
    );
  }
  // Same concurrency guard as the content path: the permission check ran against a status read in an
  // earlier statement, and a photo swap landing on an already-sent report would make the client's page
  // disagree with the PDF they were emailed. It carries the same KNOWN GAP — see the note on the content
  // UPDATE above: a concurrent replacement AT THE SAME STATUS overwrites silently, because this is a
  // whole-set PUT with no precondition on what the caller last read.
  const stillOpen = await client.query(
    `UPDATE weekly_reports SET updated_at = now()
      WHERE id = $1::uuid AND is_active AND status = $2
      RETURNING id`,
    [id, reportRow.status],
  );
  if (stillOpen.rows.length === 0) {
    throw new AppError(409, "This report changed while you were working on it — reload and try again");
  }

  const updated = await getWeeklyReportDetail(client, id);
  if (!updated) throw new AppError(404, "Weekly report not found");
  return updated;
}

/**
 * The SHARED ceiling, for the same reason the caption limit is shared: the render budget is sized from it
 * (`base + per-photo × count`), and a report the API accepts but the renderer cannot finish inside its
 * deadline has no downloadable PDF at all. See WEEKLY_REPORT_MAX_PHOTOS.
 */
const MAX_REPORT_PHOTOS = WEEKLY_REPORT_MAX_PHOTOS;
/**
 * The SHARED ceiling, not one of this module's own.
 *
 * It was 500 here while the PDF drew the caption into a fixed two-line box and ellipsised the rest, so the
 * API accepted captions neither renderer could print — and the client's web page showed them in full while
 * the attached PDF did not. See WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS for how the number was chosen.
 */
const MAX_CAPTION_CHARS = WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS;
/**
 * Cap on the picker's candidate set, newest first.
 *
 * A busy jobsite produces hundreds of photos in a fortnight, and the field route presigns two URLs for
 * every candidate it returns — so an unbounded set is a large JSON body on precisely the LTE connection
 * the rest of this feature is shaped around. Five times the per-report photo cap is more than anyone
 * scrolls, and the newest-first ordering means what is dropped is the far end of the window.
 *
 * A TRANSPORT cap, so it is reported rather than applied silently — the same standard the review queue and
 * the outstanding-week backlog hold themselves to. What it drops is not neutral: the window is anchored on
 * `week_of`, not on today, so the far end is the EARLIEST days of the fortnight the report is about, which
 * is exactly what somebody filing a late report is looking for.
 */
export const MAX_PHOTO_CANDIDATES = 300;

function normalizeCaption(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new AppError(400, "Photo captions must be text");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CAPTION_CHARS) {
    throw new AppError(400, `Photo captions are limited to ${MAX_CAPTION_CHARS} characters`);
  }
  return trimmed;
}

/**
 * A caption the picker offers as a DEFAULT, cut to what the API will accept back.
 *
 * The default comes from `files.description`, which has no such limit — so a photo captured with a long
 * description used to pre-fill the form with a value that 400s the moment the superintendent pressed save,
 * with nothing on screen explaining why.
 */
function boundedDefaultCaption(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= MAX_CAPTION_CHARS ? trimmed : trimmed.slice(0, MAX_CAPTION_CHARS).trimEnd();
}

/**
 * The photo picker's candidate set: this deal's photos from the 14 days ending on `week_of`.
 *
 * `alreadyUsedOn` marks photos that appeared on an earlier report so the super does not repeat them —
 * shown rather than hidden, because re-using a photo is sometimes right (a defect photographed last
 * week that is now fixed).
 *
 * `total` is the size of the WHOLE candidate set, so the caller can say what it is not showing. Two
 * things follow from the cap being reported rather than hidden, and both are load-bearing:
 *
 *   - A photo ALREADY ON THIS REPORT is never dropped, however far down the window it sits (and even if
 *     it has since fallen outside the window, which an import with old EXIF can do). It would otherwise
 *     vanish from the grid while still counting toward the picker's "N selected", leaving the count and
 *     the visible ticks disagreeing with no way to reconcile them — and no way to DESELECT it.
 *   - Everything else is ranked strictly newest-first, so the rows the cap removes are the oldest, which
 *     is what the header tells the user.
 */
export async function listWeeklyReportPhotoCandidates(
  client: QueryExecutor,
  reportId: string,
): Promise<{
  photos: Array<WeeklyReportPhoto & { alreadyUsedOn: string | null; selected: boolean }>;
  total: number;
}> {
  const { reportRow } = await loadReportWithProject(client, reportId);
  const weekOf = toIsoDate(reportRow.week_of)!;
  const window = weeklyReportPhotoWindow(weekOf);

  const result = await client.query(
    `WITH candidate AS (
       SELECT f.id AS file_id,
              f.description AS original_description,
              f.taken_at, f.created_at, f.mime_type,
              selected.caption AS selected_caption,
              selected.sort_order AS selected_sort_order,
              (selected.file_id IS NOT NULL) AS selected,
              prior.week_of AS already_used_on,
              COALESCE(f.taken_at, f.created_at) AS sort_at
         FROM files f
         LEFT JOIN weekly_report_photos selected
                ON selected.file_id = f.id AND selected.weekly_report_id = $1::uuid
         LEFT JOIN LATERAL (
              SELECT wr.week_of
                FROM weekly_report_photos wrp
                JOIN weekly_reports wr ON wr.id = wrp.weekly_report_id
               WHERE wrp.file_id = f.id
                 AND wr.id <> $1::uuid
                 AND wr.is_active
                 -- EARLIER weeks only. Without this, filing a missed week after a newer draft has
                 -- already picked the same photo warns that it was "already used" on a week that has
                 -- not happened yet.
                 AND wr.week_of < $5::date
               ORDER BY wr.week_of DESC
               LIMIT 1
         ) prior ON true
        WHERE f.deal_id = $2::uuid
          AND f.category = 'photo'
          AND f.is_active = true
          AND f.deleted_at IS NULL
          AND ((COALESCE(f.taken_at, f.created_at))::date BETWEEN $3::date AND $4::date
               OR selected.file_id IS NOT NULL)
     ), ranked AS (
       SELECT candidate.*,
              -- Evaluated before the outer WHERE, so this is the true depth on every returned row and
              -- costs no second round trip. file_id breaks ties so the cap falls in the same place on
              -- every refetch rather than shuffling two photos taken in the same second.
              COUNT(*) OVER () AS total_count,
              ROW_NUMBER() OVER (ORDER BY sort_at DESC, file_id) AS window_rank
         FROM candidate
     )
     SELECT * FROM ranked
      WHERE selected OR window_rank <= ${MAX_PHOTO_CANDIDATES}
      ORDER BY sort_at DESC, file_id`,
    [reportId, reportRow.deal_id, window.from, window.to, weekOf],
  );

  const total = Number(result.rows[0]?.total_count ?? 0);
  const photos = result.rows.map((row) => ({
    fileId: row.file_id,
    // For an ALREADY-SELECTED photo the stored caption wins outright, null included: `??` treated a
    // deliberately cleared caption as absent and restored the capture description, so the user could
    // not blank a caption and have it stay blank. The description is only a default for photos the
    // user has not selected yet.
    caption: row.selected ? (row.selected_caption ?? null) : boundedDefaultCaption(row.original_description),
    originalDescription: row.original_description ?? null,
    sortOrder: Number(row.selected_sort_order ?? 0),
    takenAt: toIsoTimestamp(row.taken_at ?? row.created_at),
    mimeType: row.mime_type ?? null,
    alreadyUsedOn: toIsoDate(row.already_used_on),
    selected: Boolean(row.selected),
  }));
  return { photos, total };
}

/**
 * Move a report along the ladder.
 *
 * `remaining_weeks` is computed and STORED on submit rather than at render time, so a report already in
 * the PM's queue keeps the arithmetic it was written with even if the projected duration is revised.
 */
export interface WeeklyReportTransitionOptions {
  /**
   * The composed email, written in the SAME statement that moves the report to `sent`.
   *
   * Supplied only by the send flow (send-service.ts). Keeping it here rather than in a follow-up UPDATE is
   * what makes "a `sent` report always records what was sent" true under concurrency: the status write is
   * already conditioned on the status it validated, so a request that loses that race writes neither.
   */
  sendRequest?: { request: Record<string, unknown>; deliveryKey: string };
}

export async function transitionWeeklyReport(
  client: QueryExecutor,
  id: string,
  to: WeeklyReportStatus,
  actor: WeeklyReportActor,
  options: WeeklyReportTransitionOptions = {},
): Promise<WeeklyReportDetail> {
  if (!isWeeklyReportStatus(to)) {
    throw new AppError(400, "Unknown report status");
  }
  const { reportRow, projectRow } = await loadReportWithProject(client, id);

  if (!canTransitionWeeklyReport(reportRow.status, to)) {
    throw new AppError(409, `A ${reportRow.status} report cannot move to ${to}`);
  }
  if (!canTransitionAs(projectRow, reportRow, to, actor)) {
    throw new AppError(403, `You do not have permission to move this report to ${to}`);
  }

  const assignments = [`status = $1`];
  const params: unknown[] = [to];

  // Re-checked at EVERY forward gate, not just the first submit. PM-authorised users may edit a report
  // in pending_review or approved, so a check that ran only on draft submission let the work-completed
  // section be cleared afterwards and the empty report approved and sent to the client.
  const isForwardGate = to === "pending_review" || to === "approved" || to === "sent";
  if (isForwardGate && !reportRow.work_completed) {
    throw new AppError(400, "Add the work completed before this report can move forward");
  }

  if (to === "pending_review") {
    if (reportRow.status === "draft") {
      const remaining = weeklyReportRemainingWeeks({
        projectedDurationWeeks: projectRow.projected_duration_weeks,
        projectStartDate: toIsoDate(projectRow.project_start_date),
        weekOf: toIsoDate(reportRow.week_of)!,
      });
      params.push(remaining);
      assignments.push(`remaining_weeks = $${params.length}`);
      params.push(projectRow.projected_duration_weeks);
      assignments.push(`projected_duration_weeks = $${params.length}`);
      params.push(actor.id);
      assignments.push(`submitted_by = $${params.length}::uuid`, `submitted_at = now()`);
    }
  }
  if (to === "approved") {
    params.push(actor.id);
    assignments.push(`reviewed_by = $${params.length}::uuid`, `reviewed_at = now()`);
  }
  if (to === "sent") {
    // Stamped when the PM commits to sending, not when the mail server acknowledges. Delivery is a
    // separate concern tracked by send_attempts/send_error: leaving sent_at null on a `sent` row would
    // make the dashboard and the per-project counters disagree with the status they are reading.
    params.push(actor.id);
    assignments.push(`sent_by = $${params.length}::uuid`, `sent_at = now()`);

    // FREEZE THE HEADER. Everything the report prints about the client, the team and the schedule is
    // read live from weekly_report_projects until this moment. Without the snapshot, swapping a PM or
    // correcting a contract date in September silently rewrites the header of every report already
    // delivered in August — including the PDF regenerated from it and the page behind the client's
    // 180-day link, which they may already have read.
    params.push(JSON.stringify(await buildWeeklyReportSnapshot(client, projectRow)));
    assignments.push(`snapshot = $${params.length}::jsonb`);

    if (options.sendRequest) {
      params.push(JSON.stringify(options.sendRequest.request));
      assignments.push(`send_request = $${params.length}::jsonb`);
      params.push(options.sendRequest.deliveryKey);
      assignments.push(`send_delivery_key = $${params.length}::uuid`);
      // A fresh send starts from a clean delivery record. These are all already at their defaults for a
      // first send; stating them keeps the invariant true for any future path that reuses this row.
      //
      // The 0227 verdict columns are cleared with them, and belong in the same list for the same reason:
      // they describe what the provider said about a PARTICULAR message, and this statement is minting a
      // new delivery key — i.e. a different message. Carrying a stale `bounced` onto it would report a
      // failure for a send that has not been attempted yet.
      assignments.push(
        `send_attempts = 0`,
        `send_error = NULL`,
        `send_delivered_at = NULL`,
        `send_last_attempt_at = NULL`,
        `send_delivery_status = NULL`,
        `send_delivery_status_at = NULL`,
        `send_delivery_detail = NULL`,
      );
    }
  }
  // Any move BACKWARDS out of `approved` clears the review stamps — bounced to draft, or approval
  // withdrawn back into review. Clearing only on the draft path left a report reading "pending review"
  // while still stamped with the reviewer and time of an approval that had just been revoked.
  if (to === "draft" || (to === "pending_review" && reportRow.status === "approved")) {
    assignments.push(`reviewed_by = NULL`, `reviewed_at = NULL`);
  }

  params.push(id);
  const idParam = params.length;
  params.push(reportRow.status);

  // CONDITIONED ON THE STATUS WE VALIDATED, with the row count checked. The permission and ladder
  // checks above ran against a row read in an earlier statement; two concurrent requests on an
  // `approved` report could otherwise both pass validation — one choosing `sent`, the other
  // `pending_review` — and the later write would win, pulling a report back out of a terminal state
  // after it had already gone to the client.
  // RETURNING id rather than trusting `rowCount`: the check is then driver-independent, and the test
  // harness cannot accidentally report a different number of affected rows than production does.
  //
  // AND ON THE CONTENT, for the same reason and against the same window. Status is not the only thing
  // the validation above read: the work-completed gate tested `reportRow.work_completed` from that same
  // earlier statement, and clearing that section does NOT move `status`. So an authorised content edit
  // landing between the read and this write slipped past a status-only condition, and the report went
  // `approved` — or `sent`, to the client — with the section the gate exists to require left empty.
  // Re-testing it here closes the window the gate's own comment describes.
  // `btrim(...) <> ''` is deliberately STRICTER than the `!reportRow.work_completed` check above, which a
  // whitespace-only string would pass. normalizeBody trims and returns null, so the column never holds
  // whitespace through the API and the two agree in practice; the difference only shows for a row written
  // by something else (a direct SQL edit, a backfill). There it fails safe — an effectively-empty report
  // is refused rather than sent to a client, at the cost of a 409 where a 400 would read better.
  const contentGate = isForwardGate
    ? " AND work_completed IS NOT NULL AND btrim(work_completed) <> ''"
    : "";
  const result = await client.query(
    `UPDATE weekly_reports SET ${assignments.join(", ")}, updated_at = now()
      WHERE id = $${idParam}::uuid AND is_active AND status = $${params.length}${contentGate}
      RETURNING id`,
    params,
  );
  if (result.rows.length === 0) {
    throw new AppError(409, "This report changed while you were working on it — reload and try again");
  }

  const updated = await getWeeklyReportDetail(client, id);
  if (!updated) throw new AppError(404, "Weekly report not found");
  return updated;
}

/** Trimmed, or null when there is nothing there — the same "blank is absent" rule both renderers apply. */
function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * The header block as it stood at send time.
 *
 * Stored on the report so a sent report renders from its own frozen copy rather than from the live
 * project row. Names are resolved and stored here rather than left as ids: the point is to preserve
 * what the client was actually told, not a pointer that later resolves to somebody else.
 */
export async function buildWeeklyReportSnapshot(
  client: QueryExecutor,
  projectRow: Record<string, any>,
): Promise<Record<string, unknown>> {
  const names = await client.query(
    `SELECT
       (SELECT display_name FROM public.users WHERE id = $1::uuid) AS pm_name,
       (SELECT display_name FROM public.users WHERE id = $2::uuid) AS super_name,
       (SELECT name FROM deals WHERE id = $3::uuid) AS deal_name`,
    [projectRow.trock_pm_user_id, projectRow.trock_super_user_id, projectRow.deal_id],
  );
  const row = names.rows[0] ?? {};

  return {
    // RESOLVED, not copied. `property_display_name` is nullable and a user can clear it, and both renderers
    // then fall back to the deal's name — which is live. Freezing what will actually be printed is what
    // makes "sent" mean the header can no longer change: without it, renaming the deal in October rewrote
    // the header of a report delivered in August, on the client's page, while the PDF stayed as delivered.
    propertyDisplayName: nonBlank(projectRow.property_display_name) ?? nonBlank(row.deal_name),
    clientName: projectRow.client_name ?? null,
    clientTeam: {
      doc: { name: projectRow.client_doc_name ?? null, email: projectRow.client_doc_email ?? null },
      pm: { name: projectRow.client_pm_name ?? null, email: projectRow.client_pm_email ?? null },
      rm: { name: projectRow.client_rm_name ?? null, email: projectRow.client_rm_email ?? null },
      cm: { name: projectRow.client_cm_name ?? null, email: projectRow.client_cm_email ?? null },
    },
    trockTeam: {
      pmUserId: projectRow.trock_pm_user_id ?? null,
      pmName: row.pm_name ?? null,
      superUserId: projectRow.trock_super_user_id ?? null,
      superName: row.super_name ?? null,
    },
    schedule: {
      contractDate: toIsoDate(projectRow.contract_date),
      contractDateNote: projectRow.contract_date_note ?? null,
      projectStartDate: toIsoDate(projectRow.project_start_date),
      projectStartDateNote: projectRow.project_start_date_note ?? null,
      projectCompletionDate: toIsoDate(projectRow.project_completion_date),
      projectCompletionDateNote: projectRow.project_completion_date_note ?? null,
      projectedDurationWeeks: projectRow.projected_duration_weeks ?? null,
    },
    snapshotVersion: 1,
  };
}

/**
 * A History row: the report, and what THIS actor may do with it.
 *
 * The permissions ride in their own envelope rather than as fields on `WeeklyReportDetail`, which is also
 * the field and phone payload with eight call sites and no business carrying a CRM capability answer.
 * `WeeklyReportPermissions` already existed for exactly this and is already computed by the same
 * predicates the mutations enforce — one answer, not two implementations that eventually disagree and
 * ship a button that 403s.
 */
export interface WeeklyReportListEntry extends WeeklyReportDetail {
  permissions: WeeklyReportPermissions;
  /**
   * The SETUP behind this report has been stopped — "Stop reporting" soft-deleted it.
   *
   * A FACT, not a permission, and that is why it sits here rather than in the envelope beside
   * `canEdit`: every member of that envelope answers "may THIS ACTOR do X", and this one is the same
   * for everybody who can see the row.
   *
   * It is ONE field rather than one per action because there is one cause, not three. Send, retry and
   * correction all resolve the project through `loadSendTarget`, which filters `wrp.is_active` and
   * throws 404 "Weekly report project not found" — so a UI that offers them here is offering three
   * buttons that fail for the same reason. What each of those actions ADDITIONALLY requires (an
   * `approved` status, an undelivered send, being the newest version) is genuine product logic that
   * already lives and is tested in the History panel; folding it in here would move working rules
   * server-side for no gain.
   */
  reportingStopped: boolean;
}

export async function listWeeklyReports(
  client: QueryExecutor,
  filters: { projectId?: string | null; status?: string | null; from?: string | null; to?: string | null } = {},
  actor: WeeklyReportActor,
): Promise<WeeklyReportListEntry[]> {
  const params: unknown[] = [];
  const where: string[] = ["wr.is_active"];

  if (filters.projectId) {
    params.push(filters.projectId);
    where.push(`wr.weekly_report_project_id = $${params.length}::uuid`);
  }
  if (filters.status && isWeeklyReportStatus(filters.status)) {
    params.push(filters.status);
    where.push(`wr.status = $${params.length}`);
  }
  if (filters.from && isIsoDateString(filters.from)) {
    params.push(filters.from);
    where.push(`wr.week_of >= $${params.length}::date`);
  }
  if (filters.to && isIsoDateString(filters.to)) {
    params.push(filters.to);
    where.push(`wr.week_of <= $${params.length}::date`);
  }

  const result = await client.query(
    `${REPORT_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY wr.week_of DESC, wr.version DESC
      LIMIT 500`,
    params,
  );
  // Photos are not needed for the history list and would cost a query per row.
  return result.rows.map((row) => ({
    ...mapReportRow(row, []),
    // The project's two assignment slots come off the join in REPORT_SELECT, so the whole list is still
    // ONE query. Rebuilt into the shape the predicates read rather than passed as the raw row, because
    // `wr.*` also carries columns named the same as the project's and the wrong one silently answering
    // "is this person the assigned PM?" is the kind of authorisation bug that reads as correct.
    permissions: permissionsFor(
      {
        trock_super_user_id: row.project_trock_super_user_id,
        trock_pm_user_id: row.project_trock_pm_user_id,
        is_active: row.project_is_active,
      },
      row,
      actor,
    ),
    reportingStopped: row.project_is_active === false,
  }));
}
