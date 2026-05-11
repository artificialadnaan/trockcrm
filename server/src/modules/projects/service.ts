import type { PoolClient } from "pg";

export type QueryExecutor = Pick<PoolClient, "query">;

export type ProjectSyncSource = "webhook" | "polling" | "backfill" | "manual";

export interface ProjectMirrorInput {
  procoreProjectId: string;
  procoreCompanyId: string;
  procoreProjectNumber?: string | null;
  name?: string | null;
  sourceDealId?: string | null;
  syncSource: ProjectSyncSource;
  snapshot?: Record<string, unknown> | null;
  rawEvent?: unknown;
}

export interface ProjectMirrorFields {
  sourceDealId: string | null;
  procoreProjectId: string;
  procoreCompanyId: string;
  procoreProjectNumber: string | null;
  name: string;
  description: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  currentPhaseId: string | null;
  currentPhaseName: string | null;
  currentPhaseSortOrder: number | null;
  isActive: boolean;
  startDate: string | null;
  completionDate: string | null;
  projectedFinishDate: string | null;
  warrantyEndDate: string | null;
  estimatedValue: string | null;
  contractValue: string | null;
  actualCost: string | null;
  projectOwnerId: string | null;
  projectOwnerName: string | null;
  procoreCreatedAt: string | null;
  procoreUpdatedAt: string | null;
  procoreRawSnapshot: Record<string, unknown>;
  syncSource: ProjectSyncSource;
}

export interface ProjectListFilters {
  phase?: string | null;
  search?: string | null;
  assignedOwner?: string | null;
  startFrom?: string | null;
  completionTo?: string | null;
  page: number;
  perPage: number;
  sortBy?: string | null;
  sortOrder?: string | null;
}

export interface ExistingProjectSyncRow {
  id: string;
  procoreUpdatedAt: string | null;
}

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SORT_COLUMNS: Record<string, string> = {
  projectNumber: "p.procore_project_number",
  name: "p.name",
  phase: "p.current_phase_name",
  owner: "p.project_owner_name",
  contractValue: "p.contract_value",
  startDate: "p.start_date",
  completionDate: "p.completion_date",
  lastSyncedAt: "p.last_synced_at",
};

export function quoteIdent(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asDateString(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  return raw.slice(0, 10);
}

function asTimestampString(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function pickDate(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asDateString(record[key]);
    if (value) return value;
  }
  return null;
}

function pickMoney(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function extractAddress(snapshot: Record<string, unknown>) {
  const address = snapshot.address;
  if (typeof address === "string") {
    return {
      addressLine1: address || null,
      addressLine2: pickString(snapshot, ["address_line_2", "address2"]),
      city: pickString(snapshot, ["city"]),
      state: pickString(snapshot, ["state", "state_code", "stateCode"]),
      postalCode: pickString(snapshot, ["zip", "postal_code", "postalCode"]),
      country: pickString(snapshot, ["country", "country_code", "countryCode"]),
    };
  }

  const addressObject = asRecord(address);
  return {
    addressLine1:
      pickString(snapshot, ["address_line_1", "address1"]) ??
      (addressObject ? pickString(addressObject, ["street", "address", "line1"]) : null),
    addressLine2:
      pickString(snapshot, ["address_line_2", "address2"]) ??
      (addressObject ? pickString(addressObject, ["line2", "suite"]) : null),
    city: pickString(snapshot, ["city"]) ?? (addressObject ? pickString(addressObject, ["city"]) : null),
    state:
      pickString(snapshot, ["state", "state_code", "stateCode"]) ??
      (addressObject ? pickString(addressObject, ["state", "state_code", "stateCode"]) : null),
    postalCode:
      pickString(snapshot, ["zip", "postal_code", "postalCode"]) ??
      (addressObject ? pickString(addressObject, ["zip", "postal_code", "postalCode"]) : null),
    country:
      pickString(snapshot, ["country", "country_code", "countryCode"]) ??
      (addressObject ? pickString(addressObject, ["country", "country_code", "countryCode"]) : null),
  };
}

function extractPhase(snapshot: Record<string, unknown>) {
  const projectStage = asRecord(snapshot.project_stage) ?? asRecord(snapshot.projectStage);
  const phaseId =
    (projectStage ? pickString(projectStage, ["id"]) : null) ??
    pickString(snapshot, ["project_stage_id", "projectStageId", "stage_id", "stageId"]);
  const phaseName =
    (projectStage ? pickString(projectStage, ["name"]) : null) ??
    pickString(snapshot, ["project_stage_name", "projectStageName", "stage_name", "stageName", "stage"]);
  const sortOrder =
    (projectStage ? asNumber(projectStage.position ?? projectStage.sort_order ?? projectStage.sortOrder) : null) ??
    asNumber(snapshot.current_phase_sort_order ?? snapshot.sort_order ?? snapshot.sortOrder);

  return { phaseId, phaseName, sortOrder };
}

function extractOwner(snapshot: Record<string, unknown>) {
  const owner =
    asRecord(snapshot.owner) ??
    asRecord(snapshot.project_owner) ??
    asRecord(snapshot.projectOwner) ??
    asRecord(snapshot.project_manager) ??
    asRecord(snapshot.projectManager);
  return {
    ownerId:
      (owner ? pickString(owner, ["id", "user_id", "userId"]) : null) ??
      pickString(snapshot, ["project_owner_id", "projectOwnerId", "owner_id", "ownerId"]),
    ownerName:
      (owner ? pickString(owner, ["name", "full_name", "fullName"]) : null) ??
      pickString(snapshot, ["project_owner_name", "projectOwnerName", "owner_name", "ownerName"]),
  };
}

export function buildProjectMirrorFields(input: ProjectMirrorInput): ProjectMirrorFields {
  const snapshot = input.snapshot ?? {};
  const address = extractAddress(snapshot);
  const phase = extractPhase(snapshot);
  const owner = extractOwner(snapshot);
  const name =
    input.name ??
    pickString(snapshot, ["name", "display_name", "displayName"]) ??
    input.procoreProjectNumber ??
    `Procore project ${input.procoreProjectId}`;

  return {
    sourceDealId: input.sourceDealId ?? null,
    procoreProjectId: input.procoreProjectId,
    procoreCompanyId: input.procoreCompanyId,
    procoreProjectNumber:
      input.procoreProjectNumber ?? pickString(snapshot, ["project_number", "projectNumber"]),
    name,
    description: pickString(snapshot, ["description"]),
    ...address,
    currentPhaseId: phase.phaseId,
    currentPhaseName: phase.phaseName,
    currentPhaseSortOrder: phase.sortOrder,
    isActive: typeof snapshot.active === "boolean" ? snapshot.active : snapshot.status_name !== "Inactive",
    startDate: pickDate(snapshot, ["start_date", "startDate"]),
    completionDate: pickDate(snapshot, ["completion_date", "completionDate"]),
    projectedFinishDate: pickDate(snapshot, ["projected_finish_date", "projectedFinishDate"]),
    warrantyEndDate: pickDate(snapshot, ["warranty_end_date", "warrantyEndDate"]),
    estimatedValue: pickMoney(snapshot, ["estimated_value", "estimatedValue"]),
    contractValue: pickMoney(snapshot, ["contract_value", "contractValue", "total_value", "totalValue"]),
    actualCost: pickMoney(snapshot, ["actual_cost", "actualCost"]),
    projectOwnerId: owner.ownerId,
    projectOwnerName: owner.ownerName,
    procoreCreatedAt: asTimestampString(snapshot.created_at ?? snapshot.createdAt),
    procoreUpdatedAt: asTimestampString(snapshot.updated_at ?? snapshot.updatedAt),
    procoreRawSnapshot: snapshot,
    syncSource: input.syncSource,
  };
}

export async function upsertProjectMirror(
  client: QueryExecutor,
  schemaName: string,
  input: ProjectMirrorInput
): Promise<{ projectId: string; phaseChanged: boolean }> {
  const schema = quoteIdent(schemaName);
  const fields = buildProjectMirrorFields(input);
  const existingResult = await client.query(
    `SELECT id, current_phase_id, current_phase_name
       FROM ${schema}.projects
      WHERE procore_project_id = $1
      LIMIT 1`,
    [fields.procoreProjectId]
  );
  const existing = existingResult.rows[0] as
    | { id: string; current_phase_id: string | null; current_phase_name: string | null }
    | undefined;

  const values = [
    fields.sourceDealId,
    fields.procoreProjectId,
    fields.procoreCompanyId,
    fields.procoreProjectNumber,
    fields.name,
    fields.description,
    fields.addressLine1,
    fields.addressLine2,
    fields.city,
    fields.state,
    fields.postalCode,
    fields.country,
    fields.currentPhaseId,
    fields.currentPhaseName,
    fields.currentPhaseSortOrder,
    fields.isActive,
    fields.startDate,
    fields.completionDate,
    fields.projectedFinishDate,
    fields.warrantyEndDate,
    fields.estimatedValue,
    fields.contractValue,
    fields.actualCost,
    fields.projectOwnerId,
    fields.projectOwnerName,
    fields.procoreCreatedAt,
    fields.procoreUpdatedAt,
    JSON.stringify(fields.procoreRawSnapshot),
    fields.syncSource,
  ];

  const upsertResult = await client.query(
    `INSERT INTO ${schema}.projects (
       source_deal_id, procore_project_id, procore_company_id, procore_project_number,
       name, description, address_line_1, address_line_2, city, state, postal_code, country,
       current_phase_id, current_phase_name, current_phase_sort_order, is_active,
       start_date, completion_date, projected_finish_date, warranty_end_date,
       estimated_value, contract_value, actual_cost, project_owner_id, project_owner_name,
       procore_created_at, procore_updated_at, procore_raw_snapshot, sync_source,
       last_synced_at, updated_at
     )
     VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16,
       $17::date, $18::date, $19::date, $20::date,
       $21::numeric, $22::numeric, $23::numeric, $24, $25,
       $26::timestamptz, $27::timestamptz, $28::jsonb, $29,
       NOW(), NOW()
     )
     ON CONFLICT (procore_project_id) DO UPDATE SET
       source_deal_id = COALESCE(EXCLUDED.source_deal_id, ${schema}.projects.source_deal_id),
       procore_company_id = EXCLUDED.procore_company_id,
       procore_project_number = COALESCE(EXCLUDED.procore_project_number, ${schema}.projects.procore_project_number),
       name = EXCLUDED.name,
       description = COALESCE(EXCLUDED.description, ${schema}.projects.description),
       address_line_1 = COALESCE(EXCLUDED.address_line_1, ${schema}.projects.address_line_1),
       address_line_2 = COALESCE(EXCLUDED.address_line_2, ${schema}.projects.address_line_2),
       city = COALESCE(EXCLUDED.city, ${schema}.projects.city),
       state = COALESCE(EXCLUDED.state, ${schema}.projects.state),
       postal_code = COALESCE(EXCLUDED.postal_code, ${schema}.projects.postal_code),
       country = COALESCE(EXCLUDED.country, ${schema}.projects.country),
       current_phase_id = COALESCE(EXCLUDED.current_phase_id, ${schema}.projects.current_phase_id),
       current_phase_name = COALESCE(EXCLUDED.current_phase_name, ${schema}.projects.current_phase_name),
       current_phase_sort_order = COALESCE(EXCLUDED.current_phase_sort_order, ${schema}.projects.current_phase_sort_order),
       is_active = EXCLUDED.is_active,
       start_date = COALESCE(EXCLUDED.start_date, ${schema}.projects.start_date),
       completion_date = COALESCE(EXCLUDED.completion_date, ${schema}.projects.completion_date),
       projected_finish_date = COALESCE(EXCLUDED.projected_finish_date, ${schema}.projects.projected_finish_date),
       warranty_end_date = COALESCE(EXCLUDED.warranty_end_date, ${schema}.projects.warranty_end_date),
       estimated_value = COALESCE(EXCLUDED.estimated_value, ${schema}.projects.estimated_value),
       contract_value = COALESCE(EXCLUDED.contract_value, ${schema}.projects.contract_value),
       actual_cost = COALESCE(EXCLUDED.actual_cost, ${schema}.projects.actual_cost),
       project_owner_id = COALESCE(EXCLUDED.project_owner_id, ${schema}.projects.project_owner_id),
       project_owner_name = COALESCE(EXCLUDED.project_owner_name, ${schema}.projects.project_owner_name),
       procore_created_at = COALESCE(EXCLUDED.procore_created_at, ${schema}.projects.procore_created_at),
       procore_updated_at = COALESCE(EXCLUDED.procore_updated_at, ${schema}.projects.procore_updated_at),
       procore_raw_snapshot = CASE
         WHEN EXCLUDED.procore_raw_snapshot = '{}'::jsonb THEN ${schema}.projects.procore_raw_snapshot
         ELSE EXCLUDED.procore_raw_snapshot
       END,
       sync_source = EXCLUDED.sync_source,
       last_synced_at = NOW(),
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    values
  );

  const upsertedRow = upsertResult.rows[0] as { id: string; inserted?: boolean | string } | undefined;
  const projectId = upsertedRow?.id as string;
  const oldPhaseKey = `${existing?.current_phase_id ?? ""}:${existing?.current_phase_name ?? ""}`;
  const newPhaseKey = `${fields.currentPhaseId ?? ""}:${fields.currentPhaseName ?? ""}`;
  const phaseChanged = Boolean(existing && fields.currentPhaseName && oldPhaseKey !== newPhaseKey);

  if (phaseChanged) {
    const previous = existing;
    if (!previous) {
      throw new Error("Invariant violation: phase change requires an existing project");
    }
    const rawEvent = asRecord(input.rawEvent);
    await client.query(
      `INSERT INTO ${schema}.project_phase_history (
         project_id, from_phase_id, from_phase_name, to_phase_id, to_phase_name,
         changed_at, changed_by_procore_user_id, changed_by_procore_user_name,
         sync_source, raw_event
       )
       VALUES ($1::uuid, $2, $3, $4, $5, NOW(), $6, $7, $8, $9::jsonb)`,
      [
        projectId,
        previous.current_phase_id,
        previous.current_phase_name,
        fields.currentPhaseId,
        fields.currentPhaseName,
        asString(rawEvent?.user_id ?? rawEvent?.userId),
        asString(rawEvent?.user_name ?? rawEvent?.userName),
        input.syncSource,
        JSON.stringify(input.rawEvent ?? input.snapshot ?? {}),
      ]
    );
  }

  if (!existing && fields.currentPhaseName) {
    await client.query(
      `INSERT INTO ${schema}.project_phase_history (
         project_id, from_phase_id, from_phase_name, to_phase_id, to_phase_name,
         changed_at, sync_source, raw_event
       )
       VALUES ($1::uuid, NULL, NULL, $2, $3, NOW(), $4, $5::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        projectId,
        fields.currentPhaseId,
        fields.currentPhaseName,
        input.syncSource,
        JSON.stringify(input.rawEvent ?? input.snapshot ?? {}),
      ]
    );
  }

  await client.query(
    `INSERT INTO ${schema}.project_sync_state (
       procore_project_id, last_full_refresh_at, last_webhook_at, last_error,
       consecutive_errors, updated_at
     )
     VALUES (
       $1,
       CASE WHEN $2 = 'backfill' THEN NOW() ELSE NULL END,
       CASE WHEN $2 = 'webhook' THEN NOW() ELSE NULL END,
       NULL,
       0,
       NOW()
     )
     ON CONFLICT (procore_project_id) DO UPDATE SET
       last_full_refresh_at = CASE WHEN $2 = 'backfill' THEN NOW() ELSE ${schema}.project_sync_state.last_full_refresh_at END,
       last_webhook_at = CASE WHEN $2 = 'webhook' THEN NOW() ELSE ${schema}.project_sync_state.last_webhook_at END,
       last_error = NULL,
       consecutive_errors = 0,
       updated_at = NOW()`,
    [fields.procoreProjectId, fields.syncSource]
  );

  return { projectId, phaseChanged };
}

export async function findExistingProjectSyncRow(
  client: QueryExecutor,
  procoreProjectId: string
): Promise<ExistingProjectSyncRow | null> {
  const result = await client.query(
    `SELECT id, procore_updated_at
       FROM projects
      WHERE procore_project_id = $1
      LIMIT 1`,
    [procoreProjectId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    procoreUpdatedAt: row.procore_updated_at ? new Date(row.procore_updated_at).toISOString() : null,
  };
}

export async function findSourceDealIdForProcoreProject(
  client: QueryExecutor,
  procoreProjectId: string,
  procoreProjectNumber?: string | null
): Promise<string | null> {
  const numericId = Number(procoreProjectId);
  const hasNumericId = Number.isSafeInteger(numericId) && numericId > 0;
  const result = await client.query(
    `SELECT id
       FROM deals
      WHERE is_active = true
        AND (
          ($1::bigint IS NOT NULL AND procore_project_id = $1::bigint)
          OR ($2::text IS NOT NULL AND deal_number = $2::text)
        )
      LIMIT 1`,
    [hasNumericId ? numericId : null, procoreProjectNumber ?? null]
  );
  return result.rows[0]?.id ?? null;
}

function readPositiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function toApiProject(row: any) {
  return {
    id: row.id,
    procoreProjectId: row.procore_project_id,
    procoreProjectNumber: row.procore_project_number,
    name: row.name,
    currentPhaseId: row.current_phase_id,
    currentPhaseName: row.current_phase_name,
    currentPhaseSortOrder: row.current_phase_sort_order,
    startDate: row.start_date,
    completionDate: row.completion_date,
    projectedFinishDate: row.projected_finish_date,
    contractValue: row.contract_value,
    estimatedValue: row.estimated_value,
    actualCost: row.actual_cost,
    sourceDealId: row.source_deal_id,
    sourceDealNumber: row.source_deal_number ?? null,
    address: {
      line1: row.address_line_1,
      line2: row.address_line_2,
      city: row.city,
      state: row.state,
      postalCode: row.postal_code,
      country: row.country,
    },
    projectOwnerName: row.project_owner_name,
    lastSyncedAt: row.last_synced_at,
    syncSource: row.sync_source,
  };
}

function buildWhere(filters: {
  phase?: string | null;
  search?: string | null;
  assignedOwner?: string | null;
  startFrom?: string | null;
  completionTo?: string | null;
}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.phase) {
    params.push(filters.phase);
    conditions.push(`(p.current_phase_id = $${params.length} OR p.current_phase_name = $${params.length})`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.procore_project_number ILIKE $${params.length})`);
  }
  if (filters.assignedOwner) {
    params.push(filters.assignedOwner);
    conditions.push(`d.assigned_rep_id = $${params.length}::uuid`);
  }
  if (filters.startFrom) {
    params.push(filters.startFrom);
    conditions.push(`p.start_date >= $${params.length}::date`);
  }
  if (filters.completionTo) {
    params.push(filters.completionTo);
    conditions.push(`p.completion_date <= $${params.length}::date`);
  }
  return {
    clause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export async function listProjects(client: QueryExecutor, filters: ProjectListFilters) {
  const page = readPositiveInt(filters.page, 1, 10_000);
  const perPage = readPositiveInt(filters.perPage, 25, 100);
  const offset = (page - 1) * perPage;
  const { clause, params } = buildWhere(filters);
  const sortColumn = SORT_COLUMNS[filters.sortBy ?? ""] ?? "p.current_phase_sort_order";
  const sortDirection = filters.sortOrder === "desc" ? "DESC" : "ASC";

  const countResult = await client.query(
    `SELECT COUNT(*)::int AS total
       FROM projects p
       LEFT JOIN deals d ON d.id = p.source_deal_id
      ${clause}`,
    params
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const rowsResult = await client.query(
    `SELECT p.*, d.deal_number AS source_deal_number
       FROM projects p
       LEFT JOIN deals d ON d.id = p.source_deal_id
      ${clause}
      ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, p.name ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPage, offset]
  );

  return {
    projects: rowsResult.rows.map(toApiProject),
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

export async function listProjectsByPhase(
  client: QueryExecutor,
  filters: Omit<ProjectListFilters, "page" | "perPage" | "sortBy" | "sortOrder"> = {}
) {
  const { clause, params } = buildWhere(filters);
  const rowsResult = await client.query(
    `WITH ranked AS (
       SELECT p.*,
              d.deal_number AS source_deal_number,
              COUNT(*) OVER (PARTITION BY COALESCE(p.current_phase_id, p.current_phase_name, 'Unassigned'))::int AS phase_count,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(p.current_phase_id, p.current_phase_name, 'Unassigned')
                ORDER BY p.name ASC
              ) AS rn
         FROM projects p
         LEFT JOIN deals d ON d.id = p.source_deal_id
        ${clause}
     )
     SELECT *
       FROM ranked
      WHERE rn <= 50
      ORDER BY current_phase_sort_order NULLS LAST, current_phase_name NULLS LAST, name ASC`,
    params
  );

  const phaseMap = new Map<string, any>();
  for (const row of rowsResult.rows) {
    const phaseId = row.current_phase_id ?? row.current_phase_name ?? "unassigned";
    if (!phaseMap.has(phaseId)) {
      phaseMap.set(phaseId, {
        phaseId,
        phaseName: row.current_phase_name ?? "Unassigned",
        sortOrder: row.current_phase_sort_order ?? 999,
        count: row.phase_count,
        overflowCount: Math.max(0, Number(row.phase_count ?? 0) - 50),
        projects: [],
      });
    }
    phaseMap.get(phaseId).projects.push(toApiProject(row));
  }
  return { phases: Array.from(phaseMap.values()) };
}

export async function getProjectDetail(client: QueryExecutor, projectId: string) {
  const projectResult = await client.query(
    `SELECT p.*, d.deal_number AS source_deal_number, d.name AS source_deal_name
       FROM projects p
       LEFT JOIN deals d ON d.id = p.source_deal_id
      WHERE p.id = $1::uuid
      LIMIT 1`,
    [projectId]
  );
  const project = projectResult.rows[0];
  if (!project) return null;
  return {
    ...toApiProject(project),
    description: project.description,
    warrantyEndDate: project.warranty_end_date,
    projectOwnerId: project.project_owner_id,
    procoreCreatedAt: project.procore_created_at,
    procoreUpdatedAt: project.procore_updated_at,
    rawSnapshot: project.procore_raw_snapshot,
    sourceDeal: project.source_deal_id
      ? {
          id: project.source_deal_id,
          dealNumber: project.source_deal_number,
          name: project.source_deal_name,
        }
      : null,
  };
}

export async function getProjectTeam(client: QueryExecutor, projectId: string) {
  const result = await client.query(
    `SELECT id, procore_user_id, procore_user_name, procore_user_email, role_name,
            is_active, assigned_at, last_synced_at
       FROM project_team
      WHERE project_id = $1::uuid
      ORDER BY role_name NULLS LAST, procore_user_name NULLS LAST`,
    [projectId]
  );
  return { team: result.rows };
}

export async function getProjectDocuments(client: QueryExecutor, projectId: string) {
  const result = await client.query(
    `SELECT id, procore_document_id, name, file_url, file_size, mime_type, folder_path,
            uploaded_by_procore_user_name, uploaded_at, last_synced_at
       FROM project_documents
      WHERE project_id = $1::uuid
      ORDER BY uploaded_at DESC NULLS LAST, name ASC`,
    [projectId]
  );
  return { documents: result.rows };
}

export async function getProjectPhaseHistory(client: QueryExecutor, projectId: string) {
  const result = await client.query(
    `SELECT id, from_phase_id, from_phase_name, to_phase_id, to_phase_name,
            changed_at, changed_by_procore_user_id, changed_by_procore_user_name, sync_source
       FROM project_phase_history
      WHERE project_id = $1::uuid
      ORDER BY changed_at DESC`,
    [projectId]
  );
  return { phaseHistory: result.rows };
}
