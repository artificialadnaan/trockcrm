import type { PoolClient } from "pg";
import {
  WEEKLY_REPORT_PROJECT_STATUSES,
  WON_DEAL_STAGE_SLUGS,
  isIsoDateString,
  type WeeklyReportProjectStatus,
} from "@trock-crm/shared/types";
import { trockTeamColumns, trockTeamJoins } from "@trock-crm/shared/lib/weeklyReportTeam";
import { businessToday } from "../../lib/period.js";
import { AppError } from "../../middleware/error-handler.js";

export { trockTeamColumns, trockTeamJoins };

export type QueryExecutor = Pick<PoolClient, "query">;

/** The four client-side roles that print on the report, in the order the reference PDF lists them. */
export const WEEKLY_REPORT_CLIENT_ROLES = ["doc", "pm", "rm", "cm"] as const;
export type WeeklyReportClientRole = (typeof WEEKLY_REPORT_CLIENT_ROLES)[number];

export interface WeeklyReportClientContact {
  name: string | null;
  email: string | null;
}

export interface WeeklyReportProject {
  id: string;
  dealId: string;
  dealName: string | null;
  dealNumber: string | null;
  projectNumber: string | null;
  propertyDisplayName: string | null;
  clientName: string | null;
  clientTeam: Record<WeeklyReportClientRole, WeeklyReportClientContact>;
  /** The roster row — WHO holds the slot. Null on setups made before the roster link existed. */
  trockPmResponderId: string | null;
  /** The CRM login that person signs in with, or null when they have none. Decides who may approve/send. */
  trockPmUserId: string | null;
  trockPmName: string | null;
  trockSuperResponderId: string | null;
  trockSuperUserId: string | null;
  trockSuperName: string | null;
  contractDate: string | null;
  contractDateNote: string | null;
  projectStartDate: string | null;
  projectStartDateNote: string | null;
  projectCompletionDate: string | null;
  projectCompletionDateNote: string | null;
  projectedDurationWeeks: number | null;
  cadenceWeekday: number;
  cadenceStartDate: string;
  cadenceEndDate: string | null;
  status: WeeklyReportProjectStatus;
  createdAt: string;
  updatedAt: string;
}

/** Every column the API reads, joined to the names the dashboard renders. */
const PROJECT_SELECT = `
  SELECT wrp.*,
         d.name              AS deal_name,
         d.deal_number       AS deal_number,
         d.project_number    AS project_number,
${trockTeamColumns()}
    FROM weekly_report_projects wrp
    JOIN deals d          ON d.id = wrp.deal_id
${trockTeamJoins("wrp")}
`;

// `date` columns come back from node-postgres as JS Date objects when the type parser is left at its
// default, and as strings when a parser is installed. Normalising here rather than at every call site
// keeps a `2026-08-13` from becoming `2026-08-12T19:00:00` for anyone west of UTC.
function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return null;
}

function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function mapWeeklyReportProject(row: Record<string, any>): WeeklyReportProject {
  return {
    id: row.id,
    dealId: row.deal_id,
    dealName: row.deal_name ?? null,
    dealNumber: row.deal_number ?? null,
    projectNumber: row.project_number ?? null,
    propertyDisplayName: row.property_display_name ?? null,
    clientName: row.client_name ?? null,
    clientTeam: {
      doc: { name: row.client_doc_name ?? null, email: row.client_doc_email ?? null },
      pm: { name: row.client_pm_name ?? null, email: row.client_pm_email ?? null },
      rm: { name: row.client_rm_name ?? null, email: row.client_rm_email ?? null },
      cm: { name: row.client_cm_name ?? null, email: row.client_cm_email ?? null },
    },
    trockPmResponderId: row.trock_pm_responder_id ?? null,
    trockPmUserId: row.trock_pm_user_id ?? null,
    trockPmName: row.trock_pm_name ?? null,
    trockSuperResponderId: row.trock_super_responder_id ?? null,
    trockSuperUserId: row.trock_super_user_id ?? null,
    trockSuperName: row.trock_super_name ?? null,
    contractDate: toIsoDate(row.contract_date),
    contractDateNote: row.contract_date_note ?? null,
    projectStartDate: toIsoDate(row.project_start_date),
    projectStartDateNote: row.project_start_date_note ?? null,
    projectCompletionDate: toIsoDate(row.project_completion_date),
    projectCompletionDateNote: row.project_completion_date_note ?? null,
    projectedDurationWeeks: row.projected_duration_weeks ?? null,
    cadenceWeekday: Number(row.cadence_weekday),
    cadenceStartDate: toIsoDate(row.cadence_start_date)!,
    cadenceEndDate: toIsoDate(row.cadence_end_date),
    status: row.status,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/**
 * The project header T-Rock Cam renders, and NOTHING else off the setup row.
 *
 * `WeeklyReportProject` carries `clientTeam` — four client contacts, by name and email. The CRM dashboard
 * needs those; the phone does not, and /api/field is reachable by every field user in the company. An
 * explicit projection rather than a delete-list, so a column added to the setup row later is off the
 * field surface by default instead of on it.
 */
export function toFieldWeeklyReportProject(project: WeeklyReportProject) {
  return {
    id: project.id,
    dealId: project.dealId,
    dealName: project.dealName,
    propertyDisplayName: project.propertyDisplayName,
    clientName: project.clientName,
    trockPmName: project.trockPmName,
    trockSuperName: project.trockSuperName,
    projectStartDate: project.projectStartDate,
    projectCompletionDate: project.projectCompletionDate,
    projectedDurationWeeks: project.projectedDurationWeeks,
    cadenceWeekday: project.cadenceWeekday,
  };
}

export interface WeeklyReportProjectInput {
  dealId: string;
  propertyDisplayName?: string | null;
  clientName?: string | null;
  clientTeam?: Partial<Record<WeeklyReportClientRole, Partial<WeeklyReportClientContact>>>;
  /**
   * Field-team roster ids. The CALLER never supplies a user id: `trock_*_user_id` is derived from the
   * roster row's email server-side, so a client cannot nominate an arbitrary login into the slot that
   * decides who may approve and send.
   */
  trockPmResponderId?: string | null;
  trockSuperResponderId?: string | null;
  contractDate?: string | null;
  contractDateNote?: string | null;
  projectStartDate?: string | null;
  projectStartDateNote?: string | null;
  projectCompletionDate?: string | null;
  projectCompletionDateNote?: string | null;
  projectedDurationWeeks?: number | null;
  cadenceWeekday: number;
  cadenceStartDate: string;
  cadenceEndDate?: string | null;
  status?: WeeklyReportProjectStatus;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `null`/`undefined` mean "clear it"; a string is trimmed. Anything else is REJECTED.
 *
 * Coercing a supplied non-string to null made `{"clientName": 123}` a successful request that wiped
 * the client's name — a malformed payload silently destroying data instead of being refused.
 */
function normalizeText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new AppError(400, "Expected a text value");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value: unknown, label: string): string | null {
  const trimmed = normalizeText(value);
  if (trimmed == null) return null;
  const lowered = trimmed.toLowerCase();
  // Validated on write rather than on send: a typo caught while setting the project up is a two-second
  // fix, whereas the same typo surfacing during the send flow blocks a report the client is waiting for.
  if (!EMAIL_PATTERN.test(lowered)) {
    throw new AppError(400, `${label} must be a valid email address`);
  }
  return lowered;
}

function normalizeOptionalDate(value: unknown, label: string): string | null {
  const trimmed = normalizeText(value);
  if (trimmed == null) return null;
  if (!isIsoDateString(trimmed)) {
    throw new AppError(400, `${label} must be a YYYY-MM-DD date`);
  }
  return trimmed;
}

function normalizeOptionalInt(value: unknown, label: string, max: number): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new AppError(400, `${label} must be a whole number between 0 and ${max}`);
  }
  return parsed;
}

/**
 * Validate and normalise a setup payload.
 *
 * Rejecting here rather than letting the DB CHECKs fire turns a 500-shaped constraint violation into a
 * 400 the form can render against the offending field.
 */
export function normalizeWeeklyReportProjectInput(input: WeeklyReportProjectInput) {
  const cadenceWeekday = Number(input.cadenceWeekday);
  if (!Number.isInteger(cadenceWeekday) || cadenceWeekday < 0 || cadenceWeekday > 6) {
    throw new AppError(400, "cadenceWeekday must be an integer 0-6 (0 = Sunday)");
  }
  const cadenceStartDate = normalizeOptionalDate(input.cadenceStartDate, "cadenceStartDate");
  if (!cadenceStartDate) {
    throw new AppError(400, "cadenceStartDate is required");
  }
  const cadenceEndDate = normalizeOptionalDate(input.cadenceEndDate, "cadenceEndDate");
  if (cadenceEndDate && cadenceEndDate < cadenceStartDate) {
    throw new AppError(400, "cadenceEndDate cannot precede cadenceStartDate");
  }
  const status = input.status ?? "active";
  if (!(WEEKLY_REPORT_PROJECT_STATUSES as readonly string[]).includes(status)) {
    throw new AppError(400, `status must be one of ${WEEKLY_REPORT_PROJECT_STATUSES.join(", ")}`);
  }

  const team = input.clientTeam ?? {};
  return {
    propertyDisplayName: normalizeText(input.propertyDisplayName),
    clientName: normalizeText(input.clientName),
    clientDocName: normalizeText(team.doc?.name),
    clientDocEmail: normalizeEmail(team.doc?.email, "Client DOC email"),
    clientPmName: normalizeText(team.pm?.name),
    clientPmEmail: normalizeEmail(team.pm?.email, "Client PM email"),
    clientRmName: normalizeText(team.rm?.name),
    clientRmEmail: normalizeEmail(team.rm?.email, "Client RM email"),
    clientCmName: normalizeText(team.cm?.name),
    clientCmEmail: normalizeEmail(team.cm?.email, "Client CM email"),
    trockPmResponderId: normalizeText(input.trockPmResponderId),
    trockSuperResponderId: normalizeText(input.trockSuperResponderId),
    contractDate: normalizeOptionalDate(input.contractDate, "contractDate"),
    contractDateNote: normalizeText(input.contractDateNote),
    projectStartDate: normalizeOptionalDate(input.projectStartDate, "projectStartDate"),
    projectStartDateNote: normalizeText(input.projectStartDateNote),
    projectCompletionDate: normalizeOptionalDate(input.projectCompletionDate, "projectCompletionDate"),
    projectCompletionDateNote: normalizeText(input.projectCompletionDateNote),
    // 520 weeks = 10 years. A duration beyond that is a typo (someone typing days into a weeks field),
    // and it would render an absurd Projected bar on the client-facing PDF.
    projectedDurationWeeks: normalizeOptionalInt(input.projectedDurationWeeks, "projectedDurationWeeks", 520),
    cadenceWeekday,
    cadenceStartDate,
    cadenceEndDate,
    status: status as WeeklyReportProjectStatus,
  };
}

export async function listWeeklyReportProjects(
  client: QueryExecutor,
  filters: { status?: string | null; search?: string | null } = {},
): Promise<WeeklyReportProject[]> {
  const params: unknown[] = [];
  const where: string[] = ["wrp.is_active"];

  if (filters.status && (WEEKLY_REPORT_PROJECT_STATUSES as readonly string[]).includes(filters.status)) {
    params.push(filters.status);
    where.push(`wrp.status = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    where.push(
      `(wrp.property_display_name ILIKE $${params.length}
        OR wrp.client_name ILIKE $${params.length}
        OR d.name ILIKE $${params.length}
        OR d.project_number ILIKE $${params.length})`,
    );
  }

  const result = await client.query(
    `${PROJECT_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(wrp.property_display_name, d.name) ASC`,
    params,
  );
  return result.rows.map(mapWeeklyReportProject);
}

export async function getWeeklyReportProject(
  client: QueryExecutor,
  id: string,
): Promise<WeeklyReportProject | null> {
  const result = await client.query(`${PROJECT_SELECT} WHERE wrp.id = $1::uuid AND wrp.is_active LIMIT 1`, [id]);
  return result.rows[0] ? mapWeeklyReportProject(result.rows[0]) : null;
}

/** Raw row (snake_case) — used by the reports service, which needs the cadence fields without the join. */
export async function getWeeklyReportProjectRow(
  client: QueryExecutor,
  id: string,
): Promise<Record<string, any> | null> {
  const result = await client.query(
    `SELECT * FROM weekly_report_projects WHERE id = $1::uuid AND is_active LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createWeeklyReportProject(
  client: QueryExecutor,
  input: WeeklyReportProjectInput,
  actorUserId: string,
  officeId: string,
): Promise<WeeklyReportProject> {
  const values = normalizeWeeklyReportProjectInput(input);
  const pm = await resolveRosterAssignee(
    client, officeId, values.trockPmResponderId, "project_manager", "Project manager",
  );
  const superintendent = await resolveRosterAssignee(
    client, officeId, values.trockSuperResponderId, "superintendent", "Superintendent",
  );

  // The deal must exist in THIS office, be live, and be WON.
  //
  // Weekly reports are a construction-phase deliverable — a client does not receive a weekly progress
  // update on a job that was never awarded. Enforced server-side rather than left to the picker: the
  // picker is one caller, and a cadence attached to an open or lost deal quietly generates outstanding
  // weeks that leadership then chases somebody about.
  const deal = await client.query(
    `SELECT d.id,
            COALESCE(psc.slug, '') AS stage_slug,
            COALESCE(d.bid_board_stage_slug, '') AS bid_board_stage_slug
       FROM deals d
       LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.id = $1::uuid
        AND d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
      LIMIT 1`,
    [input.dealId],
  );
  const dealRow = deal.rows[0];
  if (!dealRow) {
    throw new AppError(404, "Deal not found");
  }
  // Either side of the dual-record model counts: a Bid Board-owned deal carries its terminal state in
  // bid_board_stage_slug while its CRM stage_id can still point at a non-terminal stage.
  const isWon =
    WON_DEAL_STAGE_SLUGS.includes(dealRow.stage_slug) ||
    WON_DEAL_STAGE_SLUGS.includes(dealRow.bid_board_stage_slug);
  if (!isWon) {
    throw new AppError(400, "Weekly reports can only be set up on a Won project");
  }

  const existing = await client.query(
    `SELECT id FROM weekly_report_projects WHERE deal_id = $1::uuid AND is_active LIMIT 1`,
    [input.dealId],
  );
  if (existing.rows[0]) {
    throw new AppError(409, "This project already has a weekly report setup");
  }

  const result = await client.query(
    `INSERT INTO weekly_report_projects (
       deal_id, property_display_name, client_name,
       client_doc_name, client_doc_email, client_pm_name, client_pm_email,
       client_rm_name, client_rm_email, client_cm_name, client_cm_email,
       trock_pm_user_id, trock_super_user_id,
       trock_pm_responder_id, trock_super_responder_id,
       contract_date, contract_date_note,
       project_start_date, project_start_date_note,
       project_completion_date, project_completion_date_note,
       projected_duration_weeks, cadence_weekday, cadence_start_date, cadence_end_date,
       status, created_by
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12::uuid, $13::uuid, $14::uuid, $15::uuid,
       $16::date, $17, $18::date, $19, $20::date, $21,
       $22, $23, $24::date, $25::date, $26, $27::uuid
     ) ON CONFLICT DO NOTHING
       RETURNING id`,
    [
      input.dealId,
      values.propertyDisplayName,
      values.clientName,
      values.clientDocName,
      values.clientDocEmail,
      values.clientPmName,
      values.clientPmEmail,
      values.clientRmName,
      values.clientRmEmail,
      values.clientCmName,
      values.clientCmEmail,
      pm?.userId ?? null,
      superintendent?.userId ?? null,
      pm?.responderId ?? null,
      superintendent?.responderId ?? null,
      values.contractDate,
      values.contractDateNote,
      values.projectStartDate,
      values.projectStartDateNote,
      values.projectCompletionDate,
      values.projectCompletionDateNote,
      values.projectedDurationWeeks,
      values.cadenceWeekday,
      values.cadenceStartDate,
      values.cadenceEndDate,
      values.status,
      actorUserId,
    ],
  );

  // ON CONFLICT rather than trusting the existence check above: that SELECT serialises nothing, so two
  // concurrent setups for the same deal both pass it and one hits weekly_report_projects_deal_uidx —
  // surfacing a raw 23505 as a 500 instead of the 409 this case already has an answer for.
  if (result.rows.length === 0) {
    throw new AppError(409, "This project already has a weekly report setup");
  }

  // A setup created ALREADY stopped never makes an active -> paused transition for the ledger to catch,
  // so the interval is opened here instead. Anchored at the cadence start, which is the earliest week it
  // could ever have owed: whenever someone sets it to Active, it starts owing from that day, not from a
  // backlog it spent its whole life paused for.
  if (values.status !== "active") {
    await openWeeklyReportPause(client, result.rows[0].id, values.cadenceStartDate, actorUserId);
  }

  const created = await getWeeklyReportProject(client, result.rows[0].id);
  if (!created) throw new AppError(500, "Weekly report project could not be read back after creation");
  return created;
}

/** Columns a PATCH may touch, mapped to their normalised value key. */
const UPDATABLE_COLUMNS: Record<string, string> = {
  property_display_name: "propertyDisplayName",
  client_name: "clientName",
  client_doc_name: "clientDocName",
  client_doc_email: "clientDocEmail",
  client_pm_name: "clientPmName",
  client_pm_email: "clientPmEmail",
  client_rm_name: "clientRmName",
  client_rm_email: "clientRmEmail",
  client_cm_name: "clientCmName",
  client_cm_email: "clientCmEmail",
  // trock_* is deliberately ABSENT from this map. Those four columns are written as a unit by the team
  // block in updateWeeklyReportProject: the user id is DERIVED from the roster row, not patched, and
  // letting a caller reach it through the generic loop is exactly the "nominate your own login into the
  // approval slot" hole resolveRosterAssignee exists to close.
  contract_date: "contractDate",
  contract_date_note: "contractDateNote",
  project_start_date: "projectStartDate",
  project_start_date_note: "projectStartDateNote",
  project_completion_date: "projectCompletionDate",
  project_completion_date_note: "projectCompletionDateNote",
  projected_duration_weeks: "projectedDurationWeeks",
  cadence_weekday: "cadenceWeekday",
  cadence_start_date: "cadenceStartDate",
  cadence_end_date: "cadenceEndDate",
  status: "status",
};

/** Columns that need an explicit cast so a null parameter is not inferred as text. */
const COLUMN_CASTS: Record<string, string> = {
  contract_date: "::date",
  project_start_date: "::date",
  project_completion_date: "::date",
  cadence_start_date: "::date",
  cadence_end_date: "::date",
};

/** Which patch key, if supplied, authorises writing each column. Nested client-team keys are special-cased. */
const COLUMN_PATCH_KEYS: Record<string, keyof WeeklyReportProjectInput> = {
  property_display_name: "propertyDisplayName",
  client_name: "clientName",
  contract_date: "contractDate",
  contract_date_note: "contractDateNote",
  project_start_date: "projectStartDate",
  project_start_date_note: "projectStartDateNote",
  project_completion_date: "projectCompletionDate",
  project_completion_date_note: "projectCompletionDateNote",
  projected_duration_weeks: "projectedDurationWeeks",
  cadence_weekday: "cadenceWeekday",
  cadence_start_date: "cadenceStartDate",
  cadence_end_date: "cadenceEndDate",
  status: "status",
};
const CLIENT_TEAM_COLUMNS: Record<string, { role: WeeklyReportClientRole; field: "name" | "email" }> = {
  client_doc_name: { role: "doc", field: "name" },
  client_doc_email: { role: "doc", field: "email" },
  client_pm_name: { role: "pm", field: "name" },
  client_pm_email: { role: "pm", field: "email" },
  client_rm_name: { role: "rm", field: "name" },
  client_rm_email: { role: "rm", field: "email" },
  client_cm_name: { role: "cm", field: "name" },
  client_cm_email: { role: "cm", field: "email" },
};

/** Cadence columns: retroactively changing these rewrites which weeks were ever owed. */
const CADENCE_COLUMNS = ["cadence_weekday", "cadence_start_date"] as const;

/**
 * @param options.asOf the business day a pause is recorded as starting or ending. INJECTABLE FOR TESTS
 *   ONLY — the route deliberately does not forward the request's `?asOf`, because a client-chosen date
 *   on a WRITE could backdate a pause across weeks that were genuinely missed and quietly clear them off
 *   the board. Reads may look at any date they like; the ledger records when it actually happened.
 */
export async function updateWeeklyReportProject(
  client: QueryExecutor,
  id: string,
  patch: Partial<WeeklyReportProjectInput>,
  officeId: string,
  options: { actorUserId?: string | null; asOf?: string } = {},
): Promise<WeeklyReportProject> {
  const current = await getWeeklyReportProjectRow(client, id);
  if (!current) throw new AppError(404, "Weekly report project not found");

  // Normalise the MERGED shape rather than the patch alone: cadenceEndDate-vs-cadenceStartDate and the
  // weekday range are cross-field rules, and validating a bare patch would let a lone cadenceEndDate
  // slide past the comparison it is supposed to fail.
  const merged: WeeklyReportProjectInput = {
    dealId: current.deal_id,
    propertyDisplayName: pick(patch, "propertyDisplayName", current.property_display_name),
    clientName: pick(patch, "clientName", current.client_name),
    clientTeam: {
      doc: pickContact(patch, "doc", current.client_doc_name, current.client_doc_email),
      pm: pickContact(patch, "pm", current.client_pm_name, current.client_pm_email),
      rm: pickContact(patch, "rm", current.client_rm_name, current.client_rm_email),
      cm: pickContact(patch, "cm", current.client_cm_name, current.client_cm_email),
    },
    trockPmResponderId: pick(patch, "trockPmResponderId", current.trock_pm_responder_id),
    trockSuperResponderId: pick(patch, "trockSuperResponderId", current.trock_super_responder_id),
    contractDate: pick(patch, "contractDate", toIsoDate(current.contract_date)),
    contractDateNote: pick(patch, "contractDateNote", current.contract_date_note),
    projectStartDate: pick(patch, "projectStartDate", toIsoDate(current.project_start_date)),
    projectStartDateNote: pick(patch, "projectStartDateNote", current.project_start_date_note),
    projectCompletionDate: pick(patch, "projectCompletionDate", toIsoDate(current.project_completion_date)),
    projectCompletionDateNote: pick(patch, "projectCompletionDateNote", current.project_completion_date_note),
    projectedDurationWeeks: pick(patch, "projectedDurationWeeks", current.projected_duration_weeks),
    cadenceWeekday: pick(patch, "cadenceWeekday", Number(current.cadence_weekday)),
    cadenceStartDate: pick(patch, "cadenceStartDate", toIsoDate(current.cadence_start_date)),
    cadenceEndDate: pick(patch, "cadenceEndDate", toIsoDate(current.cadence_end_date)),
    status: pick(patch, "status", current.status),
  };
  const values = normalizeWeeklyReportProjectInput(merged) as Record<string, any>;

  // Assignees are re-resolved on every patch, not just on create: the PATCH route is open to `rep` users,
  // and `trock_pm_user_id` is exactly what decides who may approve and send. Re-resolving also re-reads
  // the roster row, so an edit made after that person was deactivated is refused rather than silently
  // carried forward.
  const patchesPm = Object.prototype.hasOwnProperty.call(patch, "trockPmResponderId");
  const patchesSuper = Object.prototype.hasOwnProperty.call(patch, "trockSuperResponderId");
  const pm = patchesPm
    ? await resolveRosterAssignee(client, officeId, values.trockPmResponderId, "project_manager", "Project manager")
    : null;
  const superintendent = patchesSuper
    ? await resolveRosterAssignee(
        client, officeId, values.trockSuperResponderId, "superintendent", "Superintendent",
      )
    : null;

  // Write ONLY the columns this patch actually supplied. Writing every column from the merged row means
  // two people editing different fields race: both read the same original, and whoever commits second
  // restores the other's field from its stale fallback.
  const assignments: string[] = [];
  const params: unknown[] = [];
  const write = (column: string) => {
    params.push(values[UPDATABLE_COLUMNS[column]!]);
    assignments.push(`${column} = $${params.length}${COLUMN_CASTS[column] ?? ""}`);
  };
  /** A column whose value is derived rather than taken from the normalised patch. */
  const writeValue = (column: string, value: unknown, cast = "") => {
    params.push(value);
    assignments.push(`${column} = $${params.length}${cast}`);
  };

  // The roster id and the login it resolves to move together, ALWAYS. Writing one without the other
  // leaves a project whose printed PM is one person and whose approver is another — and clearing the
  // slot has to clear both, or the old approver silently keeps their rights over an unassigned project.
  if (patchesPm) {
    writeValue("trock_pm_responder_id", pm?.responderId ?? null, "::uuid");
    writeValue("trock_pm_user_id", pm?.userId ?? null, "::uuid");
  }
  if (patchesSuper) {
    writeValue("trock_super_responder_id", superintendent?.responderId ?? null, "::uuid");
    writeValue("trock_super_user_id", superintendent?.userId ?? null, "::uuid");
  }

  const touchedCadence: string[] = [];
  for (const [column, key] of Object.entries(COLUMN_PATCH_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if ((CADENCE_COLUMNS as readonly string[]).includes(column)) touchedCadence.push(column);
    write(column);
  }
  for (const [column, { role, field }] of Object.entries(CLIENT_TEAM_COLUMNS)) {
    const supplied = patch.clientTeam?.[role];
    if (!supplied || !Object.prototype.hasOwnProperty.call(supplied, field)) continue;
    write(column);
  }

  // Moving the cadence after reports exist retroactively rewrites which weeks were ever owed: the
  // Thursdays already filed stop matching any generated date, and a run of Fridays nobody was asked for
  // appears as missing and late. Blocked outright rather than modelled as an effective-dated cadence,
  // which is a bigger change than this feature needs today. `cadence_end_date` is deliberately NOT in
  // this set — stopping future reporting is a normal, forward-only act.
  if (touchedCadence.length > 0) {
    const filed = await client.query(
      `SELECT 1 FROM weekly_reports WHERE weekly_report_project_id = $1::uuid AND is_active LIMIT 1`,
      [id],
    );
    if (filed.rows.length > 0) {
      throw new AppError(
        409,
        "Reporting has already started on this project — the reporting day and start date cannot be changed. Set a reporting end date and create a new setup instead.",
      );
    }
  }

  if (assignments.length === 0) return (await getWeeklyReportProject(client, id))!;

  params.push(id);
  const result = await client.query(
    `UPDATE weekly_report_projects
        SET ${assignments.join(", ")}, updated_at = now()
      WHERE id = $${params.length}::uuid AND is_active
      RETURNING id`,
    params,
  );
  if (result.rows.length === 0) throw new AppError(404, "Weekly report project not found");

  // Recorded only when the status genuinely moved. Re-saving the form with the same status is not a new
  // pause, and treating it as one would restart the interval and re-bill the weeks already skipped.
  if (values.status !== current.status) {
    await recordWeeklyReportStatusChange(client, {
      projectId: id,
      from: String(current.status),
      to: values.status,
      onDate: options.asOf ?? businessToday(),
      actorUserId: options.actorUserId ?? null,
    });
  }

  const updated = await getWeeklyReportProject(client, id);
  if (!updated) throw new AppError(404, "Weekly report project not found");
  return updated;
}

/** Everything that is not `active` is stopped: the CRM makes the same promise about paused and completed. */
function isStoppedStatus(status: string): boolean {
  return status !== "active";
}

/**
 * Open a stretch during which this project owes nothing.
 *
 * ON CONFLICT against `weekly_report_pauses_open_uidx` rather than a prior SELECT: that SELECT
 * serialises nothing, so two PATCHes pausing the same project would both pass it and leave two
 * overlapping open intervals — and the second Resume would then close only one, silently leaving the
 * project stopped forever from the generator's point of view.
 */
async function openWeeklyReportPause(
  client: QueryExecutor,
  projectId: string,
  fromDate: string,
  actorUserId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO weekly_report_pauses (weekly_report_project_id, paused_from, paused_by)
     VALUES ($1::uuid, $2::date, $3::uuid)
     ON CONFLICT (weekly_report_project_id) WHERE resumed_on IS NULL DO NOTHING`,
    [projectId, fromDate, actorUserId],
  );
}

/**
 * Keep the pause ledger in step with a status change.
 *
 * `status` answers only "is this project reporting today", which is not the question the board asks: it
 * regenerates the expected weeks from the cadence start on every read, so a project that spent six weeks
 * paused came back owing all six as missed and late — contradicting the very sentence the form shows
 * when you pause one. The interval is written when reporting stops and closed when it starts again, and
 * the weeks BEFORE the pause are deliberately untouched. They were missed, and they stay missed.
 *
 * paused -> completed (and back) is not a boundary: both are stopped, so the open interval simply runs on.
 */
async function recordWeeklyReportStatusChange(
  client: QueryExecutor,
  input: { projectId: string; from: string; to: string; onDate: string; actorUserId: string | null },
): Promise<void> {
  if (!isStoppedStatus(input.from) && isStoppedStatus(input.to)) {
    await openWeeklyReportPause(client, input.projectId, input.onDate, input.actorUserId);
    return;
  }
  if (isStoppedStatus(input.from) && !isStoppedStatus(input.to)) {
    // GREATEST, so a resume dated before the pause began cannot violate weekly_report_pauses_range and
    // turn a legitimate Resume into a 500. Every open interval is closed, not just one, so a row left
    // open by a direct SQL edit cannot blank the board for a project that is demonstrably reporting again.
    await client.query(
      `UPDATE weekly_report_pauses
          SET resumed_on = GREATEST(paused_from, $2::date),
              resumed_by = $3::uuid,
              updated_at = now()
        WHERE weekly_report_project_id = $1::uuid AND resumed_on IS NULL`,
      [input.projectId, input.onDate, input.actorUserId],
    );
  }
}

function pick<K extends keyof WeeklyReportProjectInput>(
  patch: Partial<WeeklyReportProjectInput>,
  key: K,
  fallback: any,
): any {
  // `undefined` means "not supplied"; an explicit null means "clear it". Collapsing the two would make
  // it impossible to blank a field once set.
  return Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : fallback;
}

function pickContact(
  patch: Partial<WeeklyReportProjectInput>,
  role: WeeklyReportClientRole,
  currentName: unknown,
  currentEmail: unknown,
): Partial<WeeklyReportContactPatch> {
  const supplied = patch.clientTeam?.[role];
  if (!supplied) return { name: currentName as string | null, email: currentEmail as string | null };
  return {
    name: Object.prototype.hasOwnProperty.call(supplied, "name") ? supplied.name ?? null : (currentName as string | null),
    email: Object.prototype.hasOwnProperty.call(supplied, "email") ? supplied.email ?? null : (currentEmail as string | null),
  };
}

type WeeklyReportContactPatch = WeeklyReportClientContact;

/**
 * Soft delete. `is_active = false` rather than DELETE so the reports already sent under this setup keep
 * resolving — their public links are live for 180 days and must not 404 because someone tidied the
 * dashboard.
 */
export async function deactivateWeeklyReportProject(client: QueryExecutor, id: string): Promise<void> {
  const result = await client.query(
    `UPDATE weekly_report_projects SET is_active = false, updated_at = now()
      WHERE id = $1::uuid AND is_active RETURNING id`,
    [id],
  );
  if (!result.rows[0]) throw new AppError(404, "Weekly report project not found");
}

/**
 * Roles that can hold the PM or superintendent slot on a weekly report.
 *
 * `field_contractor` is the T-Rock Cam login role, `construction` is its CRM-side counterpart, and
 * admin/director are included because leadership genuinely does carry projects. `rep` is excluded: the
 * sales roster would bury the handful of real candidates.
 *
 * Deliberately NOT sourced from `field_responders` (0198), whose ids belong to a per-office roster table
 * rather than to `public.users` — and `weekly_report_projects.trock_*_user_id` is a `public.users` FK
 * that the authorisation check compares against the acting user's id. Nor from `deal_team_members`,
 * which is empty in production.
 */
/**
 * Who may hold the PM slot on a weekly-report project.
 *
 * Exported so the test that pins the CRM send boundary can INTERSECT it with the sender roles rather than
 * re-typing both lists. It used to assert two hand-written literals were disjoint, which no source change
 * could ever falsify — widening the send gate to admit `construction` left it green.
 */
export const ASSIGNABLE_ROLES = ["field_contractor", "construction", "admin", "director"] as const;

export interface WeeklyReportAssignableUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

/**
 * Reject an assignee who is not on the office's assignable roster.
 *
 * This is an AUTHORISATION check, not form validation. `trock_pm_user_id` is what `isAssignedPm` reads
 * to decide who may approve and send, and the project PATCH route is open to `rep` users — so without
 * this a rep could set themselves as the PM of any project and thereby grant themselves the approval
 * powers the whole review gate exists to withhold. The FK alone does not care: any real user id passes it.
 */
/**
 * Who counts as a member of this office, and in what role.
 *
 * ONE definition, shared by the picker and by the write-side validation — if the two could drift, the
 * form would offer somebody the API then rejects, or worse, accept somebody the form never offered.
 *
 * Office membership is NOT just `users.office_id`. A multi-office PM or director holds a
 * `public.user_office_access` grant, and authentication already lets them act in the granted office —
 * so keying only on the primary office rejects exactly the people most likely to run a second office's
 * projects. The grant may also carry a `role_override`, which is then the role that applies here.
 * (The same omission has produced a bug in this codebase before, in the deal-reassign guard.)
 */
const OFFICE_MEMBER_SQL = `
  FROM public.users u
  LEFT JOIN public.user_office_access uoa
         ON uoa.user_id = u.id AND uoa.office_id = $OFFICE$::uuid
 WHERE (u.office_id = $OFFICE$::uuid OR uoa.user_id IS NOT NULL)
   AND u.is_active = true
   AND COALESCE(u.is_test_data, false) = false
   AND COALESCE(uoa.role_override, u.role)::text = ANY($ROLES$::text[])
`;

function officeMemberSql(officeParam: number, rolesParam: number): string {
  return OFFICE_MEMBER_SQL.replaceAll("$OFFICE$", `$${officeParam}`).replaceAll("$ROLES$", `$${rolesParam}`);
}

async function assertAssignableUser(
  client: QueryExecutor,
  officeId: string,
  userId: string | null,
  label: string,
): Promise<void> {
  if (!userId) return;
  const result = await client.query(
    `SELECT 1 ${officeMemberSql(2, 3)} AND u.id = $1::uuid LIMIT 1`,
    [userId, officeId, [...ASSIGNABLE_ROLES]],
  );
  if (result.rows.length === 0) {
    throw new AppError(400, `${label} must be an active member of this office's project team`);
  }
}

/** The roster row behind one slot, plus the login it resolves to (null when that person has none). */
export interface ResolvedTrockAssignee {
  responderId: string;
  userId: string | null;
  name: string;
  email: string;
  hasLogin: boolean;
}

/**
 * Turn a field-team roster id into the pair the project row stores.
 *
 * This is the AUTHORISATION boundary, and it is a stricter one than the roles check it replaces. Before,
 * any user holding one of four broad roles could be dropped into the PM slot — which is what
 * `isAssignedPm` reads to decide who may approve and send a client-facing report. Now the id must name an
 * ACTIVE row on the office's field-team roster, a list only a director may write to, AND the row's role
 * must match the slot: a superintendent cannot be installed as the PM, which is precisely the direction
 * that would hand out approval rights.
 *
 * The login is looked up BY EMAIL, the only identifier the two tables share, and is allowed to come back
 * null — five of the fifteen people on the Dallas roster have no CRM account at all. A null login is not
 * an error: that person still owns the slot, still prints on the PDF and still receives reminders at the
 * roster address. What they cannot do is approve or send from the phone, because there is no identity to
 * compare against. That case falls through to the elevated (admin/director) arm the gates already have,
 * and the setup form states it rather than leaving it to be discovered on a Thursday afternoon.
 *
 * The match is deliberately restricted to a SINGLE active non-test user in this office. Two accounts on
 * one address is not a situation to resolve by picking one — that silently decides who may approve.
 */
async function resolveRosterAssignee(
  client: QueryExecutor,
  officeId: string,
  responderId: string | null,
  role: "project_manager" | "superintendent",
  label: string,
): Promise<ResolvedTrockAssignee | null> {
  if (!responderId) return null;

  const roster = await client.query(
    `SELECT id, name, email, role, is_active FROM field_responders WHERE id = $1::uuid LIMIT 1`,
    [responderId],
  );
  const row = roster.rows[0];
  if (!row) {
    throw new AppError(400, `${label} is not on this office's field team`);
  }
  if (!row.is_active) {
    throw new AppError(400, `${row.name} has been removed from the field team and cannot be assigned`);
  }
  if (row.role !== role) {
    const expected = role === "project_manager" ? "a project manager" : "a superintendent";
    throw new AppError(400, `${row.name} is not ${expected} on the field team`);
  }

  // Office membership is NOT just `users.office_id` — a multi-office PM holds a user_office_access grant,
  // and keying only on the primary office would drop exactly the people most likely to run a second
  // office's projects. No role filter: the roster IS the curated list, and gating on `role` again is what
  // made Adam Sherwood (a `rep` login who is genuinely a PM) unassignable in the first place.
  const login = await client.query(
    `SELECT u.id
       FROM public.users u
       LEFT JOIN public.user_office_access uoa ON uoa.user_id = u.id AND uoa.office_id = $2::uuid
      WHERE lower(u.email) = lower($1)
        AND (u.office_id = $2::uuid OR uoa.user_id IS NOT NULL)
        AND u.is_active = true
        AND COALESCE(u.is_test_data, false) = false
      LIMIT 2`,
    [row.email, officeId],
  );

  return {
    responderId: row.id,
    userId: login.rows.length === 1 ? login.rows[0].id : null,
    name: row.name,
    email: row.email,
    hasLogin: login.rows.length === 1,
  };
}

export async function listWeeklyReportAssignableUsers(
  client: QueryExecutor,
  officeId: string,
): Promise<WeeklyReportAssignableUser[]> {
  // ::text on the role, because users.role is the user_role ENUM: comparing it to a text[] raises
  // "operator does not exist: user_role = text" rather than quietly returning nothing.
  const result = await client.query(
    `SELECT DISTINCT u.id, u.display_name, u.email,
            COALESCE(uoa.role_override, u.role) AS role
     ${officeMemberSql(1, 2)}
     ORDER BY u.display_name ASC`,
    [officeId, [...ASSIGNABLE_ROLES]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
  }));
}

/** One selectable field-team member, as the setup form's PM / superintendent pickers render them. */
export interface WeeklyReportAssignableResponder {
  /** `field_responders.id` — what the form submits and the project row stores. */
  id: string;
  name: string;
  email: string;
  role: "superintendent" | "project_manager";
  /**
   * Whether this person holds a CRM login, and can therefore approve and send from the phone. False for
   * the field staff who never needed an account. The form surfaces this rather than hiding them: they are
   * still the right person to name on the report, and a director can still approve on their behalf.
   */
  hasLogin: boolean;
}

/**
 * The field-team roster, which is what the PM and superintendent pickers offer.
 *
 * Replaces a feed built from `public.users` filtered to four broad roles. Against the live Dallas data
 * that feed could offer six of the fifteen active roster members: four are `rep` logins who are genuinely
 * PMs and superintendents, and five have no CRM account at all. The roster is the list a director already
 * curates for the deal Team tab and the QC scorecards, it is constrained to exactly the two roles this
 * feature needs, and it contains all fifteen.
 *
 * `has_login` mirrors resolveRosterAssignee's lookup EXACTLY — same email match, same office-membership
 * rule, same "one unambiguous account or none" test. The two must not drift: if the picker promised a
 * login the write path then declines to resolve, a project would be created whose PM cannot approve it
 * and whose form said they could.
 */
export async function listWeeklyReportAssignableResponders(
  client: QueryExecutor,
  officeId: string,
): Promise<WeeklyReportAssignableResponder[]> {
  const result = await client.query(
    `SELECT fr.id, fr.name, fr.email, fr.role,
            (SELECT count(*)
               FROM public.users u
               LEFT JOIN public.user_office_access uoa
                      ON uoa.user_id = u.id AND uoa.office_id = $1::uuid
              WHERE lower(u.email) = lower(fr.email)
                AND (u.office_id = $1::uuid OR uoa.user_id IS NOT NULL)
                AND u.is_active = true
                AND COALESCE(u.is_test_data, false) = false) = 1 AS has_login
       FROM field_responders fr
      WHERE fr.is_active
      ORDER BY fr.role ASC, lower(fr.name) ASC`,
    [officeId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    hasLogin: row.has_login === true,
  }));
}

/** A Won job that can still be given a weekly-report cadence, as the setup form's project picker shows it. */
export interface WeeklyReportEligibleDeal {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  /** The company the work is being done for — seeds the Client field. */
  clientName: string | null;
  /** Seeds the Contract date field. Null on the ~20% of Won deals that carry no signed date. */
  contractSignedDate: string | null;
}

/**
 * The project picker's feed: ACTIVE, non-test, WON deals in this office that do not already have a live
 * weekly-report setup.
 *
 * Its own endpoint rather than a filter bolted onto `GET /deals`, for three reasons.
 *
 * The Won rule is the one `createWeeklyReportProject` enforces, and it is subtle — a Bid Board-owned deal
 * carries its terminal state in `bid_board_stage_slug` while its CRM `stage_id` can still point at a
 * non-terminal stage, so BOTH sides of the dual-record model count. The picker used no stage filter at
 * all, so it offered all 1,445 active deals and the server refused the other ~970 with a 400 only after
 * the whole form had been filled in. Reusing the create path's predicate is what stops the picker and the
 * write disagreeing again.
 *
 * The already-taken exclusion was being done in the browser against whatever page of results it happened
 * to hold, which silently fails as soon as the list is longer than one page. It is a NOT EXISTS here.
 *
 * And the two fields the form seeds from — the client company and the signed contract date — come back
 * with the row, so picking a job fills them in without a second request.
 */
export async function listWeeklyReportEligibleDeals(
  client: QueryExecutor,
  search: string | null,
  limit = 20,
): Promise<WeeklyReportEligibleDeal[]> {
  const params: unknown[] = [[...WON_DEAL_STAGE_SLUGS]];
  let searchClause = "";
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    searchClause = `AND (d.name ILIKE $${params.length}
                      OR d.project_number ILIKE $${params.length}
                      OR d.deal_number ILIKE $${params.length})`;
  }
  params.push(Math.min(Math.max(limit, 1), 50));

  const result = await client.query(
    `SELECT d.id, d.name, d.deal_number, d.project_number,
            c.name AS client_name,
            d.contract_signed_date
       FROM deals d
       LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       LEFT JOIN companies c ON c.id = d.company_id
      WHERE d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        AND (COALESCE(psc.slug, '') = ANY($1::text[])
             OR COALESCE(d.bid_board_stage_slug, '') = ANY($1::text[]))
        ${searchClause}
        AND NOT EXISTS (
          SELECT 1 FROM weekly_report_projects wrp
           WHERE wrp.deal_id = d.id AND wrp.is_active
        )
      ORDER BY d.name ASC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    dealNumber: row.deal_number ?? null,
    projectNumber: row.project_number ?? null,
    clientName: row.client_name ?? null,
    contractSignedDate: toIsoDate(row.contract_signed_date),
  }));
}

export interface WeeklyReportSettings {
  leadershipRecipientEmails: string[];
  updatedAt: string | null;
}

export async function getWeeklyReportSettings(client: QueryExecutor): Promise<WeeklyReportSettings> {
  const result = await client.query(
    `SELECT leadership_recipient_emails, updated_at FROM weekly_report_settings LIMIT 1`,
  );
  const row = result.rows[0];
  return {
    leadershipRecipientEmails: row?.leadership_recipient_emails ?? [],
    updatedAt: row ? toIsoTimestamp(row.updated_at) : null,
  };
}

export async function updateWeeklyReportSettings(
  client: QueryExecutor,
  emails: unknown,
  actorUserId: string,
): Promise<WeeklyReportSettings> {
  if (!Array.isArray(emails)) {
    throw new AppError(400, "leadershipRecipientEmails must be an array");
  }
  const normalized: string[] = [];
  for (const entry of emails) {
    const email = normalizeEmail(entry, "Leadership recipient");
    // Dedupe case-insensitively — normalizeEmail already lowercases, so a plain Set is enough.
    if (email && !normalized.includes(email)) normalized.push(email);
  }

  // Single-row UPSERT against the `singleton` unique constraint: no prior SELECT, and a concurrent
  // double-save collapses onto the same row instead of creating a second one.
  await client.query(
    `INSERT INTO weekly_report_settings (singleton, leadership_recipient_emails, updated_by)
     VALUES (true, $1::text[], $2::uuid)
     ON CONFLICT (singleton) DO UPDATE
        SET leadership_recipient_emails = EXCLUDED.leadership_recipient_emails,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()`,
    [normalized, actorUserId],
  );
  return getWeeklyReportSettings(client);
}
