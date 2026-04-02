// server/src/modules/procore/sync-service.ts
// Procore sync operations: create project from won deal, sync stage changes.

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  pipelineStageConfig,
  procoreSyncState,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { procoreClient } from "../../lib/procore-client.js";

type TenantDb = NodePgDatabase<typeof schema>;

const COMPANY_ID = () => {
  const id = process.env.PROCORE_COMPANY_ID;
  if (!id) throw new Error("PROCORE_COMPANY_ID must be set");
  return id;
};

/**
 * Create a Procore project from a won deal.
 * Idempotent: if deals.procore_project_id is already set, returns immediately.
 * Called by deal.won event handler.
 */
export async function createProcoreProject(
  tenantDb: TenantDb,
  dealId: string,
  officeId: string
): Promise<void> {
  // Fetch deal — check idempotency guard first
  const [deal] = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

  if (!deal) {
    console.error(`[Procore:sync] createProcoreProject: deal ${dealId} not found`);
    return;
  }

  // Idempotency: skip if project already created
  if (deal.procoreProjectId != null) {
    console.log(
      `[Procore:sync] Deal ${dealId} already linked to Procore project ${deal.procoreProjectId} — skipping`
    );
    return;
  }

  const companyId = COMPANY_ID();

  // Build Procore project payload from CRM deal fields
  const projectPayload = {
    project: {
      name: deal.name,
      display_name: deal.name,
      address: deal.propertyAddress ?? undefined,
      city: deal.propertyCity ?? undefined,
      state_code: deal.propertyState ?? undefined,
      zip: deal.propertyZip ?? undefined,
      active: true,
    },
  };

  let procoreProject: any;
  try {
    procoreProject = await procoreClient.post(
      `/rest/v1.0/companies/${companyId}/projects`,
      projectPayload
    );
  } catch (err) {
    console.error(`[Procore:sync] Failed to create project for deal ${dealId}:`, err);
    // Upsert sync state as error — does not throw (deal is won regardless)
    await upsertSyncState({
      entityType: "project",
      procoreId: 0,
      crmEntityType: "deal",
      crmEntityId: dealId,
      officeId,
      syncDirection: "crm_to_procore",
      syncStatus: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const procoreProjectId: number = procoreProject.id;

  // Write procore_project_id and procore_last_synced_at back to the deal
  await tenantDb
    .update(deals)
    .set({
      procoreProjectId,
      procoreLastSyncedAt: new Date(),
    })
    .where(eq(deals.id, dealId));

  // Upsert procore_sync_state
  await upsertSyncState({
    entityType: "project",
    procoreId: procoreProjectId,
    crmEntityType: "deal",
    crmEntityId: dealId,
    officeId,
    syncDirection: "crm_to_procore",
    syncStatus: "synced",
    lastSyncedAt: new Date(),
    lastCrmUpdatedAt: new Date(),
    errorMessage: null,
  });

  console.log(
    `[Procore:sync] Created Procore project ${procoreProjectId} for deal ${dealId}`
  );
}

/**
 * Sync a CRM stage change to Procore project status.
 * Reads pipeline_stage_config.procore_stage_mapping.
 * If no mapping exists for the stage, skips the update (logs reason).
 * Called by deal.stage.changed event handler.
 */
export async function syncDealStageToProcore(
  tenantDb: TenantDb,
  dealId: string,
  crmStageId: string,
  officeId: string
): Promise<void> {
  // Fetch deal to get procore_project_id
  const [deal] = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

  if (!deal) {
    console.error(`[Procore:sync] syncDealStageToProcore: deal ${dealId} not found`);
    return;
  }

  if (deal.procoreProjectId == null) {
    // No Procore project linked yet — skip
    return;
  }

  // Fetch stage config from public schema
  const [stageConfig] = await db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.id, crmStageId))
    .limit(1);

  if (!stageConfig?.procoreStageMapping) {
    console.log(
      `[Procore:sync] No Procore stage mapping for CRM stage ${crmStageId} — skipping sync`
    );
    return;
  }

  const companyId = COMPANY_ID();
  const procoreProjectId = deal.procoreProjectId;

  try {
    await procoreClient.patch(
      `/rest/v1.0/companies/${companyId}/projects/${procoreProjectId}`,
      { project: { stage: stageConfig.procoreStageMapping } }
    );
  } catch (err) {
    console.error(
      `[Procore:sync] Failed to update project ${procoreProjectId} stage:`,
      err
    );
    await upsertSyncState({
      entityType: "project",
      procoreId: procoreProjectId,
      crmEntityType: "deal",
      crmEntityId: dealId,
      officeId,
      syncDirection: "crm_to_procore",
      syncStatus: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  await tenantDb
    .update(deals)
    .set({ procoreLastSyncedAt: new Date() })
    .where(eq(deals.id, dealId));

  await upsertSyncState({
    entityType: "project",
    procoreId: procoreProjectId,
    crmEntityType: "deal",
    crmEntityId: dealId,
    officeId,
    syncDirection: "crm_to_procore",
    syncStatus: "synced",
    lastSyncedAt: new Date(),
    lastCrmUpdatedAt: new Date(),
    errorMessage: null,
  });

  console.log(
    `[Procore:sync] Updated Procore project ${procoreProjectId} stage to "${stageConfig.procoreStageMapping}"`
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SyncStateUpsert {
  entityType: "project" | "bid" | "change_order" | "contact";
  procoreId: number;
  crmEntityType: string;
  crmEntityId: string;
  officeId: string;
  syncDirection: "crm_to_procore" | "procore_to_crm" | "bidirectional";
  syncStatus: "synced" | "pending" | "conflict" | "error";
  lastSyncedAt?: Date;
  lastCrmUpdatedAt?: Date;
  lastProcoreUpdatedAt?: Date;
  conflictData?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

export async function upsertSyncState(args: SyncStateUpsert): Promise<void> {
  await db
    .insert(procoreSyncState)
    .values({
      entityType: args.entityType,
      procoreId: args.procoreId,
      crmEntityType: args.crmEntityType,
      crmEntityId: args.crmEntityId,
      officeId: args.officeId,
      syncDirection: args.syncDirection,
      syncStatus: args.syncStatus,
      lastSyncedAt: args.lastSyncedAt ?? null,
      lastCrmUpdatedAt: args.lastCrmUpdatedAt ?? null,
      lastProcoreUpdatedAt: args.lastProcoreUpdatedAt ?? null,
      conflictData: args.conflictData ?? null,
      errorMessage: args.errorMessage ?? null,
    })
    .onConflictDoUpdate({
      target: [
        procoreSyncState.entityType,
        procoreSyncState.procoreId,
        procoreSyncState.officeId,
      ],
      set: {
        syncStatus: args.syncStatus,
        lastSyncedAt: args.lastSyncedAt ?? null,
        lastCrmUpdatedAt: args.lastCrmUpdatedAt ?? null,
        lastProcoreUpdatedAt: args.lastProcoreUpdatedAt ?? null,
        conflictData: args.conflictData ?? null,
        errorMessage: args.errorMessage ?? null,
        updatedAt: new Date(),
      },
    });
}
