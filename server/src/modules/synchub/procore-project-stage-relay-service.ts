import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { normalizePortfolioProjectStage, isPortfolioProjectBoardStage } from "@trock-crm/shared/types";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

type QueryClient = Pick<PoolClient, "query"> & { release?: () => void };

type OfficeRow = { id: string; slug: string };

type TenantMatch = {
  officeId: string;
  officeSlug: string;
  schemaName: string;
  dealId: string | null;
  procoreProjectId: number | null;
};

type ServiceDeps = {
  client?: QueryClient;
  receivedAt?: Date;
};

type ProcoreCompanyOfficeMapping = {
  procoreCompanyId: string;
  officeSchema: string;
};

export type ReplayUnresolvedStageReceiptsOptions = {
  client?: QueryClient;
  commit?: boolean;
  limit?: number;
};

export type ReplayUnresolvedStageReceiptsResult = {
  mode: "dry-run" | "commit";
  scanned: number;
  replayed: number;
  wouldReplay: number;
  stillUnresolved: number;
  duplicates: number;
  failed: number;
  results: Array<{
    receiptId: string;
    eventKey: string;
    procoreCompanyId: string;
    procoreProjectId: string;
    projectNumber: string | null;
    outcome: SyncHubProjectStageChangedResult["status"] | "would_record" | "failed";
    reason?: string;
    officeSlug?: string;
  }>;
};

export type SyncHubProjectStageChangedPayload = {
  eventType: "procore.project.stage_changed";
  source?: string;
  procore: {
    companyId: string;
    portfolioProjectId: string;
    projectNumber: string | null;
    projectName: string | null;
    previousStage: string | null;
    currentStage: string;
  };
  stageChange: {
    previousStage: string | null;
    newStage: string;
    detectedAt: string | null;
    webhookTimestamp: string | null;
  };
  stage: {
    previous: { raw: string | null; normalized: string | null };
    current: { raw: string; normalized: string; isBoardRelevant: boolean };
  };
  synchub?: {
    webhookLogId?: string | number | null;
    syncMappingId?: string | number | null;
    bidboardProjectId?: string | null;
    hubspotDealId?: string | null;
    receivedAt?: string | null;
    enrichedAt?: string | null;
  };
  rawProcoreWebhook?: unknown;
};

export type SyncHubProjectStageChangedResult =
  | {
      status: "recorded";
      officeId: string;
      officeSlug: string;
      projectId: string;
      stageEntryId: string;
      isBoardRelevant: boolean;
    }
  | { status: "duplicate"; eventKey: string }
  | { status: "unresolved"; reason: "no_tenant_match" | "multiple_tenant_matches"; eventKey: string };

const OFFICE_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
export const PROCORE_COMPANY_OFFICE_MAP_ENV = "PROCORE_COMPANY_OFFICE_MAP";

// Explicit bootstrap mapping for the current production Procore Portfolio company.
// Deployments can extend or replace this with PROCORE_COMPANY_OFFICE_MAP.
const DEFAULT_PROCORE_COMPANY_OFFICE_MAPPINGS: ProcoreCompanyOfficeMapping[] = [
  {
    procoreCompanyId: "598134325683880",
    officeSchema: "office_dallas",
  },
];

function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new AppError(400, "Invalid schema name");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function schemaNameForOffice(slug: string): string | null {
  if (!OFFICE_SLUG_PATTERN.test(slug)) return null;
  return `office_${slug}`;
}

function officeSlugForSchemaName(schemaName: string): string | null {
  if (!schemaName.startsWith("office_")) return null;
  const slug = schemaName.slice("office_".length);
  return OFFICE_SLUG_PATTERN.test(slug) ? slug : null;
}

function normalizeOfficeMappingTarget(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const schemaName = trimmed.startsWith("office_") ? trimmed : schemaNameForOffice(trimmed);
  if (!schemaName) return null;
  return officeSlugForSchemaName(schemaName) ? schemaName : null;
}

function parseProcoreCompanyOfficeMappings(raw: string | undefined): ProcoreCompanyOfficeMapping[] {
  if (!raw?.trim()) return DEFAULT_PROCORE_COMPANY_OFFICE_MAPPINGS;

  const trimmed = raw.trim();
  const entries: Array<[string, unknown]> = [];
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError(500, `${PROCORE_COMPANY_OFFICE_MAP_ENV} must be a JSON object or comma-separated map`);
    }
    entries.push(...Object.entries(parsed));
  } else {
    for (const pair of trimmed.split(",")) {
      const [companyId, officeSchema] = pair.split("=").map((part) => part?.trim());
      if (companyId && officeSchema) {
        entries.push([companyId, officeSchema]);
      }
    }
  }

  const mappings = entries.flatMap(([companyId, officeSchema]) => {
    const procoreCompanyId = String(companyId).trim();
    const normalizedSchema = typeof officeSchema === "string"
      ? normalizeOfficeMappingTarget(officeSchema)
      : null;
    if (!procoreCompanyId || !normalizedSchema) return [];
    return [{ procoreCompanyId, officeSchema: normalizedSchema }];
  });

  if (mappings.length === 0) {
    throw new AppError(500, `${PROCORE_COMPANY_OFFICE_MAP_ENV} has no valid Procore company office mappings`);
  }
  return mappings;
}

export function getProcoreCompanyOfficeMappings(): ProcoreCompanyOfficeMapping[] {
  return parseProcoreCompanyOfficeMappings(process.env[PROCORE_COMPANY_OFFICE_MAP_ENV]);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "Invalid payload");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(400, message);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const text = String(value).trim();
    return text || null;
  }
  return null;
}

function parseSafeProcoreId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(400, "procore.portfolioProjectId must be a safe positive integer");
  }
  return parsed;
}

function toIsoOrNull(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function eventTimestamp(payload: SyncHubProjectStageChangedPayload, receivedAt: Date): {
  enteredAt: string;
  detectedAt: string | null;
  webhookTimestamp: string | null;
} {
  const detectedAt = toIsoOrNull(payload.stageChange.detectedAt);
  const webhookTimestamp = toIsoOrNull(payload.stageChange.webhookTimestamp);
  return {
    enteredAt: detectedAt ?? webhookTimestamp ?? receivedAt.toISOString(),
    detectedAt,
    webhookTimestamp,
  };
}

function eventKeyForPayload(payload: SyncHubProjectStageChangedPayload): string {
  const traceKey = optionalString(payload.synchub?.webhookLogId) ?? optionalString((payload.rawProcoreWebhook as any)?.id);
  if (traceKey) {
    return [
      "synchub-stage",
      traceKey,
      payload.procore.companyId,
      payload.procore.portfolioProjectId,
      payload.stage.current.normalized,
      payload.stageChange.detectedAt ?? "",
    ].join(":");
  }

  const digest = createHash("sha256")
    .update(JSON.stringify({
      source: payload.source ?? null,
      companyId: payload.procore.companyId,
      portfolioProjectId: payload.procore.portfolioProjectId,
      projectNumber: payload.procore.projectNumber,
      projectName: payload.procore.projectName,
      previousStage: payload.stage.previous.normalized,
      stage: payload.stage.current.normalized,
      detectedAt: payload.stageChange.detectedAt,
      webhookTimestamp: payload.stageChange.webhookTimestamp,
      synchubReceivedAt: optionalString(payload.synchub?.receivedAt),
      synchubEnrichedAt: optionalString(payload.synchub?.enrichedAt),
      syncMappingId: optionalString(payload.synchub?.syncMappingId),
      bidboardProjectId: optionalString(payload.synchub?.bidboardProjectId),
      hubspotDealId: optionalString(payload.synchub?.hubspotDealId),
      rawProcoreWebhook: payload.rawProcoreWebhook ?? null,
    }))
    .digest("hex")
    .slice(0, 32);
  return `synchub-stage:${digest}`;
}

export function validateSyncHubProjectStageChangedPayload(input: unknown): SyncHubProjectStageChangedPayload {
  const payload = asObject(input);
  if (payload.eventType !== "procore.project.stage_changed") {
    throw new AppError(400, "unsupported event type");
  }

  const procore = asObject(payload.procore);
  const stageChange = asObject(payload.stageChange);
  const companyId = requiredString(procore.companyId, "procore.companyId is required");
  const portfolioProjectId = requiredString(
    procore.portfolioProjectId,
    "procore.portfolioProjectId is required"
  );
  const currentStage = requiredString(
    procore.currentStage ?? stageChange.newStage,
    "procore.currentStage is required"
  );
  const newStage = requiredString(stageChange.newStage ?? currentStage, "stageChange.newStage is required");
  const normalizedCurrentStage = normalizePortfolioProjectStage(newStage);
  const previousStage = optionalString(stageChange.previousStage ?? procore.previousStage);

  return {
    eventType: "procore.project.stage_changed",
    source: typeof payload.source === "string" ? payload.source : undefined,
    procore: {
      companyId,
      portfolioProjectId,
      projectNumber: optionalString(procore.projectNumber),
      projectName: optionalString(procore.projectName),
      previousStage,
      currentStage: newStage,
    },
    stageChange: {
      previousStage,
      newStage,
      detectedAt: optionalString(stageChange.detectedAt),
      webhookTimestamp: optionalString(stageChange.webhookTimestamp),
    },
    stage: {
      previous: {
        raw: previousStage,
        normalized: previousStage ? normalizePortfolioProjectStage(previousStage) : null,
      },
      current: {
        raw: newStage,
        normalized: normalizedCurrentStage,
        isBoardRelevant: isPortfolioProjectBoardStage(normalizedCurrentStage),
      },
    },
    synchub: payload.synchub && typeof payload.synchub === "object"
      ? payload.synchub as SyncHubProjectStageChangedPayload["synchub"]
      : undefined,
    rawProcoreWebhook: payload.rawProcoreWebhook,
  };
}

async function existingReceipt(client: QueryClient, eventKey: string) {
  const result = await client.query(
    `SELECT id, event_key, status, processed_at
       FROM public.portfolio_project_stage_event_receipts
      WHERE event_key = $1
      LIMIT 1`,
    [eventKey]
  );
  return result.rows[0] ?? null;
}

async function getActiveOffices(client: QueryClient): Promise<OfficeRow[]> {
  const result = await client.query(
    "SELECT id, slug FROM public.offices WHERE is_active = true ORDER BY created_at ASC"
  );
  return result.rows.filter((row) => typeof row.slug === "string" && schemaNameForOffice(row.slug));
}

function mapTenantMatch(row: any): TenantMatch {
  return {
    officeId: row.office_id,
    officeSlug: row.office_slug,
    schemaName: row.schema_name,
    dealId: row.deal_id ?? null,
    procoreProjectId: row.procore_project_id == null ? null : Number(row.procore_project_id),
  };
}

function findMappedOfficeForCompanyId(
  offices: OfficeRow[],
  procoreCompanyId: string
): TenantMatch | "no_tenant_match" | "multiple_tenant_matches" {
  const configuredSchemas = getProcoreCompanyOfficeMappings()
    .filter((mapping) => mapping.procoreCompanyId === procoreCompanyId)
    .map((mapping) => mapping.officeSchema);
  const uniqueSchemas = [...new Set(configuredSchemas)];
  if (uniqueSchemas.length === 0) return "no_tenant_match";
  if (uniqueSchemas.length > 1) return "multiple_tenant_matches";

  const officeSlug = officeSlugForSchemaName(uniqueSchemas[0]);
  if (!officeSlug) return "no_tenant_match";
  const office = offices.find((row) => row.slug === officeSlug);
  if (!office) return "no_tenant_match";

  return {
    officeId: office.id,
    officeSlug: office.slug,
    schemaName: uniqueSchemas[0],
    dealId: null,
    procoreProjectId: null,
  };
}

async function findMatchesByProcoreProjectId(
  client: QueryClient,
  offices: OfficeRow[],
  procoreProjectId: number,
  procoreCompanyId: string
): Promise<TenantMatch[]> {
  const matches: TenantMatch[] = [];
  for (const office of offices) {
    const schemaName = schemaNameForOffice(office.slug);
    if (!schemaName) continue;
    const result = await client.query(
      `SELECT $2::uuid AS office_id,
              $3::text AS office_slug,
              $4::text AS schema_name,
              id AS deal_id,
              procore_project_id
       FROM ${quoteIdent(schemaName)}.deals
        WHERE procore_project_id = $1
          AND procore_company_id = $5
          AND is_active = true
        LIMIT 2`,
      [procoreProjectId, office.id, office.slug, schemaName, procoreCompanyId]
    );
    matches.push(...result.rows.map(mapTenantMatch));
    if (matches.length > 1) return matches;
  }
  return matches;
}

async function findMatchesByProjectNumber(
  client: QueryClient,
  offices: OfficeRow[],
  projectNumber: string | null,
  procoreCompanyId: string
): Promise<TenantMatch[]> {
  if (!projectNumber) return [];
  const matches: TenantMatch[] = [];
  for (const office of offices) {
    const schemaName = schemaNameForOffice(office.slug);
    if (!schemaName) continue;
    const result = await client.query(
      `SELECT $2::uuid AS office_id,
              $3::text AS office_slug,
              $4::text AS schema_name,
              id AS deal_id,
              procore_project_id
       FROM ${quoteIdent(schemaName)}.deals
        WHERE (deal_number = $1 OR project_number = $1)
          AND procore_company_id = $5
          AND is_active = true
        LIMIT 2`,
      [projectNumber, office.id, office.slug, schemaName, procoreCompanyId]
    );
    matches.push(...result.rows.map(mapTenantMatch));
    if (matches.length > 1) return matches;
  }
  return matches;
}

async function resolveTenantMatch(
  client: QueryClient,
  payload: SyncHubProjectStageChangedPayload
): Promise<TenantMatch | "no_tenant_match" | "multiple_tenant_matches"> {
  const offices = await getActiveOffices(client);
  const procoreProjectId = parseSafeProcoreId(payload.procore.portfolioProjectId);
  const mappedOffice = findMappedOfficeForCompanyId(offices, payload.procore.companyId);
  if (mappedOffice === "no_tenant_match" || mappedOffice === "multiple_tenant_matches") {
    return mappedOffice;
  }
  const mappedOfficeRows = [{ id: mappedOffice.officeId, slug: mappedOffice.officeSlug }];

  const linkedMatches = await findMatchesByProcoreProjectId(
    client,
    mappedOfficeRows,
    procoreProjectId,
    payload.procore.companyId
  );
  if (linkedMatches.length === 1) return linkedMatches[0];
  if (linkedMatches.length > 1) return "multiple_tenant_matches";

  const projectNumberMatches = await findMatchesByProjectNumber(
    client,
    mappedOfficeRows,
    payload.procore.projectNumber,
    payload.procore.companyId
  );
  if (projectNumberMatches.some((match) =>
    match.procoreProjectId != null && match.procoreProjectId !== procoreProjectId
  )) {
    return "multiple_tenant_matches";
  }
  const validProjectNumberMatches = projectNumberMatches.filter((match) =>
    match.procoreProjectId == null || match.procoreProjectId === procoreProjectId
  );
  if (validProjectNumberMatches.length === 1) return validProjectNumberMatches[0];
  if (validProjectNumberMatches.length > 1) return "multiple_tenant_matches";
  return mappedOffice;
}

async function insertUnresolvedReceipt(input: {
  client: QueryClient;
  payload: SyncHubProjectStageChangedPayload;
  eventKey: string;
  reason?: string;
  receivedAt: Date;
}) {
  const result = await input.client.query(
    `INSERT INTO public.portfolio_project_stage_event_receipts AS receipts
       (event_key, status, office_id, office_slug, procore_company_id,
        procore_portfolio_project_id, project_number, project_name, previous_stage,
        current_stage, current_stage_normalized, is_board_relevant,
        synchub_webhook_log_id, synchub_sync_mapping_id, error_reason,
       raw_payload, received_at, processed_at)
     VALUES
       ($1, 'unresolved', NULL::uuid, NULL, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13::jsonb, $14::timestamptz, NULL::timestamptz)
     ON CONFLICT (event_key) DO UPDATE SET
       status = 'unresolved',
       office_id = NULL,
       office_slug = NULL,
       procore_company_id = EXCLUDED.procore_company_id,
       procore_portfolio_project_id = EXCLUDED.procore_portfolio_project_id,
       project_number = EXCLUDED.project_number,
       project_name = EXCLUDED.project_name,
       previous_stage = EXCLUDED.previous_stage,
       current_stage = EXCLUDED.current_stage,
       current_stage_normalized = EXCLUDED.current_stage_normalized,
       is_board_relevant = EXCLUDED.is_board_relevant,
       synchub_webhook_log_id = EXCLUDED.synchub_webhook_log_id,
       synchub_sync_mapping_id = EXCLUDED.synchub_sync_mapping_id,
       error_reason = EXCLUDED.error_reason,
       raw_payload = EXCLUDED.raw_payload,
       processed_at = NULL,
       updated_at = NOW()
     WHERE receipts.status = 'unresolved'
     RETURNING id`,
    [
      input.eventKey,
      input.payload.procore.companyId,
      input.payload.procore.portfolioProjectId,
      input.payload.procore.projectNumber,
      input.payload.procore.projectName,
      input.payload.stage.previous.raw,
      input.payload.stage.current.raw,
      input.payload.stage.current.normalized,
      input.payload.stage.current.isBoardRelevant,
      optionalString(input.payload.synchub?.webhookLogId),
      optionalString(input.payload.synchub?.syncMappingId),
      input.reason ?? null,
      JSON.stringify(input.payload),
      input.receivedAt.toISOString(),
    ]
  );
  return result.rows[0]?.id ?? null;
}

async function upsertProcessedReceipt(input: {
  client: QueryClient;
  payload: SyncHubProjectStageChangedPayload;
  eventKey: string;
  match: TenantMatch;
  receivedAt: Date;
}) {
  const result = await input.client.query(
    `INSERT INTO public.portfolio_project_stage_event_receipts AS receipts
       (event_key, status, office_id, office_slug, procore_company_id,
        procore_portfolio_project_id, project_number, project_name, previous_stage,
        current_stage, current_stage_normalized, is_board_relevant,
        synchub_webhook_log_id, synchub_sync_mapping_id, error_reason,
        raw_payload, received_at, processed_at)
     VALUES
       ($1, 'processed', $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, NULL, $14::jsonb, $15::timestamptz, $15::timestamptz)
     ON CONFLICT (event_key) DO UPDATE SET
       status = 'processed',
       office_id = EXCLUDED.office_id,
       office_slug = EXCLUDED.office_slug,
       procore_company_id = EXCLUDED.procore_company_id,
       procore_portfolio_project_id = EXCLUDED.procore_portfolio_project_id,
       project_number = EXCLUDED.project_number,
       project_name = EXCLUDED.project_name,
       previous_stage = EXCLUDED.previous_stage,
       current_stage = EXCLUDED.current_stage,
       current_stage_normalized = EXCLUDED.current_stage_normalized,
       is_board_relevant = EXCLUDED.is_board_relevant,
       synchub_webhook_log_id = EXCLUDED.synchub_webhook_log_id,
       synchub_sync_mapping_id = EXCLUDED.synchub_sync_mapping_id,
       error_reason = NULL,
       raw_payload = EXCLUDED.raw_payload,
       processed_at = EXCLUDED.processed_at,
       updated_at = NOW()
     WHERE receipts.status = 'unresolved'
     RETURNING id`,
    [
      input.eventKey,
      input.match.officeId,
      input.match.officeSlug,
      input.payload.procore.companyId,
      input.payload.procore.portfolioProjectId,
      input.payload.procore.projectNumber,
      input.payload.procore.projectName,
      input.payload.stage.previous.raw,
      input.payload.stage.current.raw,
      input.payload.stage.current.normalized,
      input.payload.stage.current.isBoardRelevant,
      optionalString(input.payload.synchub?.webhookLogId),
      optionalString(input.payload.synchub?.syncMappingId),
      JSON.stringify(input.payload),
      input.receivedAt.toISOString(),
    ]
  );
  return result.rows[0]?.id ?? null;
}

async function recordResolvedEvent(
  client: QueryClient,
  payload: SyncHubProjectStageChangedPayload,
  match: TenantMatch,
  eventKey: string,
  receivedAt: Date
) {
  const schemaName = quoteIdent(match.schemaName);
  const portfolioProjectsTable = `${schemaName}.portfolio_projects`;
  const timestamps = eventTimestamp(payload, receivedAt);
  const projectNameForInsert = payload.procore.projectName
    ?? payload.procore.projectNumber
    ?? payload.procore.portfolioProjectId;

  await client.query("BEGIN");
  try {
    const receiptId = await upsertProcessedReceipt({
      client,
      payload,
      eventKey,
      match,
      receivedAt,
    });
    if (!receiptId) {
      await client.query("ROLLBACK");
      return { status: "duplicate" as const, eventKey };
    }

    const projectResult = await client.query(
      `INSERT INTO ${portfolioProjectsTable}
         (procore_company_id, procore_project_id, project_number, name,
          current_stage, current_stage_normalized, current_stage_entered_at,
          is_board_relevant, first_seen_at, last_stage_event_key, raw_snapshot,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::timestamptz, $10, $11::jsonb, NOW(), NOW())
       ON CONFLICT (procore_company_id, procore_project_id) DO UPDATE SET
         project_number = COALESCE(EXCLUDED.project_number, ${portfolioProjectsTable}.project_number),
         name = CASE
           WHEN $12::text IS NOT NULL THEN EXCLUDED.name
           WHEN NULLIF(${portfolioProjectsTable}.name, '') IS NULL THEN EXCLUDED.name
           ELSE ${portfolioProjectsTable}.name
         END,
         current_stage = CASE
           WHEN ${portfolioProjectsTable}.current_stage_entered_at IS NULL
             OR EXCLUDED.current_stage_entered_at >= ${portfolioProjectsTable}.current_stage_entered_at
           THEN EXCLUDED.current_stage
           ELSE ${portfolioProjectsTable}.current_stage
         END,
         current_stage_normalized = CASE
           WHEN ${portfolioProjectsTable}.current_stage_entered_at IS NULL
             OR EXCLUDED.current_stage_entered_at >= ${portfolioProjectsTable}.current_stage_entered_at
           THEN EXCLUDED.current_stage_normalized
           ELSE ${portfolioProjectsTable}.current_stage_normalized
         END,
         current_stage_entered_at = GREATEST(
           COALESCE(${portfolioProjectsTable}.current_stage_entered_at, EXCLUDED.current_stage_entered_at),
           EXCLUDED.current_stage_entered_at
         ),
         is_board_relevant = CASE
           WHEN ${portfolioProjectsTable}.current_stage_entered_at IS NULL
             OR EXCLUDED.current_stage_entered_at >= ${portfolioProjectsTable}.current_stage_entered_at
           THEN EXCLUDED.is_board_relevant
           ELSE ${portfolioProjectsTable}.is_board_relevant
         END,
         last_stage_event_key = CASE
           WHEN ${portfolioProjectsTable}.current_stage_entered_at IS NULL
             OR EXCLUDED.current_stage_entered_at >= ${portfolioProjectsTable}.current_stage_entered_at
           THEN EXCLUDED.last_stage_event_key
           ELSE ${portfolioProjectsTable}.last_stage_event_key
         END,
         raw_snapshot = CASE
           WHEN ${portfolioProjectsTable}.current_stage_entered_at IS NULL
             OR EXCLUDED.current_stage_entered_at >= ${portfolioProjectsTable}.current_stage_entered_at
           THEN EXCLUDED.raw_snapshot
           ELSE ${portfolioProjectsTable}.raw_snapshot
         END,
         updated_at = NOW()
       RETURNING id`,
      [
        payload.procore.companyId,
        payload.procore.portfolioProjectId,
        payload.procore.projectNumber,
        projectNameForInsert,
        payload.stage.current.raw,
        payload.stage.current.normalized,
        timestamps.enteredAt,
        payload.stage.current.isBoardRelevant,
        receivedAt.toISOString(),
        eventKey,
        JSON.stringify({
          procore: payload.procore,
          synchub: payload.synchub ?? null,
          stageChange: payload.stageChange,
          rawProcoreWebhook: payload.rawProcoreWebhook ?? null,
        }),
        payload.procore.projectName,
      ]
    );
    const projectId = projectResult.rows[0]?.id;
    const stageEntryResult = await client.query(
      `INSERT INTO ${schemaName}.portfolio_project_stage_entries
         (portfolio_project_id, event_key, previous_stage, previous_stage_normalized,
          stage, stage_normalized, is_board_relevant, entered_at,
          relay_detected_at, webhook_timestamp, raw_event)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [
        projectId,
        eventKey,
        payload.stage.previous.raw,
        payload.stage.previous.normalized,
        payload.stage.current.raw,
        payload.stage.current.normalized,
        payload.stage.current.isBoardRelevant,
        timestamps.enteredAt,
        timestamps.detectedAt,
        timestamps.webhookTimestamp,
        JSON.stringify(payload),
      ]
    );
    await client.query("COMMIT");
    return {
      status: "recorded" as const,
      officeId: match.officeId,
      officeSlug: match.officeSlug,
      projectId,
      stageEntryId: stageEntryResult.rows[0]?.id ?? "",
      isBoardRelevant: payload.stage.current.isBoardRelevant,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function recordUnresolvedEvent(
  client: QueryClient,
  payload: SyncHubProjectStageChangedPayload,
  eventKey: string,
  reason: "no_tenant_match" | "multiple_tenant_matches",
  receivedAt: Date
) {
  await client.query("BEGIN");
  try {
    const receiptId = await insertUnresolvedReceipt({
      client,
      payload,
      eventKey,
      reason,
      receivedAt,
    });
    await client.query("COMMIT");
    return receiptId
      ? { status: "unresolved" as const, reason, eventKey }
      : { status: "duplicate" as const, eventKey };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function processSyncHubProcoreProjectStageChanged(
  input: unknown,
  deps: ServiceDeps = {}
): Promise<SyncHubProjectStageChangedResult> {
  const payload = validateSyncHubProjectStageChangedPayload(input);
  const eventKey = eventKeyForPayload(payload);
  const ownsClient = !deps.client;
  const client = deps.client ?? await pool.connect();
  const receivedAt = deps.receivedAt ?? new Date();

  try {
    const duplicate = await existingReceipt(client, eventKey);
    if (duplicate && duplicate.status !== "unresolved") {
      return { status: "duplicate", eventKey };
    }

    const match = await resolveTenantMatch(client, payload);
    if (match === "no_tenant_match" || match === "multiple_tenant_matches") {
      return await recordUnresolvedEvent(client, payload, eventKey, match, receivedAt);
    }

    return await recordResolvedEvent(client, payload, match, eventKey, receivedAt);
  } finally {
    if (ownsClient) client.release?.();
  }
}

type UnresolvedReceiptRow = {
  id: string;
  event_key: string;
  procore_company_id: string;
  procore_portfolio_project_id: string;
  project_number: string | null;
  raw_payload: unknown;
};

async function unresolvedStageReceipts(client: QueryClient, limit: number): Promise<UnresolvedReceiptRow[]> {
  const result = await client.query(
    `SELECT id, event_key, procore_company_id, procore_portfolio_project_id, project_number, raw_payload
       FROM public.portfolio_project_stage_event_receipts
      WHERE status = 'unresolved'
        AND event_key LIKE 'synchub-stage:%'
      ORDER BY received_at ASC, id ASC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function replayUnresolvedSyncHubProcoreProjectStageReceipts(
  options: ReplayUnresolvedStageReceiptsOptions = {}
): Promise<ReplayUnresolvedStageReceiptsResult> {
  const commit = options.commit === true;
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new AppError(400, "limit must be an integer between 1 and 1000");
  }

  const ownsClient = !options.client;
  const client = options.client ?? await pool.connect();
  const summary: ReplayUnresolvedStageReceiptsResult = {
    mode: commit ? "commit" : "dry-run",
    scanned: 0,
    replayed: 0,
    wouldReplay: 0,
    stillUnresolved: 0,
    duplicates: 0,
    failed: 0,
    results: [],
  };

  try {
    const rows = await unresolvedStageReceipts(client, limit);
    summary.scanned = rows.length;
    for (const row of rows) {
      try {
        const payload = validateSyncHubProjectStageChangedPayload(row.raw_payload);
        if (!commit) {
          const match = await resolveTenantMatch(client, payload);
          if (match === "no_tenant_match" || match === "multiple_tenant_matches") {
            summary.stillUnresolved += 1;
            summary.results.push({
              receiptId: row.id,
              eventKey: row.event_key,
              procoreCompanyId: row.procore_company_id,
              procoreProjectId: row.procore_portfolio_project_id,
              projectNumber: row.project_number,
              outcome: "unresolved",
              reason: match,
            });
          } else {
            summary.wouldReplay += 1;
            summary.results.push({
              receiptId: row.id,
              eventKey: row.event_key,
              procoreCompanyId: row.procore_company_id,
              procoreProjectId: row.procore_portfolio_project_id,
              projectNumber: row.project_number,
              outcome: "would_record",
              officeSlug: match.officeSlug,
            });
          }
          continue;
        }

        const result = await processSyncHubProcoreProjectStageChanged(payload, { client });
        if (result.status === "recorded") {
          summary.replayed += 1;
          summary.results.push({
            receiptId: row.id,
            eventKey: row.event_key,
            procoreCompanyId: row.procore_company_id,
            procoreProjectId: row.procore_portfolio_project_id,
            projectNumber: row.project_number,
            outcome: "recorded",
            officeSlug: result.officeSlug,
          });
        } else if (result.status === "duplicate") {
          summary.duplicates += 1;
          summary.results.push({
            receiptId: row.id,
            eventKey: row.event_key,
            procoreCompanyId: row.procore_company_id,
            procoreProjectId: row.procore_portfolio_project_id,
            projectNumber: row.project_number,
            outcome: "duplicate",
          });
        } else {
          summary.stillUnresolved += 1;
          summary.results.push({
            receiptId: row.id,
            eventKey: row.event_key,
            procoreCompanyId: row.procore_company_id,
            procoreProjectId: row.procore_portfolio_project_id,
            projectNumber: row.project_number,
            outcome: "unresolved",
            reason: result.reason,
          });
        }
      } catch (error) {
        summary.failed += 1;
        summary.results.push({
          receiptId: row.id,
          eventKey: row.event_key,
          procoreCompanyId: row.procore_company_id,
          procoreProjectId: row.procore_portfolio_project_id,
          projectNumber: row.project_number,
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return summary;
  } finally {
    if (ownsClient) client.release?.();
  }
}
