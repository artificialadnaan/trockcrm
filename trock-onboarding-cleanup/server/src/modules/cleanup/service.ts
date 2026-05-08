import pg from "pg";
import crypto from "crypto";
import { pool } from "../../lib/db.js";
import type { AuthContext, CleanupStatus, RecordDetail, RecordType } from "./types.js";
import { RECORD_TYPES } from "./types.js";
import { canComplete, missingFields } from "./validators.js";

const DEFAULT_TENANT = process.env.CLEANUP_TENANT_SCHEMA ?? "office_dallas";
const CLOSED_STAGE_SLUGS = ["won", "lost"];
const SKIP_REASONS = new Set([
  "contact_left_company",
  "deal_stalled",
  "customer_unreachable",
  "record_is_duplicate",
  "record_is_junk",
  "historical_no_enrichment_needed",
  "missing_information_not_available",
  "other",
]);

const SKIP_REASON_LABELS: Record<string, string> = {
  contact_left_company: "Contact left company",
  deal_stalled: "Deal stalled",
  customer_unreachable: "Customer unreachable",
  record_is_duplicate: "Record is duplicate",
  record_is_junk: "Record is junk",
  historical_no_enrichment_needed: "Historical no enrichment needed",
  missing_information_not_available: "Missing information not available",
  other: "Other",
};

const TABLE_BY_TYPE = {
  deal: "deals",
  lead: "leads",
  contact: "contacts",
  company: "companies",
} satisfies Record<RecordType, string>;

const TYPE_BY_TABLE = Object.fromEntries(Object.entries(TABLE_BY_TYPE).map(([type, table]) => [table, type])) as Record<string, RecordType>;
type QueryClient = Pick<pg.Pool | pg.PoolClient | pg.Client, "query">;
const OWNER_COLUMN_BY_TYPE = {
  deal: "assigned_rep_id",
  lead: "assigned_rep_id",
  contact: "owner_id",
  company: "owner_id",
} satisfies Record<RecordType, string>;
const MAX_BULK_REASSIGN = 500;
const ADMIN_PROGRESS_PAGE_SIZE = 50;

export function buildProgressPercent(total: number, completed: number, skipped: number) {
  if (total <= 0) return 100;
  return Math.round(((completed + skipped) / total) * 100);
}

function normalizeAuditValue(value: unknown) {
  return value === "" ? null : value;
}

function present(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function normalizeFieldChanges(before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]) {
  return fields
    .map((field) => ({
      field,
      before: normalizeAuditValue(before[field]),
      after: normalizeAuditValue(after[field]),
    }))
    .filter((change) => change.before !== change.after);
}

function activityLinkColumns(type: RecordType, id: string) {
  return {
    dealId: type === "deal" ? id : null,
    leadId: type === "lead" ? id : null,
    contactId: type === "contact" ? id : null,
    companyId: type === "company" ? id : null,
  };
}

async function writeCrmActivityNote(
  client: QueryClient,
  input: {
    type: RecordType;
    recordId: string;
    userId: string;
    subject: string;
    body: string;
    action: string;
  },
) {
  const schema = tenant();
  const links = activityLinkColumns(input.type, input.recordId);
  await client.query(
    `
      INSERT INTO ${quoteIdent(schema)}.activities (
        type,
        responsible_user_id,
        performed_by_user_id,
        source_entity_type,
        source_entity_id,
        deal_id,
        lead_id,
        contact_id,
        company_id,
        subject,
        body,
        hubspot_extra_properties
      )
      VALUES ('note', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
    `,
    [
      input.userId,
      input.userId,
      input.type,
      input.recordId,
      links.dealId,
      links.leadId,
      links.contactId,
      links.companyId,
      input.subject,
      input.body,
      JSON.stringify({
        source: "cleanup_migration",
        cleanupAction: input.action,
      }),
    ],
  );
}

const CLEANUP_META_FIELDS = new Set([
  "cleanup_status",
  "cleanup_completed_at",
  "cleanup_completed_by",
  "skip_reason",
  "skip_notes",
  "needs_leadership_review",
]);

function fieldChangeSummary(change: { field: string; before: unknown; after: unknown }) {
  if (!present(change.before) && present(change.after)) return `${change.field} (added)`;
  if (present(change.before) && !present(change.after)) return `${change.field} (cleared)`;
  return `${change.field} (updated)`;
}

function completionBusinessChanges(changes: Array<{ field: string; before: unknown; after: unknown }>) {
  return changes.filter((change) => !CLEANUP_META_FIELDS.has(change.field));
}

const UPDATE_COLUMNS: Record<RecordType, Set<string>> = {
  deal: new Set([
    "name",
    "assigned_rep_id",
    "primary_contact_id",
    "company_id",
    "property_id",
    "stage_id",
    "dd_estimate",
    "bid_estimate",
    "awarded_amount",
    "description",
    "property_address",
    "property_city",
    "property_state",
    "property_zip",
    "expected_close_date",
    "actual_close_date",
    "next_step",
    "next_step_due_at",
    "budget_status",
    "decision_maker_name",
    "cleanup_status",
    "needs_leadership_review",
  ]),
  lead: new Set([
    "name",
    "company_id",
    "property_id",
    "primary_contact_id",
    "stage_id",
    "assigned_rep_id",
    "sales_rep_id",
    "status",
    "description",
    "project_type",
    "bid_due_date",
    "pre_qual_value",
    "budget_status",
    "decision_maker_name",
    "cleanup_status",
    "needs_leadership_review",
  ]),
  contact: new Set([
    "first_name",
    "last_name",
    "email",
    "phone",
    "mobile",
    "company_id",
    "company_name",
    "job_title",
    "address",
    "city",
    "state",
    "zip",
    "notes",
    "cleanup_status",
    "needs_leadership_review",
  ]),
  company: new Set([
    "name",
    "category",
    "address",
    "city",
    "state",
    "zip",
    "phone",
    "website",
    "notes",
    "cleanup_status",
    "needs_leadership_review",
  ]),
};

function tenant() {
  if (!/^[a-z][a-z0-9_]*$/.test(DEFAULT_TENANT)) throw new Error(`Unsafe tenant schema: ${DEFAULT_TENANT}`);
  return DEFAULT_TENANT;
}

function quoteIdent(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function assertRecordType(value: string): RecordType {
  if (!RECORD_TYPES.includes(value as RecordType)) {
    const allowed = RECORD_TYPES.join(", ");
    const error = new Error(`Unsupported cleanup record type: ${value}. Expected one of ${allowed}`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  return value as RecordType;
}

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    const error = new Error(`${label} must be a valid UUID`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
}

function isAdmin(user: AuthContext) {
  return user.role === "admin" || user.role === "director";
}

function normalizeStatus(value: unknown): CleanupStatus {
  return value === "completed" || value === "skipped" ? value : "pending";
}

function extraKeys(extra: unknown) {
  return extra && typeof extra === "object" && !Array.isArray(extra) ? Object.keys(extra as Record<string, unknown>).sort() : [];
}

function fullName(row: Record<string, unknown>) {
  return [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
}

function recordName(type: RecordType, row: Record<string, unknown>) {
  if (type === "contact") return fullName(row) || String(row.email ?? row.id);
  return String(row.name ?? row.deal_number ?? row.id);
}

function stageJoin(type: RecordType) {
  return type === "deal" || type === "lead" ? "LEFT JOIN public.pipeline_stage_config stage ON stage.id = record.stage_id" : "";
}

function stageSelect(type: RecordType) {
  return type === "deal" || type === "lead"
    ? "stage.id AS stage_id_resolved, stage.slug AS stage_slug, stage.name AS stage_label,"
    : "NULL::uuid AS stage_id_resolved, NULL::text AS stage_slug, NULL::text AS stage_label,";
}

function assignmentWhere(user: AuthContext, params: unknown[]) {
  if (isAdmin(user)) return "";
  params.push(user.id);
  return `AND assignment.assigned_to = $${params.length}`;
}

function rowToDetail(type: RecordType, row: Record<string, unknown>): RecordDetail {
  const data = { ...row };
  delete data.stage_id_resolved;
  delete data.stage_slug;
  delete data.stage_label;
  delete data.assigned_user_id;
  delete data.assigned_user_email;
  delete data.assigned_user_display_name;

  const stage = row.stage_id_resolved
    ? {
        id: String(row.stage_id_resolved),
        slug: String(row.stage_slug),
        label: String(row.stage_label),
      }
    : null;
  const assignedTo = row.assigned_user_id
    ? {
        id: String(row.assigned_user_id),
        email: String(row.assigned_user_email),
        displayName: String(row.assigned_user_display_name),
      }
    : null;
  const sourceHubSpotSnapshot =
    row.hubspot_extra_properties && typeof row.hubspot_extra_properties === "object" && !Array.isArray(row.hubspot_extra_properties)
      ? (row.hubspot_extra_properties as Record<string, unknown>)
      : {};

  const enriched = {
    ...data,
    assignment_reason: row.assignment_reason,
    cleanup_assigned_to: row.cleanup_assigned_to,
  };

  return {
    type,
    id: String(row.id),
    data,
    stage,
    assignedTo,
    sourceHubSpotSnapshot,
    missingFields: missingFields(type, enriched, stage?.slug),
    hubspotExtraPropertyKeys: extraKeys(row.hubspot_extra_properties),
  };
}

async function writeCleanupAudit(
  client: QueryClient,
  input: {
    type: RecordType;
    recordId: string;
    userId: string;
    action: string;
    fieldChanges?: Array<{ field: string; before: unknown; after: unknown }>;
    metadata?: Record<string, unknown>;
  },
) {
  const schema = tenant();
  await client.query(
    `
      INSERT INTO ${quoteIdent(schema)}.cleanup_audit_log (
        record_type, record_id, user_id, action, field_changes, metadata
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
    `,
    [
      input.type,
      input.recordId,
      input.userId,
      input.action,
      JSON.stringify(input.fieldChanges ?? []),
      JSON.stringify({ source: "cleanup app", ...(input.metadata ?? {}) }),
    ],
  );
}

function recordDisplayNameExpression(type: RecordType, alias = "record") {
  if (type === "contact") {
    return `COALESCE(NULLIF(trim(${alias}.first_name || ' ' || ${alias}.last_name), ''), ${alias}.email, ${alias}.id::text)`;
  }
  return `COALESCE(NULLIF(${alias}.name, ''), ${alias}.id::text)`;
}

async function getRecordDetailWithClient(client: QueryClient, type: RecordType, id: string, user: AuthContext) {
  const schema = tenant();
  const table = TABLE_BY_TYPE[type];
  const params: unknown[] = [id];
  const accessClause = assignmentWhere(user, params);
  const result = await client.query<Record<string, unknown>>(
    `
      SELECT
        record.*,
        ${stageSelect(type)}
        assignment.assigned_to AS cleanup_assigned_to,
        assignment.assignment_reason,
        assignment.source_hubspot_owner_id AS assignment_source_hubspot_owner_id,
        assignment.source_hubspot_owner_email AS assignment_source_hubspot_owner_email,
        assigned_user.id AS assigned_user_id,
        assigned_user.email AS assigned_user_email,
        assigned_user.display_name AS assigned_user_display_name,
        contact_counts.associated_contact_count
      FROM ${quoteIdent(schema)}.${quoteIdent(table)} record
      JOIN ${quoteIdent(schema)}.cleanup_assignments assignment
        ON assignment.record_type = $${params.length + 1}
       AND assignment.record_id = record.id
      LEFT JOIN public.users assigned_user ON assigned_user.id = assignment.assigned_to
      ${stageJoin(type)}
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS associated_contact_count
        FROM ${quoteIdent(schema)}.contacts contact
        WHERE contact.company_id = record.id
      ) contact_counts ON $${params.length + 1} = 'company'
      WHERE record.id = $1
        ${accessClause}
      LIMIT 1
    `,
    [...params, type],
  );
  const row = result.rows[0];
  return row ? rowToDetail(type, row) : null;
}

export async function queueForUser(user: AuthContext) {
  const schema = tenant();
  const grouped: Record<RecordType, unknown[]> = {
    deal: [],
    lead: [],
    contact: [],
    company: [],
  };

  for (const type of RECORD_TYPES) {
    const table = TABLE_BY_TYPE[type];
    const params: unknown[] = [type];
    const accessClause = isAdmin(user) ? "" : `AND assignment.assigned_to = $2`;
    if (!isAdmin(user)) params.push(user.id);
    const result = await pool.query<Record<string, unknown>>(
      `
        SELECT
          record.*,
          ${stageSelect(type)}
          assignment.assigned_to AS cleanup_assigned_to,
          assignment.assignment_reason,
          contact_counts.associated_contact_count
        FROM ${quoteIdent(schema)}.${quoteIdent(table)} record
        JOIN ${quoteIdent(schema)}.cleanup_assignments assignment
          ON assignment.record_type = $1
         AND assignment.record_id = record.id
        ${stageJoin(type)}
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS associated_contact_count
          FROM ${quoteIdent(schema)}.contacts contact
          WHERE contact.company_id = record.id
        ) contact_counts ON $1 = 'company'
        WHERE true
          ${accessClause}
        ORDER BY record.updated_at DESC NULLS LAST, record.created_at DESC NULLS LAST
      `,
      params,
    );
    grouped[type] = result.rows.map((row) => {
      const detail = rowToDetail(type, row);
      return {
        id: detail.id,
        type,
        name: recordName(type, row),
        missingFields: detail.missingFields,
        stage: detail.stage,
        lastActivityDate: row.last_activity_at ?? null,
        cleanupStatus: normalizeStatus(row.cleanup_status),
        hubspotExtraPropertyKeys: detail.hubspotExtraPropertyKeys,
      };
    });
  }

  return grouped;
}

export async function progressForUser(user: AuthContext) {
  const schema = tenant();
  const params: unknown[] = [];
  const accessClause = isAdmin(user) ? "" : "WHERE assignment.assigned_to = $1";
  if (!isAdmin(user)) params.push(user.id);
  const result = await pool.query<{
    total: string;
    completed: string;
    skipped: string;
    remaining: string;
  }>(
    `
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE COALESCE(record_status.cleanup_status, 'pending') = 'completed')::int AS completed,
        count(*) FILTER (WHERE COALESCE(record_status.cleanup_status, 'pending') = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE COALESCE(record_status.cleanup_status, 'pending') NOT IN ('completed', 'skipped'))::int AS remaining
      FROM ${quoteIdent(schema)}.cleanup_assignments assignment
      JOIN LATERAL (
        SELECT cleanup_status FROM ${quoteIdent(schema)}.deals WHERE assignment.record_type = 'deal' AND id = assignment.record_id
        UNION ALL
        SELECT cleanup_status FROM ${quoteIdent(schema)}.leads WHERE assignment.record_type = 'lead' AND id = assignment.record_id
        UNION ALL
        SELECT cleanup_status FROM ${quoteIdent(schema)}.contacts WHERE assignment.record_type = 'contact' AND id = assignment.record_id
        UNION ALL
        SELECT cleanup_status FROM ${quoteIdent(schema)}.companies WHERE assignment.record_type = 'company' AND id = assignment.record_id
      ) record_status ON true
      ${accessClause}
    `,
    params,
  );
  const row = result.rows[0] ?? { total: "0", completed: "0", skipped: "0", remaining: "0" };
  const total = Number(row.total);
  const completed = Number(row.completed);
  const skipped = Number(row.skipped);
  const remaining = Number(row.remaining);
  return {
    totalAssigned: total,
    completed,
    skipped,
    remaining,
    canClearGate: total > 0 && remaining === 0,
  };
}

export async function adminProgress() {
  const schema = tenant();
  const result = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    role: string;
    total: string;
    completed: string;
    skipped: string;
    remaining: string;
  }>(
    `
      SELECT
        users.id,
        users.email,
        users.display_name,
        users.role::text,
        count(assignment.id)::int AS total,
        count(*) FILTER (WHERE COALESCE(record_status.cleanup_status, 'pending') = 'completed')::int AS completed,
        count(*) FILTER (WHERE COALESCE(record_status.cleanup_status, 'pending') = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE COALESCE(record_status.cleanup_status, 'pending') NOT IN ('completed', 'skipped'))::int AS remaining
      FROM public.users users
      LEFT JOIN ${quoteIdent(schema)}.cleanup_assignments assignment ON assignment.assigned_to = users.id
      LEFT JOIN LATERAL (
        SELECT cleanup_status FROM ${quoteIdent(schema)}.deals WHERE assignment.record_type = 'deal' AND id = assignment.record_id
        UNION ALL
        SELECT cleanup_status FROM ${quoteIdent(schema)}.leads WHERE assignment.record_type = 'lead' AND id = assignment.record_id
        UNION ALL
        SELECT cleanup_status FROM ${quoteIdent(schema)}.contacts WHERE assignment.record_type = 'contact' AND id = assignment.record_id
        UNION ALL
        SELECT cleanup_status FROM ${quoteIdent(schema)}.companies WHERE assignment.record_type = 'company' AND id = assignment.record_id
      ) record_status ON true
      WHERE users.is_active = true
      GROUP BY users.id, users.email, users.display_name, users.role
      ORDER BY remaining DESC, total DESC, users.display_name
    `,
  );
  return result.rows.map((row) => {
    const total = Number(row.total);
    const completed = Number(row.completed);
    const skipped = Number(row.skipped);
    const remaining = Number(row.remaining);
    return {
      user: {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
      },
      total,
      completed,
      skipped,
      remaining,
      percentDone: total === 0 ? 100 : Math.round(((completed + skipped) / total) * 100),
    };
  });
}

export async function adminProgressSummary() {
  const schema = tenant();
  const result = await pool.query<{
    record_type: string;
    total: string;
    completed: string;
    skipped: string;
    remaining: string;
  }>(
    `
      WITH assignment_records AS (
        SELECT assignment.record_type, assignment.status
        FROM ${quoteIdent(schema)}.cleanup_assignments assignment
      )
      SELECT
        record_type,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE COALESCE(status, 'pending') NOT IN ('completed', 'skipped'))::int AS remaining
      FROM assignment_records
      GROUP BY record_type
      ORDER BY record_type
    `,
  );
  const byType = result.rows.map((row) => {
    const total = Number(row.total);
    const completed = Number(row.completed);
    const skipped = Number(row.skipped);
    const remaining = Number(row.remaining);
    return {
      type: row.record_type,
      total,
      completed,
      skipped,
      remaining,
      percentDone: buildProgressPercent(total, completed, skipped),
    };
  });
  const totals = byType.reduce(
    (acc, row) => ({
      total: acc.total + row.total,
      completed: acc.completed + row.completed,
      skipped: acc.skipped + row.skipped,
      remaining: acc.remaining + row.remaining,
    }),
    { total: 0, completed: 0, skipped: 0, remaining: 0 },
  );
  return {
    ...totals,
    percentCompleted: totals.total === 0 ? 0 : Math.round((totals.completed / totals.total) * 100),
    percentSkipped: totals.total === 0 ? 0 : Math.round((totals.skipped / totals.total) * 100),
    percentRemaining: totals.total === 0 ? 0 : Math.round((totals.remaining / totals.total) * 100),
    percentDone: buildProgressPercent(totals.total, totals.completed, totals.skipped),
    byType,
  };
}

export async function adminProgressByUser() {
  const schema = tenant();
  const result = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    role: string;
    total: string;
    completed: string;
    skipped: string;
    remaining: string;
    last_activity_at: string | null;
  }>(
    `
      SELECT
        users.id,
        users.email,
        users.display_name,
        users.role::text,
        count(assignment.id)::int AS total,
        count(assignment.id) FILTER (WHERE assignment.status = 'completed')::int AS completed,
        count(assignment.id) FILTER (WHERE assignment.status = 'skipped')::int AS skipped,
        count(assignment.id) FILTER (WHERE COALESCE(assignment.status, 'pending') NOT IN ('completed', 'skipped'))::int AS remaining,
        max(activity.last_activity_at) AS last_activity_at
      FROM public.users users
      LEFT JOIN ${quoteIdent(schema)}.cleanup_assignments assignment ON assignment.assigned_to = users.id
      LEFT JOIN LATERAL (
        SELECT max(value) AS last_activity_at
        FROM (
          VALUES (assignment.updated_at)
          UNION ALL
          SELECT skip.created_at
          FROM ${quoteIdent(schema)}.cleanup_skips skip
          WHERE skip.skipped_by = users.id
          UNION ALL
          SELECT audit.created_at
          FROM ${quoteIdent(schema)}.cleanup_audit_log audit
          WHERE audit.user_id = users.id
        ) AS timestamps(value)
      ) activity ON true
      WHERE users.is_active = true
        AND users.role::text IN ('admin', 'director', 'rep')
      GROUP BY users.id, users.email, users.display_name, users.role
      ORDER BY
        CASE WHEN count(assignment.id) = 0 THEN 100 ELSE round(((count(assignment.id) FILTER (WHERE assignment.status IN ('completed', 'skipped')))::numeric / count(assignment.id)) * 100) END ASC,
        remaining DESC,
        users.display_name
    `,
  );

  return result.rows.map((row) => {
    const total = Number(row.total);
    const completed = Number(row.completed);
    const skipped = Number(row.skipped);
    const remaining = Number(row.remaining);
    return {
      user: {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
      },
      total,
      completed,
      skipped,
      remaining,
      percentDone: buildProgressPercent(total, completed, skipped),
      lastActivityAt: row.last_activity_at,
    };
  });
}

async function activeAssignableUser(client: QueryClient, userId: string) {
  assertUuid(userId, "newAssignedToUserId");
  const result = await client.query<{ id: string; email: string; display_name: string; role: string }>(
    `
      SELECT id, email, display_name, role::text
      FROM public.users
      WHERE id = $1
        AND is_active = true
        AND role::text IN ('admin', 'director', 'rep')
      LIMIT 1
    `,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function assertRecordsExist(client: QueryClient, type: RecordType, recordIds: string[]) {
  for (const recordId of recordIds) assertUuid(recordId, "record id");
  const schema = tenant();
  const table = TABLE_BY_TYPE[type];
  const result = await client.query<{ id: string }>(
    `
      SELECT id::text AS id
      FROM ${quoteIdent(schema)}.${quoteIdent(table)}
      WHERE id = ANY($1::uuid[])
    `,
    [recordIds],
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = recordIds.filter((recordId) => !found.has(recordId));
  if (missing.length > 0) {
    const error = new Error("Record not found");
    (error as Error & { status?: number; details?: unknown }).status = 404;
    (error as Error & { status?: number; details?: unknown }).details = { missingRecordIds: missing };
    throw error;
  }
}

async function reassignRecordsInTransaction(type: RecordType, recordIds: string[], newAssignedToUserId: string, actor: AuthContext, reason?: string) {
  if (recordIds.length === 0) {
    const error = new Error("recordIds must contain at least one record");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  if (recordIds.length > MAX_BULK_REASSIGN) {
    const error = new Error(`Bulk reassignment is limited to ${MAX_BULK_REASSIGN} records`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  const schema = tenant();
  const table = TABLE_BY_TYPE[type];
  const ownerColumn = OWNER_COLUMN_BY_TYPE[type];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const targetUser = await activeAssignableUser(client, newAssignedToUserId);
    if (!targetUser) {
      const error = new Error("Target user not found or inactive");
      (error as Error & { status?: number }).status = 400;
      throw error;
    }
    await assertRecordsExist(client, type, recordIds);
    const beforeOwners = await client.query<{
      id: string;
      owner_id: string | null;
      cleanup_assigned_to: string | null;
      owner_email: string | null;
      owner_display_name: string | null;
    }>(
      `
        SELECT
          record.id::text AS id,
          record.${quoteIdent(ownerColumn)}::text AS owner_id,
          assignment.assigned_to::text AS cleanup_assigned_to,
          owner_user.email AS owner_email,
          owner_user.display_name AS owner_display_name
        FROM ${quoteIdent(schema)}.${quoteIdent(table)} record
        LEFT JOIN ${quoteIdent(schema)}.cleanup_assignments assignment
          ON assignment.record_type = $1
         AND assignment.record_id = record.id
        LEFT JOIN public.users owner_user ON owner_user.id = record.${quoteIdent(ownerColumn)}
        WHERE record.id = ANY($2::uuid[])
      `,
      [type, recordIds],
    );
    const beforeOwnerById = new Map(beforeOwners.rows.map((row) => [row.id, row]));

    const recordUpdate = await client.query(
      `
        UPDATE ${quoteIdent(schema)}.${quoteIdent(table)}
        SET ${quoteIdent(ownerColumn)} = $1,
            updated_at = now()
        WHERE id = ANY($2::uuid[])
      `,
      [newAssignedToUserId, recordIds],
    );
    if (recordUpdate.rowCount !== recordIds.length) {
      const error = new Error("Record reassignment failed");
      (error as Error & { status?: number }).status = 409;
      throw error;
    }

    const assignmentUpdate = await client.query(
      `
        UPDATE ${quoteIdent(schema)}.cleanup_assignments
        SET assigned_to = $1,
            updated_at = now()
        WHERE record_type = $2
          AND record_id = ANY($3::uuid[])
      `,
      [newAssignedToUserId, type, recordIds],
    );
    if (assignmentUpdate.rowCount !== recordIds.length) {
      const error = new Error("Cleanup assignment reassignment failed");
      (error as Error & { status?: number }).status = 409;
      throw error;
    }

    if (reason?.trim()) {
      console.info("[cleanup] admin reassignment", {
        type,
        recordIds,
        newAssignedToUserId,
        actorUserId: actor.id,
        reason: reason.trim(),
      });
    }

    for (const recordId of recordIds) {
      const before = beforeOwnerById.get(recordId);
      await writeCleanupAudit(client, {
        type,
        recordId,
        userId: actor.id,
        action: "record_reassigned",
        fieldChanges: [
          { field: ownerColumn, before: before?.owner_id ?? null, after: newAssignedToUserId },
          { field: "cleanup_assignments.assigned_to", before: before?.cleanup_assigned_to ?? null, after: newAssignedToUserId },
        ],
        metadata: {
          reason: reason?.trim() || null,
          targetUserEmail: targetUser.email,
        },
      });
      const oldOwnerName = before?.owner_display_name ?? before?.owner_email ?? "unassigned";
      const newOwnerName = targetUser.display_name ?? targetUser.email;
      await writeCrmActivityNote(client, {
        type,
        recordId,
        userId: actor.id,
        subject: "Cleanup reassignment",
        body: [
          `Reassigned from ${oldOwnerName} to ${newOwnerName} during data cleanup.`,
          reason?.trim() ? `Reason: ${reason.trim()}` : null,
        ].filter(Boolean).join(" "),
        action: "record_reassigned",
      });
    }

    const records = [];
    for (const recordId of recordIds) {
      records.push(await getRecordDetailWithClient(client, type, recordId, actor));
    }
    await client.query("COMMIT");
    return {
      type,
      reassignedTo: targetUser,
      count: recordIds.length,
      records,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reassignRecord(typeValue: string, id: string, newAssignedToUserId: string, actor: AuthContext, reason?: string) {
  const type = assertRecordType(typeValue);
  const result = await reassignRecordsInTransaction(type, [id], newAssignedToUserId, actor, reason);
  return {
    type,
    id,
    reassignedTo: result.reassignedTo,
    record: result.records[0],
  };
}

export async function bulkReassignRecords(typeValue: string, recordIds: string[], newAssignedToUserId: string, actor: AuthContext, reason?: string) {
  const type = assertRecordType(typeValue);
  if (!Array.isArray(recordIds)) {
    const error = new Error("recordIds must be an array");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  return reassignRecordsInTransaction(type, recordIds, newAssignedToUserId, actor, reason);
}

export async function reassignmentUsers() {
  const result = await pool.query<{ id: string; email: string; display_name: string; role: string }>(
    `
      SELECT id, email, display_name, role::text
      FROM public.users
      WHERE is_active = true
        AND role::text IN ('admin', 'director', 'rep')
      ORDER BY role::text, display_name, email
    `,
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  }));
}

async function userForProgress(userId: string) {
  assertUuid(userId, "userId");
  const result = await pool.query<{ id: string; email: string; display_name: string; role: string }>(
    `
      SELECT id, email, display_name, role::text
      FROM public.users
      WHERE id = $1
        AND is_active = true
      LIMIT 1
    `,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function adminProgressUser(userId: string, page = 1) {
  const schema = tenant();
  const user = await userForProgress(userId);
  if (!user) {
    const error = new Error("User not found");
    (error as Error & { status?: number }).status = 404;
    throw error;
  }
  const offset = (Math.max(1, page) - 1) * ADMIN_PROGRESS_PAGE_SIZE;
  const statsResult = await pool.query<{
    total: string;
    completed: string;
    skipped: string;
    remaining: string;
    first_action_at: string | null;
    last_action_at: string | null;
  }>(
    `
      WITH assigned AS (
        SELECT *
        FROM ${quoteIdent(schema)}.cleanup_assignments
        WHERE assigned_to = $1
      ),
      action_times AS (
        SELECT updated_at AS occurred_at FROM assigned WHERE status IN ('completed', 'skipped')
        UNION ALL
        SELECT created_at AS occurred_at FROM ${quoteIdent(schema)}.cleanup_skips WHERE skipped_by = $1
        UNION ALL
        SELECT created_at AS occurred_at FROM ${quoteIdent(schema)}.cleanup_audit_log WHERE user_id = $1
      )
      SELECT
        (SELECT count(*)::int FROM assigned) AS total,
        (SELECT count(*)::int FROM assigned WHERE status = 'completed') AS completed,
        (SELECT count(*)::int FROM assigned WHERE status = 'skipped') AS skipped,
        (SELECT count(*)::int FROM assigned WHERE COALESCE(status, 'pending') NOT IN ('completed', 'skipped')) AS remaining,
        min(action_times.occurred_at) AS first_action_at,
        max(action_times.occurred_at) AS last_action_at
      FROM action_times
    `,
    [userId],
  );
  const statsRow = statsResult.rows[0] ?? {
    total: "0",
    completed: "0",
    skipped: "0",
    remaining: "0",
    first_action_at: null,
    last_action_at: null,
  };
  const activityResult = await pool.query<{
    occurred_at: string;
    record_type: string;
    record_id: string;
    record_name: string | null;
    action: string;
    field_changes: unknown;
    metadata: unknown;
    source: string;
  }>(
    `
      WITH records AS (
        SELECT 'deal'::text AS record_type, id, ${recordDisplayNameExpression("deal")} AS name FROM ${quoteIdent(schema)}.deals record
        UNION ALL
        SELECT 'lead'::text AS record_type, id, ${recordDisplayNameExpression("lead")} AS name FROM ${quoteIdent(schema)}.leads record
        UNION ALL
        SELECT 'contact'::text AS record_type, id, ${recordDisplayNameExpression("contact")} AS name FROM ${quoteIdent(schema)}.contacts record
        UNION ALL
        SELECT 'company'::text AS record_type, id, ${recordDisplayNameExpression("company")} AS name FROM ${quoteIdent(schema)}.companies record
      ),
      feed AS (
        SELECT
          assignment.updated_at AS occurred_at,
          assignment.record_type,
          assignment.record_id,
          assignment.status AS action,
          '[]'::jsonb AS field_changes,
          jsonb_build_object('assignmentReason', assignment.assignment_reason) AS metadata,
          'cleanup app'::text AS source
        FROM ${quoteIdent(schema)}.cleanup_assignments assignment
        WHERE assignment.assigned_to = $1
          AND assignment.status IN ('completed', 'skipped')
        UNION ALL
        SELECT
          skip.created_at AS occurred_at,
          skip.record_type,
          skip.record_id,
          'skipped' AS action,
          '[]'::jsonb AS field_changes,
          jsonb_build_object('reason', skip.skip_reason, 'notes', skip.skip_notes, 'missingFields', skip.missing_fields) AS metadata,
          'cleanup app'::text AS source
        FROM ${quoteIdent(schema)}.cleanup_skips skip
        WHERE skip.skipped_by = $1
        UNION ALL
        SELECT
          audit.created_at AS occurred_at,
          audit.record_type,
          audit.record_id,
          audit.action,
          audit.field_changes,
          audit.metadata,
          COALESCE(audit.metadata->>'source', 'cleanup app') AS source
        FROM ${quoteIdent(schema)}.cleanup_audit_log audit
        WHERE audit.user_id = $1
        UNION ALL
        SELECT
          crm_audit.created_at AS occurred_at,
          CASE crm_audit.table_name
            WHEN 'deals' THEN 'deal'
            WHEN 'leads' THEN 'lead'
            WHEN 'contacts' THEN 'contact'
            WHEN 'companies' THEN 'company'
            ELSE crm_audit.table_name
          END AS record_type,
          crm_audit.record_id,
          'field_updated' AS action,
          (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('field', key, 'before', value->'old', 'after', value->'new')), '[]'::jsonb)
            FROM jsonb_each(crm_audit.changes)
          ) AS field_changes,
          jsonb_build_object('sourceTable', 'audit_log') AS metadata,
          'cleanup app'::text AS source
        FROM ${quoteIdent(schema)}.audit_log crm_audit
        WHERE crm_audit.table_name IN ('deals', 'contacts')
          AND (
            crm_audit.changed_by = $1
            OR crm_audit.changes->'cleanup_completed_by'->>'new' = $1::text
          )
      )
      SELECT
        feed.occurred_at,
        feed.record_type,
        feed.record_id::text,
        records.name AS record_name,
        feed.action,
        feed.field_changes,
        feed.metadata,
        feed.source
      FROM feed
      LEFT JOIN records ON records.record_type = feed.record_type AND records.id = feed.record_id
      WHERE feed.occurred_at IS NOT NULL
      ORDER BY feed.occurred_at DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, ADMIN_PROGRESS_PAGE_SIZE, offset],
  );
  const total = Number(statsRow.total);
  const completed = Number(statsRow.completed);
  const skipped = Number(statsRow.skipped);
  const remaining = Number(statsRow.remaining);
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
    },
    stats: {
      total,
      completed,
      skipped,
      remaining,
      percentDone: buildProgressPercent(total, completed, skipped),
      firstActionAt: statsRow.first_action_at,
      lastActionAt: statsRow.last_action_at,
    },
    activity: {
      page: Math.max(1, page),
      pageSize: ADMIN_PROGRESS_PAGE_SIZE,
      entries: activityResult.rows.map((row) => ({
        timestamp: row.occurred_at,
        recordType: row.record_type,
        recordId: row.record_id,
        recordName: row.record_name ?? row.record_id,
        action: row.action,
        fieldChanges: row.field_changes,
        metadata: row.metadata,
        source: row.source,
      })),
    },
  };
}

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function adminProgressUserExport(userId: string, format = "csv") {
  const detail = await adminProgressUser(userId, 1);
  const entries = [...detail.activity.entries];
  let page = 2;
  while (entries.length > 0 && entries.length % ADMIN_PROGRESS_PAGE_SIZE === 0 && page <= 200) {
    const next = await adminProgressUser(userId, page);
    entries.push(...next.activity.entries);
    if (next.activity.entries.length < ADMIN_PROGRESS_PAGE_SIZE) break;
    page += 1;
  }
  if (format === "json") return { contentType: "application/json", body: JSON.stringify({ ...detail, activity: { ...detail.activity, entries } }, null, 2) };
  const lines = [
    ["timestamp", "record_type", "record_id", "record_name", "action", "field_changes", "metadata", "source"].join(","),
    ...entries.map((entry) =>
      [
        entry.timestamp,
        entry.recordType,
        entry.recordId,
        entry.recordName,
        entry.action,
        JSON.stringify(entry.fieldChanges ?? []),
        JSON.stringify(entry.metadata ?? {}),
        entry.source,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  return { contentType: "text/csv; charset=utf-8", body: `${lines.join("\n")}\n` };
}

export async function reassignmentRecords(filters: { type?: string; q?: string; owner?: string; page?: number }) {
  const schema = tenant();
  const requestedTypes = filters.type && filters.type !== "all" ? [assertRecordType(filters.type)] : RECORD_TYPES;
  const query = filters.q?.trim() ?? "";
  const owner = filters.owner?.trim() ?? "all";
  const page = Math.max(1, filters.page ?? 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const rows: Array<Record<string, unknown>> = [];

  for (const type of requestedTypes) {
    const table = TABLE_BY_TYPE[type];
    const ownerColumn = OWNER_COLUMN_BY_TYPE[type];
    const params: unknown[] = [];
    const clauses = ["true"];
    if (query.length > 0) {
      params.push(`%${query}%`);
      if (type === "contact") {
        clauses.push(`(trim(record.first_name || ' ' || record.last_name) ILIKE $${params.length} OR record.email ILIKE $${params.length})`);
      } else {
        clauses.push(`record.name ILIKE $${params.length}`);
      }
    }
    if (owner === "unassigned") {
      clauses.push(`record.${quoteIdent(ownerColumn)} IS NULL`);
    } else if (owner !== "all") {
      assertUuid(owner, "owner");
      params.push(owner);
      clauses.push(`record.${quoteIdent(ownerColumn)} = $${params.length}`);
    }

    const amountSelect =
      type === "deal"
        ? `CASE WHEN record.hubspot_extra_properties->>'amount_in_home_currency' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (record.hubspot_extra_properties->>'amount_in_home_currency')::numeric ELSE COALESCE(record.awarded_amount, record.bid_estimate, record.dd_estimate) END`
        : type === "lead"
          ? "record.pre_qual_value"
          : "NULL::numeric";
    const nameSelect = type === "contact" ? "COALESCE(NULLIF(trim(record.first_name || ' ' || record.last_name), ''), record.email, record.id::text)" : "record.name";

    const result = await pool.query<Record<string, unknown>>(
      `
        SELECT
          $${params.length + 1}::text AS type,
          record.id::text,
          ${nameSelect} AS name,
          ${amountSelect} AS amount,
          record.${quoteIdent(ownerColumn)}::text AS owner_id,
          owner.email AS owner_email,
          assignment.assigned_to::text AS cleanup_assigned_to,
          cleanup_user.email AS cleanup_assignee_email,
          ${stageSelect(type)}
          record.updated_at,
          record.created_at
        FROM ${quoteIdent(schema)}.${quoteIdent(table)} record
        JOIN ${quoteIdent(schema)}.cleanup_assignments assignment
          ON assignment.record_type = $${params.length + 1}
         AND assignment.record_id = record.id
        LEFT JOIN public.users owner ON owner.id = record.${quoteIdent(ownerColumn)}
        LEFT JOIN public.users cleanup_user ON cleanup_user.id = assignment.assigned_to
        ${stageJoin(type)}
        WHERE ${clauses.join(" AND ")}
        ORDER BY record.updated_at DESC NULLS LAST, record.created_at DESC NULLS LAST
        LIMIT 1000
      `,
      [...params, type],
    );
    rows.push(...result.rows);
  }

  rows.sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
  return {
    page,
    pageSize: limit,
    total: rows.length,
    records: rows.slice(offset, offset + limit).map((row) => ({
      id: row.id,
      type: row.type,
      name: row.name,
      amount: row.amount,
      owner: row.owner_id
        ? {
            id: row.owner_id,
            email: row.owner_email,
          }
        : null,
      cleanupAssignee: row.cleanup_assigned_to
        ? {
            id: row.cleanup_assigned_to,
            email: row.cleanup_assignee_email,
          }
        : null,
      stage: row.stage_id_resolved
        ? {
            id: row.stage_id_resolved,
            slug: row.stage_slug,
            label: row.stage_label,
          }
        : null,
    })),
  };
}

export async function cleanupSummaryReport() {
  const schema = tenant();
  const [summary, byUser, skipReasons, skipTypes, dataQuality, adminQueue, reassignments, flagged] = await Promise.all([
    adminProgressSummary(),
    adminProgressByUser(),
    pool.query<{ skip_reason: string | null; count: string }>(
      `
        SELECT skip_reason, count(*)::int AS count
        FROM ${quoteIdent(schema)}.cleanup_skips
        GROUP BY skip_reason
        ORDER BY count DESC
      `,
    ),
    pool.query<{ record_type: string; count: string }>(
      `
        SELECT record_type, count(*)::int AS count
        FROM ${quoteIdent(schema)}.cleanup_skips
        GROUP BY record_type
        ORDER BY count DESC
      `,
    ),
    pool.query<{ populated_fields: string }>(
      `
        SELECT count(*)::int AS populated_fields
        FROM ${quoteIdent(schema)}.cleanup_audit_log audit
        CROSS JOIN LATERAL jsonb_array_elements(audit.field_changes) AS change
        WHERE COALESCE(change->>'before', '') = ''
          AND COALESCE(change->>'after', '') <> ''
      `,
    ),
    pool.query<{ record_type: string; count: string }>(
      `
        SELECT assignment.record_type, count(*)::int AS count
        FROM ${quoteIdent(schema)}.cleanup_assignments assignment
        JOIN public.users users ON users.id = assignment.assigned_to
        WHERE users.role::text = 'admin'
        GROUP BY assignment.record_type
        ORDER BY assignment.record_type
      `,
    ),
    pool.query<{ count: string; from_email: string | null; to_email: string | null }>(
      `
        SELECT
          count(*)::int AS count,
          from_user.email AS from_email,
          to_user.email AS to_email
        FROM ${quoteIdent(schema)}.cleanup_audit_log audit
        LEFT JOIN LATERAL (
          SELECT field_change->>'before' AS user_id
          FROM jsonb_array_elements(audit.field_changes) field_change
          WHERE field_change->>'field' = 'cleanup_assignments.assigned_to'
          LIMIT 1
        ) before_assignment ON true
        LEFT JOIN LATERAL (
          SELECT field_change->>'after' AS user_id
          FROM jsonb_array_elements(audit.field_changes) field_change
          WHERE field_change->>'field' = 'cleanup_assignments.assigned_to'
          LIMIT 1
        ) after_assignment ON true
        LEFT JOIN public.users from_user ON from_user.id::text = before_assignment.user_id
        LEFT JOIN public.users to_user ON to_user.id::text = after_assignment.user_id
        WHERE audit.action = 'record_reassigned'
        GROUP BY from_user.email, to_user.email
        ORDER BY count DESC
      `,
    ),
    pool.query<{ record_type: string; count: string }>(
      `
        SELECT record_type, count(*)::int AS count
        FROM (
          SELECT 'deal' AS record_type FROM ${quoteIdent(schema)}.deals WHERE needs_leadership_review = true AND COALESCE(cleanup_status, 'pending') <> 'completed'
          UNION ALL
          SELECT 'lead' AS record_type FROM ${quoteIdent(schema)}.leads WHERE needs_leadership_review = true AND COALESCE(cleanup_status, 'pending') <> 'completed'
          UNION ALL
          SELECT 'contact' AS record_type FROM ${quoteIdent(schema)}.contacts WHERE needs_leadership_review = true AND COALESCE(cleanup_status, 'pending') <> 'completed'
          UNION ALL
          SELECT 'company' AS record_type FROM ${quoteIdent(schema)}.companies WHERE needs_leadership_review = true AND COALESCE(cleanup_status, 'pending') <> 'completed'
        ) flagged_records
        GROUP BY record_type
        ORDER BY record_type
      `,
    ),
  ]);

  const actionTimes = await pool.query<{ first_action_at: string | null; last_action_at: string | null }>(
    `
      WITH action_times AS (
        SELECT updated_at AS occurred_at FROM ${quoteIdent(schema)}.cleanup_assignments WHERE status IN ('completed', 'skipped')
        UNION ALL
        SELECT created_at FROM ${quoteIdent(schema)}.cleanup_skips
        UNION ALL
        SELECT created_at FROM ${quoteIdent(schema)}.cleanup_audit_log
      )
      SELECT min(occurred_at) AS first_action_at, max(occurred_at) AS last_action_at
      FROM action_times
    `,
  );

  return {
    generatedAt: new Date().toISOString(),
    overall: {
      ...summary,
      firstActionAt: actionTimes.rows[0]?.first_action_at ?? null,
      lastActionAt: actionTimes.rows[0]?.last_action_at ?? null,
    },
    perRep: byUser,
    skipAnalysis: {
      byReason: skipReasons.rows.map((row) => ({ reason: row.skip_reason ?? "unspecified", count: Number(row.count) })),
      byType: skipTypes.rows.map((row) => ({ type: row.record_type, count: Number(row.count) })),
    },
    dataQuality: {
      populatedEmptyFields: Number(dataQuality.rows[0]?.populated_fields ?? 0),
      note: "Counts field changes logged by cleanup_audit_log where the previous value was empty and the new value is populated.",
    },
    adminQueue: adminQueue.rows.map((row) => ({ type: row.record_type, count: Number(row.count) })),
    reassignments: reassignments.rows.map((row) => ({ from: row.from_email ?? "unassigned", to: row.to_email ?? "unknown", count: Number(row.count) })),
    flaggedItems: flagged.rows.map((row) => ({ type: row.record_type, count: Number(row.count) })),
    auditCoverage: {
      crmAuditLog: "Existing CRM audit triggers capture field-level changes for deals, contacts, and activities.",
      cleanupAuditLog: "Cleanup service writes field-level cleanup_audit_log entries for PATCH, skip, and reassignment actions.",
      knownGap: "Legacy changes before cleanup_audit_log deployment rely on cleanup_assignments, cleanup_skips, and CRM audit_log where available.",
    },
  };
}

export async function recordDetail(typeValue: string, id: string, user: AuthContext) {
  return getRecordDetailWithClient(pool, assertRecordType(typeValue), id, user);
}

export async function patchRecord(typeValue: string, id: string, user: AuthContext, patch: Record<string, unknown>) {
  const type = assertRecordType(typeValue);
  const allowed = UPDATE_COLUMNS[type];
  const schema = tenant();
  const table = TABLE_BY_TYPE[type];
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));

  if (entries.length === 0) {
    const error = new Error("No supported fields provided");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await getRecordDetailWithClient(client, type, id, user);
    if (!current) {
      const error = new Error("Record not found");
      (error as Error & { status?: number }).status = 404;
      throw error;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of entries) {
      values.push(value === "" ? null : value);
      sets.push(`${quoteIdent(column)} = $${values.length}`);
    }

    const requestedComplete = patch.cleanup_status === "completed";
    if (requestedComplete) {
      const merged = { ...current.data, ...Object.fromEntries(entries), cleanup_status: "completed" };
      const detailForValidation: RecordDetail = {
        ...current,
        data: merged,
        missingFields: missingFields(type, merged, current.stage?.slug),
      };
      if (!canComplete(detailForValidation)) {
        const error = new Error("Record still has required cleanup fields missing");
        (error as Error & { status?: number; details?: unknown }).status = 422;
        (error as Error & { status?: number; details?: unknown }).details = {
          missingFields: detailForValidation.missingFields.filter((field) => field.severity === "required"),
        };
        throw error;
      }
      values.push(user.id);
      sets.push(`cleanup_completed_at = now()`, `cleanup_completed_by = $${values.length}`);
    }

    sets.push("updated_at = now()");
    values.push(id);
    await client.query(
      `
        UPDATE ${quoteIdent(schema)}.${quoteIdent(table)}
        SET ${sets.join(", ")}
        WHERE id = $${values.length}
      `,
      values,
    );

    if (requestedComplete) {
      await client.query(
        `
          UPDATE ${quoteIdent(schema)}.cleanup_assignments
          SET status = 'completed', updated_at = now()
          WHERE record_type = $1 AND record_id = $2
        `,
        [type, id],
      );
    }

    const updated = await getRecordDetailWithClient(client, type, id, user);
    const changedFields = normalizeFieldChanges(
      current.data,
      updated?.data ?? {},
      entries.map(([column]) => column),
    );
    await writeCleanupAudit(client, {
      type,
      recordId: id,
      userId: user.id,
      action: requestedComplete ? "completed" : "field_updated",
      fieldChanges: changedFields,
      metadata: {
        completed: requestedComplete,
      },
    });
    const businessChanges = requestedComplete ? completionBusinessChanges(changedFields) : [];
    if (businessChanges.length > 0) {
      await writeCrmActivityNote(client, {
        type,
        recordId: id,
        userId: user.id,
        subject: "Cleanup completed",
        body: `Record cleaned during data migration. Fields updated: ${businessChanges.map(fieldChangeSummary).join(", ")}.`,
        action: "completed",
      });
    }
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function skipRecord(typeValue: string, id: string, user: AuthContext, reason: string, notes?: string) {
  const type = assertRecordType(typeValue);
  if (!SKIP_REASONS.has(reason)) {
    const error = new Error("Unsupported skip reason");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  if (reason === "other" && !notes?.trim()) {
    const error = new Error("skip_notes is required when reason is other");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  const schema = tenant();
  const table = TABLE_BY_TYPE[type];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const detail = await getRecordDetailWithClient(client, type, id, user);
    if (!detail) {
      const error = new Error("Record not found");
      (error as Error & { status?: number }).status = 404;
      throw error;
    }

    await client.query(
      `
        UPDATE ${quoteIdent(schema)}.${quoteIdent(table)}
        SET cleanup_status = 'skipped',
            cleanup_completed_at = now(),
            cleanup_completed_by = $1,
            skip_reason = $2,
            skip_notes = $3,
            needs_leadership_review = true,
            updated_at = now()
        WHERE id = $4
      `,
      [user.id, reason, notes ?? null, id],
    );
    await client.query(
      `
        UPDATE ${quoteIdent(schema)}.cleanup_assignments
        SET status = 'skipped', updated_at = now()
        WHERE record_type = $1 AND record_id = $2
      `,
      [type, id],
    );
    await client.query(
      `
        INSERT INTO ${quoteIdent(schema)}.cleanup_skips (
          record_type, record_id, skipped_by, skip_reason, skip_notes, missing_fields, original_snapshot
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
      `,
      [type, id, user.id, reason, notes ?? null, JSON.stringify(detail.missingFields), JSON.stringify(detail.data)],
    );
    await writeCleanupAudit(client, {
      type,
      recordId: id,
      userId: user.id,
      action: "skipped",
      fieldChanges: [
        { field: "cleanup_status", before: detail.data.cleanup_status ?? null, after: "skipped" },
        { field: "skip_reason", before: detail.data.skip_reason ?? null, after: reason },
      ],
      metadata: {
        reason,
        notes: notes ?? null,
        missingFields: detail.missingFields,
      },
    });
    const reasonLabel = SKIP_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
    const missingFieldList = detail.missingFields.map((field) => field.field).join(", ") || "none";
    await writeCrmActivityNote(client, {
      type,
      recordId: id,
      userId: user.id,
      subject: `Cleanup skip: ${reasonLabel}`,
      body: [
        `Skipped during data cleanup. Reason: ${reasonLabel}.`,
        notes?.trim() ? `Notes: ${notes.trim()}.` : null,
        `Missing fields at time of skip: ${missingFieldList}.`,
      ].filter(Boolean).join(" "),
      action: "skipped",
    });
    await client.query("COMMIT");
    return { status: "skipped", id, type };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function flagDuplicate(typeValue: string, id: string, user: AuthContext) {
  const type = assertRecordType(typeValue);
  const schema = tenant();
  const table = TABLE_BY_TYPE[type];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const detail = await getRecordDetailWithClient(client, type, id, user);
    if (!detail) {
      const error = new Error("Record not found");
      (error as Error & { status?: number }).status = 404;
      throw error;
    }
    await client.query(
      `
        UPDATE ${quoteIdent(schema)}.${quoteIdent(table)}
        SET needs_leadership_review = true,
            skip_reason = 'record_is_duplicate',
            updated_at = now()
        WHERE id = $1
      `,
      [id],
    );
    await client.query("COMMIT");
    return { status: "flagged", id, type };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function historicalPass(user: AuthContext, global = false) {
  const schema = tenant();
  const params: unknown[] = [CLOSED_STAGE_SLUGS];
  const repClause = global || isAdmin(user) ? "" : `AND assignment.assigned_to = $2`;
  if (!global && !isAdmin(user)) params.push(user.id);
  const result = await pool.query<{ user_id: string; count: string }>(
    `
      WITH eligible AS (
        SELECT deal.id, assignment.assigned_to
        FROM ${quoteIdent(schema)}.deals deal
        JOIN public.pipeline_stage_config stage ON stage.id = deal.stage_id
        JOIN ${quoteIdent(schema)}.cleanup_assignments assignment
          ON assignment.record_type = 'deal'
         AND assignment.record_id = deal.id
        WHERE stage.slug = ANY($1)
          AND COALESCE(deal.cleanup_status, 'pending') NOT IN ('completed', 'skipped')
          ${repClause}
      ),
      updated_deals AS (
        UPDATE ${quoteIdent(schema)}.deals deal
        SET cleanup_status = 'completed',
            cleanup_completed_at = now(),
            cleanup_completed_by = $${params.length + 1},
            skip_reason = 'historical_no_enrichment_needed',
            updated_at = now()
        FROM eligible
        WHERE deal.id = eligible.id
        RETURNING deal.id, eligible.assigned_to
      ),
      updated_assignments AS (
        UPDATE ${quoteIdent(schema)}.cleanup_assignments assignment
        SET status = 'completed',
            updated_at = now()
        FROM updated_deals
        WHERE assignment.record_type = 'deal'
          AND assignment.record_id = updated_deals.id
        RETURNING updated_deals.assigned_to
      )
      SELECT assigned_to::text AS user_id, count(*)::int AS count
      FROM updated_assignments
      GROUP BY assigned_to
    `,
    [...params, user.id],
  );
  return {
    updated: result.rows.reduce((sum, row) => sum + Number(row.count), 0),
    byUser: result.rows.map((row) => ({ userId: row.user_id, count: Number(row.count) })),
  };
}

export async function completeOnboarding(user: AuthContext, targetUserId?: string, overrideReason?: string) {
  const userId = targetUserId ?? user.id;
  if (targetUserId && !isAdmin(user)) {
    const error = new Error("Forbidden");
    (error as Error & { status?: number }).status = 403;
    throw error;
  }
  if (!targetUserId) {
    const progress = await progressForUser(user);
    if (!progress.canClearGate) {
      return { success: false, reason: "cleanup_remaining", progress };
    }
  }
  await pool.query(
    `
      UPDATE public.users
      SET onboarding_completed_at = now(),
          onboarding_completed_by = $1,
          onboarding_override_reason = $2,
          updated_at = now()
      WHERE id = $3
    `,
    [user.id, overrideReason ?? null, userId],
  );
  return { success: true, userId };
}

export async function adminSkips(reason?: string) {
  const schema = tenant();
  const params: unknown[] = reason ? [reason] : [];
  const reasonClause = reason ? `WHERE review_records.skip_reason = $1` : "";
  const result = await pool.query(
    `
      WITH review_records AS (
        SELECT 'deal' AS record_type, id AS record_id, name, cleanup_status, skip_reason, needs_leadership_review, updated_at
        FROM ${quoteIdent(schema)}.deals
        WHERE needs_leadership_review = true
        UNION ALL
        SELECT 'lead' AS record_type, id AS record_id, name, cleanup_status, skip_reason, needs_leadership_review, updated_at
        FROM ${quoteIdent(schema)}.leads
        WHERE needs_leadership_review = true
        UNION ALL
        SELECT 'contact' AS record_type, id AS record_id, trim(first_name || ' ' || last_name) AS name, cleanup_status, skip_reason, needs_leadership_review, updated_at
        FROM ${quoteIdent(schema)}.contacts
        WHERE needs_leadership_review = true
        UNION ALL
        SELECT 'company' AS record_type, id AS record_id, name, cleanup_status, skip_reason, needs_leadership_review, updated_at
        FROM ${quoteIdent(schema)}.companies
        WHERE needs_leadership_review = true
      )
      SELECT
        review_records.*,
        skip.id AS skip_audit_id,
        skip.skipped_by,
        skip.skip_notes,
        skip.missing_fields,
        skip.created_at AS skipped_at,
        users.email AS skipped_by_email,
        users.display_name AS skipped_by_name
      FROM review_records
      LEFT JOIN LATERAL (
        SELECT *
        FROM ${quoteIdent(schema)}.cleanup_skips skip
        WHERE skip.record_type = review_records.record_type
          AND skip.record_id = review_records.record_id
        ORDER BY skip.created_at DESC
        LIMIT 1
      ) skip ON true
      LEFT JOIN public.users users ON users.id = skip.skipped_by
      ${reasonClause}
      ORDER BY review_records.updated_at DESC NULLS LAST
    `,
    params,
  );
  return result.rows;
}

export function tableForRecordType(type: RecordType) {
  return TABLE_BY_TYPE[type];
}

export function recordTypeForTable(table: string) {
  return TYPE_BY_TABLE[table];
}

function normalizeState(value: unknown) {
  if (!value) return null;
  return String(value).trim().toUpperCase().slice(0, 2);
}

function normalizeZip(value: unknown) {
  if (!value) return null;
  return String(value).trim().slice(0, 10);
}

export async function searchEntities(entity: string, q: string) {
  const schema = tenant();
  const query = q.trim();
  if (!["contacts", "companies", "properties"].includes(entity)) {
    const error = new Error("Unsupported search entity");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  if (query.length < 2) return [];

  const pattern = `%${query}%`;
  if (entity === "contacts") {
    const result = await pool.query(
      `
        SELECT
          contact.id,
          trim(contact.first_name || ' ' || contact.last_name) AS display_name,
          contact.email AS subtitle,
          company.name AS meta
        FROM ${quoteIdent(schema)}.contacts contact
        LEFT JOIN ${quoteIdent(schema)}.companies company ON company.id = contact.company_id
        WHERE contact.id::text = $1
           OR contact.first_name ILIKE $2
           OR contact.last_name ILIKE $2
           OR contact.email ILIKE $2
           OR contact.company_name ILIKE $2
           OR company.name ILIKE $2
        ORDER BY display_name NULLS LAST, contact.email NULLS LAST
        LIMIT 20
      `,
      [query, pattern],
    );
    return result.rows;
  }

  if (entity === "companies") {
    const result = await pool.query(
      `
        SELECT
          company.id,
          company.name AS display_name,
          company.website AS subtitle,
          concat_ws(', ', company.city, company.state) AS meta
        FROM ${quoteIdent(schema)}.companies company
        WHERE company.id::text = $1
           OR company.name ILIKE $2
           OR company.website ILIKE $2
           OR company.slug ILIKE $2
        ORDER BY company.name
        LIMIT 20
      `,
      [query, pattern],
    );
    return result.rows;
  }

  const result = await pool.query(
    `
      SELECT
        property.id,
        property.name AS display_name,
        property.address AS subtitle,
        concat_ws(', ', property.city, property.state, property.zip) AS meta
      FROM ${quoteIdent(schema)}.properties property
      WHERE property.id::text = $1
         OR property.name ILIKE $2
         OR property.address ILIKE $2
         OR property.city ILIKE $2
         OR property.zip ILIKE $2
      ORDER BY property.updated_at DESC NULLS LAST, property.name
      LIMIT 20
    `,
    [query, pattern],
  );
  return result.rows;
}

export async function createProperty(input: {
  company_id?: string;
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}) {
  const schema = tenant();
  if (!input.company_id) {
    const error = new Error("company_id is required to create a property");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  const company = await pool.query(`SELECT id FROM ${quoteIdent(schema)}.companies WHERE id = $1 LIMIT 1`, [input.company_id]);
  if (!company.rows[0]) {
    const error = new Error("Company not found");
    (error as Error & { status?: number }).status = 404;
    throw error;
  }

  const id = crypto.randomUUID();
  const name = String(input.name || input.address || "Migration cleanup property").slice(0, 500);
  const result = await pool.query(
    `
      INSERT INTO ${quoteIdent(schema)}.properties (
        id, company_id, name, address, city, state, zip, notes, is_test_data, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Created from onboarding cleanup property picker.', false, true)
      RETURNING
        id,
        name AS display_name,
        address AS subtitle,
        concat_ws(', ', city, state, zip) AS meta
    `,
    [
      id,
      input.company_id,
      name,
      input.address ? String(input.address) : null,
      input.city ? String(input.city).slice(0, 255) : null,
      normalizeState(input.state),
      normalizeZip(input.zip),
    ],
  );
  return result.rows[0];
}
