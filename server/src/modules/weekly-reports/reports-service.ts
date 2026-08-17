import {
  canTransitionWeeklyReport,
  isIsoDateString,
  isWeeklyReportStatus,
  weeklyReportPhotoWindow,
  weeklyReportRemainingWeeks,
  weeklyReportWeekOf,
  type WeeklyReportStatus,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { getWeeklyReportProjectRow, type QueryExecutor } from "./projects-service.js";

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
  snapshot: Record<string, unknown> | null;
  authoredBy: string | null;
  authoredByName: string | null;
  authoredAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  sentAt: string | null;
  sendError: string | null;
  sendAttempts: number;
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
    snapshot: row.snapshot ?? null,
    authoredBy: row.authored_by ?? null,
    authoredByName: row.authored_by_name ?? null,
    authoredAt: toIsoTimestamp(row.authored_at),
    submittedAt: toIsoTimestamp(row.submitted_at),
    reviewedAt: toIsoTimestamp(row.reviewed_at),
    sentAt: toIsoTimestamp(row.sent_at),
    sendError: row.send_error ?? null,
    sendAttempts: Number(row.send_attempts ?? 0),
    pdfAvailable: Boolean(row.pdf_r2_key),
    photos,
  };
}

const REPORT_SELECT = `
  SELECT wr.*, u.display_name AS authored_by_name
    FROM weekly_reports wr
    LEFT JOIN public.users u ON u.id = wr.authored_by
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

/** May write the report's content: the assigned super, the assigned PM, or an admin/director. */
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

  return isAssignedSuper(projectRow, actor) || pmPowers;
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
      return isAssignedSuper(projectRow, actor) || pmPowers || reportRow.authored_by === actor.id;
    case "draft":
      return pmPowers;
    case "approved":
    case "sent":
      return pmPowers;
    default:
      return false;
  }
}

export interface CreateWeeklyReportInput {
  clientSubmissionId: string;
  weeklyReportProjectId: string;
  weekOf: string;
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
    `SELECT id FROM weekly_reports WHERE client_submission_id = $1::uuid LIMIT 1`,
    [input.clientSubmissionId],
  );
  if (existingBySubmission.rows[0]) {
    const report = await getWeeklyReportDetail(client, existingBySubmission.rows[0].id);
    if (!report) throw new AppError(404, "Weekly report not found");
    return { report, created: false };
  }

  const existingForWeek = await client.query(
    `SELECT id FROM weekly_reports
      WHERE weekly_report_project_id = $1::uuid AND week_of = $2::date AND is_active
      ORDER BY version DESC LIMIT 1`,
    [input.weeklyReportProjectId, input.weekOf],
  );
  if (existingForWeek.rows[0]) {
    throw new AppError(409, "A report already exists for this week");
  }

  // ON CONFLICT DO NOTHING rather than trusting the pre-flight SELECTs. Those two lookups do not
  // serialise anything: two retries of the same submit, or two people opening the same week, can both
  // observe no row and both reach this INSERT. Without this the loser gets a raw 23505 surfaced as a
  // 500, which is precisely the flaky-LTE case the idempotency key exists to make boring.
  const result = await client.query(
    `INSERT INTO weekly_reports (
       client_submission_id, weekly_report_project_id, deal_id, week_of,
       projected_duration_weeks, authored_by, authored_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::uuid, now())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.clientSubmissionId,
      input.weeklyReportProjectId,
      projectRow.deal_id,
      input.weekOf,
      projectRow.projected_duration_weeks,
      actor.id,
    ],
  );

  if (result.rows.length === 0) {
    // Somebody won the race. Which conflict it was decides the answer: the SAME submission id is this
    // caller retrying (200, idempotent), a DIFFERENT one is two people starting the same week (409).
    const bySubmission = await client.query(
      `SELECT id FROM weekly_reports WHERE client_submission_id = $1::uuid LIMIT 1`,
      [input.clientSubmissionId],
    );
    if (bySubmission.rows[0]) {
      const report = await getWeeklyReportDetail(client, bySubmission.rows[0].id);
      if (!report) throw new AppError(404, "Weekly report not found");
      return { report, created: false };
    }
    throw new AppError(409, "A report already exists for this week");
  }

  const report = await getWeeklyReportDetail(client, result.rows[0].id);
  if (!report) throw new AppError(500, "Weekly report could not be read back after creation");
  return { report, created: true };
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

  if (has(patch, "workCompleted")) set("work_completed", normalizeBody(patch.workCompleted));
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
// dictation loop writing an unbounded row, not to constrain anyone writing prose.
const MAX_SECTION_CHARS = 20_000;

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
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
    throw new AppError(400, "weatherDelayDays must be a whole number of days");
  }
  return parsed;
}

async function loadReportWithProject(client: QueryExecutor, id: string) {
  const result = await client.query(
    `SELECT * FROM weekly_reports WHERE id = $1::uuid AND is_active LIMIT 1`,
    [id],
  );
  const reportRow = result.rows[0];
  if (!reportRow) throw new AppError(404, "Weekly report not found");

  const projectRow = await getWeeklyReportProjectRow(client, reportRow.weekly_report_project_id);
  if (!projectRow) throw new AppError(404, "Weekly report project not found");
  return { reportRow, projectRow };
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
  // disagree with the PDF they were emailed.
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

const MAX_REPORT_PHOTOS = 60;
const MAX_CAPTION_CHARS = 500;

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
 * The photo picker's candidate set: this deal's photos from the 14 days ending on `week_of`.
 *
 * `alreadyUsedOn` marks photos that appeared on an earlier report so the super does not repeat them —
 * shown rather than hidden, because re-using a photo is sometimes right (a defect photographed last
 * week that is now fixed).
 */
export async function listWeeklyReportPhotoCandidates(
  client: QueryExecutor,
  reportId: string,
): Promise<Array<WeeklyReportPhoto & { alreadyUsedOn: string | null; selected: boolean }>> {
  const { reportRow } = await loadReportWithProject(client, reportId);
  const weekOf = toIsoDate(reportRow.week_of)!;
  const window = weeklyReportPhotoWindow(weekOf);

  const result = await client.query(
    `SELECT f.id AS file_id,
            f.description AS original_description,
            f.taken_at, f.created_at, f.mime_type,
            selected.caption AS selected_caption,
            selected.sort_order AS selected_sort_order,
            (selected.file_id IS NOT NULL) AS selected,
            prior.week_of AS already_used_on
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
        AND (COALESCE(f.taken_at, f.created_at))::date BETWEEN $3::date AND $4::date
      ORDER BY COALESCE(f.taken_at, f.created_at) DESC`,
    [reportId, reportRow.deal_id, window.from, window.to, weekOf],
  );

  return result.rows.map((row) => ({
    fileId: row.file_id,
    // For an ALREADY-SELECTED photo the stored caption wins outright, null included: `??` treated a
    // deliberately cleared caption as absent and restored the capture description, so the user could
    // not blank a caption and have it stay blank. The description is only a default for photos the
    // user has not selected yet.
    caption: row.selected ? (row.selected_caption ?? null) : (row.original_description ?? null),
    originalDescription: row.original_description ?? null,
    sortOrder: Number(row.selected_sort_order ?? 0),
    takenAt: toIsoTimestamp(row.taken_at ?? row.created_at),
    mimeType: row.mime_type ?? null,
    alreadyUsedOn: toIsoDate(row.already_used_on),
    selected: Boolean(row.selected),
  }));
}

/**
 * Move a report along the ladder.
 *
 * `remaining_weeks` is computed and STORED on submit rather than at render time, so a report already in
 * the PM's queue keeps the arithmetic it was written with even if the projected duration is revised.
 */
export async function transitionWeeklyReport(
  client: QueryExecutor,
  id: string,
  to: WeeklyReportStatus,
  actor: WeeklyReportActor,
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
  if ((to === "pending_review" || to === "approved" || to === "sent") && !reportRow.work_completed) {
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
       (SELECT display_name FROM public.users WHERE id = $2::uuid) AS super_name`,
    [projectRow.trock_pm_user_id, projectRow.trock_super_user_id],
  );
  const row = names.rows[0] ?? {};

  return {
    propertyDisplayName: projectRow.property_display_name ?? null,
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

export async function listWeeklyReports(
  client: QueryExecutor,
  filters: { projectId?: string | null; status?: string | null; from?: string | null; to?: string | null } = {},
): Promise<WeeklyReportDetail[]> {
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
  return result.rows.map((row) => mapReportRow(row, []));
}
