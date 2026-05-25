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
  const linkedMatches = await findMatchesByProcoreProjectId(
    client,
    offices,
    procoreProjectId,
    payload.procore.companyId
  );
  if (linkedMatches.length === 1) return linkedMatches[0];
  if (linkedMatches.length > 1) return "multiple_tenant_matches";

  const projectNumberMatches = await findMatchesByProjectNumber(
    client,
    offices,
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
  return "no_tenant_match";
}

async function insertReceipt(input: {
  client: QueryClient;
  payload: SyncHubProjectStageChangedPayload;
  eventKey: string;
  status: "processed" | "unresolved";
  match?: TenantMatch;
  reason?: string;
  receivedAt: Date;
}) {
  const result = await input.client.query(
    `INSERT INTO public.portfolio_project_stage_event_receipts
       (event_key, status, office_id, office_slug, procore_company_id,
        procore_portfolio_project_id, project_number, project_name, previous_stage,
        current_stage, current_stage_normalized, is_board_relevant,
        synchub_webhook_log_id, synchub_sync_mapping_id, error_reason,
        raw_payload, received_at, processed_at)
     VALUES
       ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16::jsonb, $17::timestamptz, $18::timestamptz)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [
      input.eventKey,
      input.status,
      input.match?.officeId ?? null,
      input.match?.officeSlug ?? null,
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
      input.status === "processed" ? input.receivedAt.toISOString() : null,
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
    const receiptId = await insertReceipt({
      client,
      payload,
      eventKey,
      status: "unresolved",
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
