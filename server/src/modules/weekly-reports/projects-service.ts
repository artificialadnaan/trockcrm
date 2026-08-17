import type { PoolClient } from "pg";
import {
  WEEKLY_REPORT_PROJECT_STATUSES,
  WON_DEAL_STAGE_SLUGS,
  isIsoDateString,
  type WeeklyReportProjectStatus,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";

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
  trockPmUserId: string | null;
  trockPmName: string | null;
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
         pm.display_name     AS trock_pm_name,
         sup.display_name    AS trock_super_name
    FROM weekly_report_projects wrp
    JOIN deals d          ON d.id = wrp.deal_id
    LEFT JOIN public.users pm  ON pm.id = wrp.trock_pm_user_id
    LEFT JOIN public.users sup ON sup.id = wrp.trock_super_user_id
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
    trockPmUserId: row.trock_pm_user_id ?? null,
    trockPmName: row.trock_pm_name ?? null,
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

export interface WeeklyReportProjectInput {
  dealId: string;
  propertyDisplayName?: string | null;
  clientName?: string | null;
  clientTeam?: Partial<Record<WeeklyReportClientRole, Partial<WeeklyReportClientContact>>>;
  trockPmUserId?: string | null;
  trockSuperUserId?: string | null;
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

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
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
    trockPmUserId: normalizeText(input.trockPmUserId),
    trockSuperUserId: normalizeText(input.trockSuperUserId),
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
): Promise<WeeklyReportProject> {
  const values = normalizeWeeklyReportProjectInput(input);

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
       contract_date, contract_date_note,
       project_start_date, project_start_date_note,
       project_completion_date, project_completion_date_note,
       projected_duration_weeks, cadence_weekday, cadence_start_date, cadence_end_date,
       status, created_by
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12::uuid, $13::uuid, $14::date, $15, $16::date, $17, $18::date, $19,
       $20, $21, $22::date, $23::date, $24, $25::uuid
     ) RETURNING id`,
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
      values.trockPmUserId,
      values.trockSuperUserId,
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
  trock_pm_user_id: "trockPmUserId",
  trock_super_user_id: "trockSuperUserId",
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
  trock_pm_user_id: "::uuid",
  trock_super_user_id: "::uuid",
  contract_date: "::date",
  project_start_date: "::date",
  project_completion_date: "::date",
  cadence_start_date: "::date",
  cadence_end_date: "::date",
};

export async function updateWeeklyReportProject(
  client: QueryExecutor,
  id: string,
  patch: Partial<WeeklyReportProjectInput>,
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
    trockPmUserId: pick(patch, "trockPmUserId", current.trock_pm_user_id),
    trockSuperUserId: pick(patch, "trockSuperUserId", current.trock_super_user_id),
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

  const assignments: string[] = [];
  const params: unknown[] = [];
  for (const [column, key] of Object.entries(UPDATABLE_COLUMNS)) {
    params.push(values[key]);
    assignments.push(`${column} = $${params.length}${COLUMN_CASTS[column] ?? ""}`);
  }
  params.push(id);

  await client.query(
    `UPDATE weekly_report_projects
        SET ${assignments.join(", ")}, updated_at = now()
      WHERE id = $${params.length}::uuid AND is_active`,
    params,
  );

  const updated = await getWeeklyReportProject(client, id);
  if (!updated) throw new AppError(404, "Weekly report project not found");
  return updated;
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
const ASSIGNABLE_ROLES = ["field_contractor", "construction", "admin", "director"] as const;

export interface WeeklyReportAssignableUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

export async function listWeeklyReportAssignableUsers(
  client: QueryExecutor,
  officeId: string,
): Promise<WeeklyReportAssignableUser[]> {
  const result = await client.query(
    `SELECT id, display_name, email, role
       FROM public.users
      WHERE office_id = $1::uuid
        AND is_active = true
        AND COALESCE(is_test_data, false) = false
        -- role::text, because users.role is the user_role ENUM: comparing it to a text[] raises
        -- "operator does not exist: user_role = text" rather than quietly returning nothing.
        AND role::text = ANY($2::text[])
      ORDER BY display_name ASC`,
    [officeId, [...ASSIGNABLE_ROLES]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
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
