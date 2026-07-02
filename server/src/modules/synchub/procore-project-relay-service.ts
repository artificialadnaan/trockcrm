import { pool, releasePooledClient } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { upsertProjectMirror } from "../projects/service.js";
import { buildAuditActorFromSystem } from "../audit/audit-logger.js";
import { logActivityWithPgClient } from "../audit/pg-activity-logger.js";
import { PROCORE_PROJECT_RELAY } from "../audit/system-processes.js";

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  release?: () => void;
};

export type SyncHubProjectCreatedPayload = {
  eventType: "procore.project.created";
  source?: string;
  procore: {
    companyId: string;
    portfolioProjectId: string;
    projectNumber: string;
    projectName?: string | null;
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

type OfficeRow = { id: string; slug: string };
type DealMatch = {
  officeId: string;
  officeSlug: string;
  schemaName: string;
  dealId: string;
  dealNumber: string;
  dealName?: string | null;
  procoreProjectId: number | null;
};

export type SyncHubRelayResult =
  | { status: "linked"; dealId: string; officeId: string; jobId: number | null }
  | { status: "already_linked"; dealId: string; officeId: string }
  | { status: "orphaned"; orphanId: string; reason: "no_match" }
  | { status: "ambiguous"; orphanId: string; reason: "multiple_matches" | "matched_deal_has_different_procore_project" }
  | { status: "orphaned"; orphanId: string; reason: "duplicate_orphan" };

type ServiceDeps = {
  client?: QueryClient;
};

const OFFICE_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

function quoteIdent(identifier: string): string {
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

function optionalTraceId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function relaySnapshot(payload: SyncHubProjectCreatedPayload): Record<string, unknown> {
  return {
    id: payload.procore.portfolioProjectId,
    company_id: payload.procore.companyId,
    project_number: payload.procore.projectNumber,
    name: payload.procore.projectName ?? payload.procore.projectNumber,
  };
}

async function upsertProjectMirrorForDeal(
  client: QueryClient,
  payload: SyncHubProjectCreatedPayload,
  match: DealMatch,
  procoreProjectId: number
) {
  await upsertProjectMirror(client as any, match.schemaName, {
    procoreProjectId: String(procoreProjectId),
    procoreCompanyId: payload.procore.companyId,
    procoreProjectNumber: payload.procore.projectNumber,
    name: payload.procore.projectName ?? payload.procore.projectNumber,
    sourceDealId: match.dealId,
    syncSource: "webhook",
    snapshot: relaySnapshot(payload),
    rawEvent: payload.rawProcoreWebhook ?? payload,
  });
}

function parseSafeProcoreId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(400, "procore.portfolioProjectId must be a safe positive integer");
  }
  return parsed;
}

export function validateSyncHubProjectCreatedPayload(input: unknown): SyncHubProjectCreatedPayload {
  const payload = asObject(input);
  const eventType = payload.eventType;
  if (eventType !== "procore.project.created") {
    throw new AppError(400, "unsupported event type");
  }

  const procore = asObject(payload.procore);
  const portfolioProjectId = requiredString(
    procore.portfolioProjectId,
    "procore.portfolioProjectId is required"
  );
  const projectNumber = requiredString(procore.projectNumber, "procore.projectNumber is required");
  const companyId = requiredString(procore.companyId, "procore.companyId is required");

  return {
    eventType,
    source: typeof payload.source === "string" ? payload.source : undefined,
    procore: {
      companyId,
      portfolioProjectId,
      projectNumber,
      projectName: typeof procore.projectName === "string" ? procore.projectName : null,
    },
    synchub: payload.synchub && typeof payload.synchub === "object"
      ? payload.synchub as SyncHubProjectCreatedPayload["synchub"]
      : undefined,
    rawProcoreWebhook: payload.rawProcoreWebhook,
  };
}

export async function getActiveOffices(client: QueryClient): Promise<OfficeRow[]> {
  const result = await client.query(
    "SELECT id, slug FROM public.offices WHERE is_active = true ORDER BY created_at ASC"
  );
  return result.rows.filter((row) => typeof row.slug === "string" && schemaNameForOffice(row.slug));
}

async function findDealLinkedToProcoreProject(
  client: QueryClient,
  offices: OfficeRow[],
  procoreProjectId: number
): Promise<DealMatch | null> {
  for (const office of offices) {
    const schemaName = schemaNameForOffice(office.slug);
    if (!schemaName) continue;
    const result = await client.query(
      `SELECT $2::uuid AS office_id,
              $3::text AS office_slug,
              $4::text AS schema_name,
              id AS deal_id,
              name AS deal_name,
              deal_number,
              procore_project_id
       FROM ${quoteIdent(schemaName)}.deals
       WHERE procore_project_id = $1 AND is_active = true
       LIMIT 1`,
      [procoreProjectId, office.id, office.slug, schemaName]
    );
    if (result.rows[0]) return mapDealMatch(result.rows[0]);
  }
  return null;
}

export async function findDealsByProjectNumber(
  client: QueryClient,
  offices: OfficeRow[],
  projectNumber: string
): Promise<DealMatch[]> {
  const matches: DealMatch[] = [];
  for (const office of offices) {
    const schemaName = schemaNameForOffice(office.slug);
    if (!schemaName) continue;
    const result = await client.query(
      // Match the incoming Procore project number against BOTH project_number and deal_number.
      // SyncHub creates the Procore project from the deal's canonical DFW/ATL number, which for
      // HubSpot-imported and bid-board deals lives in project_number (deal_number holds the HS id
      // or a divergent number). A deal_number-only lookup orphaned those relays, so the worker
      // never created the "T Rock Photos" link. Mirrors the stage relay's findMatchesByProjectNumber.
      //
      // CO child deals SHARE the parent's project_number (migration 0156; the project_number unique
      // index is partial on is_change_order = false), so exclude them — otherwise a parent-with-CO
      // would return >1 row and orphan as false-ambiguous instead of linking the real parent. This
      // guard also aligns the predicate with deals_project_number_uidx so the lookup stays indexed.
      // LIMIT 2 still lets the caller detect GENUINE ambiguity (>1 distinct parent → orphan).
      `SELECT $2::uuid AS office_id,
              $3::text AS office_slug,
              $4::text AS schema_name,
              id AS deal_id,
              name AS deal_name,
              deal_number,
              procore_project_id
       FROM ${quoteIdent(schemaName)}.deals
       WHERE (project_number = $1 OR deal_number = $1)
         AND is_active = true
         AND COALESCE(is_change_order, false) = false
       LIMIT 2`,
      [projectNumber, office.id, office.slug, schemaName]
    );
    matches.push(...result.rows.map(mapDealMatch));
  }
  return matches;
}

function mapDealMatch(row: any): DealMatch {
  return {
    officeId: row.office_id,
    officeSlug: row.office_slug,
    schemaName: row.schema_name,
    dealId: row.deal_id,
    dealNumber: row.deal_number,
    dealName: row.deal_name ?? null,
    procoreProjectId: row.procore_project_id == null ? null : Number(row.procore_project_id),
  };
}

async function findExistingOrphanBySyncHubLogId(
  client: QueryClient,
  payload: SyncHubProjectCreatedPayload
): Promise<string | null> {
  const webhookLogId = optionalTraceId(payload.synchub?.webhookLogId);
  if (!webhookLogId) return null;
  const result = await client.query(
    `SELECT id
     FROM public.synchub_webhook_orphans
     WHERE synchub_webhook_log_id = $1
       AND procore_portfolio_project_id = $2
       AND status = 'open'
     LIMIT 1`,
    [webhookLogId, payload.procore.portfolioProjectId]
  );
  return result.rows[0]?.id ?? null;
}

async function insertOrphan(
  client: QueryClient,
  payload: SyncHubProjectCreatedPayload,
  notes: string,
  tenantId: string | null = null
): Promise<string> {
  const result = await client.query(
    `INSERT INTO public.synchub_webhook_orphans
       (tenant_id, synchub_webhook_log_id, synchub_sync_mapping_id,
        procore_company_id, procore_portfolio_project_id, project_number,
        project_name, raw_payload, status, notes, received_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, 'open', $9, NOW())
     RETURNING id`,
    [
      tenantId,
      optionalTraceId(payload.synchub?.webhookLogId),
      optionalTraceId(payload.synchub?.syncMappingId),
      payload.procore.companyId,
      payload.procore.portfolioProjectId,
      payload.procore.projectNumber,
      payload.procore.projectName ?? null,
      JSON.stringify(payload),
      notes,
    ]
  );
  return result.rows[0]?.id;
}

async function linkMatchedDeal(
  client: QueryClient,
  payload: SyncHubProjectCreatedPayload,
  match: DealMatch,
  procoreProjectId: number
): Promise<SyncHubRelayResult> {
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('synchub_procore_project_' || $1))",
      [match.dealId]
    );
    const lockedResult = await client.query(
      `SELECT id, name, deal_number, project_number, procore_project_id
       FROM ${quoteIdent(match.schemaName)}.deals
       WHERE id = $1 AND is_active = true
       LIMIT 1
       FOR UPDATE`,
      [match.dealId]
    );
    const lockedDeal = lockedResult.rows[0];
    if (!lockedDeal) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      const orphanId = await insertOrphan(client, payload, "Matched deal disappeared before linkage", match.officeId);
      return { status: "orphaned", orphanId, reason: "no_match" };
    }

    const currentProcoreId = lockedDeal.procore_project_id == null
      ? null
      : Number(lockedDeal.procore_project_id);
    if (currentProcoreId === procoreProjectId) {
      await upsertProjectMirrorForDeal(client, payload, match, procoreProjectId);
      await client.query("COMMIT");
      transactionOpen = false;
      return { status: "already_linked", dealId: match.dealId, officeId: match.officeId };
    }

    if (currentProcoreId != null && currentProcoreId !== procoreProjectId) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      const orphanId = await insertOrphan(
        client,
        payload,
        `Matched deal ${match.dealId} is already linked to Procore project ${currentProcoreId}`,
        match.officeId
      );
      return {
        status: "ambiguous",
        orphanId,
        reason: "matched_deal_has_different_procore_project",
      };
    }

    await client.query(
      `UPDATE ${quoteIdent(match.schemaName)}.deals
       SET procore_project_id = $1, procore_last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [procoreProjectId, match.dealId]
    );
    await logActivityWithPgClient({
      client,
      schemaName: match.schemaName,
      actor: buildAuditActorFromSystem({ systemProcess: PROCORE_PROJECT_RELAY }),
      action: "update",
      entity: {
        tableName: "deals",
        entityType: "deal",
        recordId: match.dealId,
        nameSnapshot: lockedDeal.name ?? match.dealName ?? payload.procore.projectName ?? match.dealNumber,
        secondaryIdSnapshot: lockedDeal.project_number ?? lockedDeal.deal_number ?? match.dealNumber,
      },
      fieldChanges: {
        procoreProjectId: { from: currentProcoreId, to: procoreProjectId },
        procoreLastSyncedAt: { from: null, to: "now" },
      },
      metadata: {
        synchubWebhookLogId: optionalTraceId(payload.synchub?.webhookLogId),
        procoreProjectNumber: payload.procore.projectNumber,
      },
    });
    await client.query(
      `INSERT INTO public.procore_sync_state
         (id, entity_type, procore_id, crm_entity_type, crm_entity_id, office_id,
          sync_direction, sync_status, last_synced_at, last_procore_updated_at,
          last_crm_updated_at, created_at, updated_at)
       VALUES (gen_random_uuid(), 'project', $1, 'deal', $2, $3,
               'procore_to_crm', 'synced', NOW(), NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (entity_type, procore_id, office_id) DO UPDATE SET
         crm_entity_id = EXCLUDED.crm_entity_id,
         sync_status = 'synced',
         last_synced_at = NOW(),
         last_procore_updated_at = NOW(),
         error_message = NULL,
         updated_at = NOW()`,
      [procoreProjectId, match.dealId, match.officeId]
    );
    const jobResult = await client.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
       VALUES ('procore_sync', $1::jsonb, $2::uuid, 'pending', NOW())
       RETURNING id`,
      [
        JSON.stringify({
          action: "create_project",
          dealId: match.dealId,
          officeId: match.officeId,
          procoreProjectId,
          projectAlreadyExists: true,
          source: "synchub_relay",
          synchubWebhookLogId: optionalTraceId(payload.synchub?.webhookLogId),
          synchubSyncMappingId: optionalTraceId(payload.synchub?.syncMappingId),
        }),
        match.officeId,
      ]
    );
    await upsertProjectMirrorForDeal(client, payload, match, procoreProjectId);
    await client.query("COMMIT");
    transactionOpen = false;

    return {
      status: "linked",
      dealId: match.dealId,
      officeId: match.officeId,
      jobId: jobResult.rows[0]?.id ?? null,
    };
  } catch (error) {
    let rollbackErr: unknown;
    if (transactionOpen) {
      await client.query("ROLLBACK").catch((e) => { rollbackErr = e; });
    }
    // Prefer a failed ROLLBACK (a dead socket) over the original error so the outer
    // processSyncHubProcoreProjectCreated catch → releasePooledClient sees the broken connection and
    // destroys the owned client instead of recycling it.
    throw rollbackErr ?? error;
  }
}

export async function processSyncHubProcoreProjectCreated(
  input: unknown,
  deps: ServiceDeps = {}
): Promise<SyncHubRelayResult> {
  const payload = validateSyncHubProjectCreatedPayload(input);
  const procoreProjectId = parseSafeProcoreId(payload.procore.portfolioProjectId);
  const ownsClient = !deps.client;
  const client = deps.client ?? await pool.connect();
  let releaseErr: unknown;

  try {
    const offices = await getActiveOffices(client);
    const duplicate = await findDealLinkedToProcoreProject(client, offices, procoreProjectId);
    if (duplicate) {
      console.info(
        `[SyncHub:relay] Duplicate project relay ${payload.procore.portfolioProjectId} already linked to deal ${duplicate.dealId}`
      );
      await linkMatchedDeal(client, payload, duplicate, procoreProjectId);
      return {
        status: "already_linked",
        dealId: duplicate.dealId,
        officeId: duplicate.officeId,
      };
    }

    const existingOrphanId = await findExistingOrphanBySyncHubLogId(client, payload);
    if (existingOrphanId) {
      return { status: "orphaned", orphanId: existingOrphanId, reason: "duplicate_orphan" };
    }

    const matches = await findDealsByProjectNumber(client, offices, payload.procore.projectNumber);
    if (matches.length === 0) {
      const orphanId = await insertOrphan(client, payload, "No CRM deal matched project number");
      console.warn(
        `[SyncHub:relay] Orphaned Procore project ${payload.procore.portfolioProjectId}: no deal for ${payload.procore.projectNumber}`
      );
      return { status: "orphaned", orphanId, reason: "no_match" };
    }

    if (matches.length > 1) {
      const orphanId = await insertOrphan(
        client,
        payload,
        `Ambiguous project number matched ${matches.length} CRM deals`
      );
      console.warn(
        `[SyncHub:relay] Ambiguous Procore project ${payload.procore.portfolioProjectId}: ${payload.procore.projectNumber}`
      );
      return { status: "ambiguous", orphanId, reason: "multiple_matches" };
    }

    const result = await linkMatchedDeal(client, payload, matches[0], procoreProjectId);
    console.info(
      `[SyncHub:relay] Project ${payload.procore.portfolioProjectId} (${payload.procore.projectNumber}) result=${result.status}`
    );
    return result;
  } catch (err) {
    releaseErr = err;
    throw err;
  } finally {
    if (ownsClient) releasePooledClient(client as import("pg").PoolClient, releaseErr);
  }
}
