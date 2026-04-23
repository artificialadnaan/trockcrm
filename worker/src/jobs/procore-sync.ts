// worker/src/jobs/procore-sync.ts
// Handles procore_sync and procore_webhook job types from job_queue.
// Also exports runProcoreSync() for 15-minute periodic poll.

import { pool } from "../db.js";

const SERVER_PROCORE_SYNC_MODULES = [
  "../../../server/dist/modules/procore/sync-service.js",
  "../../../server/src/modules/procore/sync-service.js",
] as const;

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;

  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to import Procore sync module");
}

const PROCORE_BASE_URL = "https://api.procore.com";

// Dev mode: when PROCORE_CLIENT_ID is not set, skip all Procore API calls
function isDevMode(): boolean {
  return !process.env.PROCORE_CLIENT_ID || !process.env.PROCORE_CLIENT_SECRET;
}

// Inline token cache for worker (mirrors server/src/lib/procore-client.ts but
// without the circuit breaker — worker failures are surfaced via job_queue status)
let workerCachedToken: { value: string; expiresAt: number } | null = null;

async function getWorkerProcoreToken(): Promise<string> {
  if (isDevMode()) return "dev-mock-token";

  if (workerCachedToken && workerCachedToken.expiresAt - Date.now() > 60_000) {
    return workerCachedToken.value;
  }
  const clientId = process.env.PROCORE_CLIENT_ID!;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET!;
  const res = await fetch(`${PROCORE_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`[Procore:worker] Token fetch failed: ${res.status}`);
  const data = await res.json();
  workerCachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return workerCachedToken.value;
}

async function procoreWorkerFetch<T = any>(path: string): Promise<T> {
  if (isDevMode()) {
    console.log(`[Procore:worker:dev] Mock GET ${path}`);
    if (path.includes("/change_orders")) return [] as any;
    return { id: 1, name: "Mock Project", stage: "Active", updated_at: new Date().toISOString() } as any;
  }

  const token = await getWorkerProcoreToken();
  const res = await fetch(`${PROCORE_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`[Procore:worker] GET ${path} failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Handle a procore_sync job dispatched from the API server's event handlers.
 * action = "create_project" | "sync_stage"
 */
export async function handleProcoreSyncJob(jobPayload: any): Promise<void> {
  const { action, dealId, officeId, crmStageId } = jobPayload;

  // Resolve office slug
  const client = await pool.connect();
  try {
    const officeResult = await client.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
      [officeId]
    );
    if (officeResult.rows.length === 0) {
      console.warn(`[Procore:worker] Office ${officeId} not found — skipping job`);
      return;
    }
    const officeSlug: string = officeResult.rows[0].slug;
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(officeSlug)) {
      console.error(`[Procore:worker] Invalid office slug: "${officeSlug}" — skipping`);
      return;
    }
    const schemaName = `office_${officeSlug}`;
    const companyId = process.env.PROCORE_COMPANY_ID;
    if (!companyId) throw new Error("PROCORE_COMPANY_ID must be set");

    if (action === "create_project") {
      await handleCreateProject(client, schemaName, officeId, companyId, dealId);
    } else if (action === "sync_stage") {
      await handleSyncStage(client, schemaName, officeId, companyId, dealId, crmStageId);
    } else {
      console.warn(`[Procore:worker] Unknown procore_sync action: ${action}`);
    }
  } finally {
    client.release();
  }
}

async function handleCreateProject(
  client: any,
  schemaName: string,
  officeId: string,
  companyId: string,
  dealId: string
): Promise<void> {
  let transactionOpen = false;
  try {
    // Take a per-deal advisory lock to prevent concurrent project creation
    // for the same deal (e.g. duplicate job_queue entries or webhook replays).
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('procore_project_' || $1))`,
      [dealId]
    );

    const dealResult = await client.query(
      `SELECT id, name, procore_project_id, property_address, property_city,
              property_state, property_zip
       FROM ${schemaName}.deals WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [dealId]
    );
    const deal = dealResult.rows[0];
    if (!deal) {
      console.warn(`[Procore:worker] handleCreateProject: deal ${dealId} not found`);
      await client.query("COMMIT");
      transactionOpen = false;
      return;
    }
    // Re-check after acquiring lock — another worker may have created the project
    if (deal.procore_project_id != null) {
      console.log(
        `[Procore:worker] Deal ${dealId} already has procore_project_id ${deal.procore_project_id} — skip`
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return;
    }

    let procoreProjectId: number;

    if (isDevMode()) {
      procoreProjectId = Math.floor(Math.random() * 900000) + 100000;
      console.log(`[Procore:worker:dev] Mock created project ${procoreProjectId} for deal ${dealId}`);
    } else {
      const token = await getWorkerProcoreToken();
      const res = await fetch(`${PROCORE_BASE_URL}/rest/v1.0/companies/${companyId}/projects`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project: {
            name: deal.name,
            display_name: deal.name,
            address: deal.property_address ?? undefined,
            city: deal.property_city ?? undefined,
            state_code: deal.property_state ?? undefined,
            zip: deal.property_zip ?? undefined,
            active: true,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Procore project creation failed: ${res.status} ${errText}`);
      }

      const project = await res.json();
      procoreProjectId = project.id;
    }

    await client.query(
      `UPDATE ${schemaName}.deals
       SET procore_project_id = $1, procore_last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [procoreProjectId, dealId]
    );
    await client.query(
      `INSERT INTO public.procore_sync_state
         (id, entity_type, procore_id, crm_entity_type, crm_entity_id, office_id,
          sync_direction, sync_status, last_synced_at, last_crm_updated_at, created_at, updated_at)
       VALUES (gen_random_uuid(), 'project', $1, 'deal', $2, $3,
               'crm_to_procore', 'synced', NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (entity_type, procore_id, office_id) DO UPDATE SET
         sync_status = 'synced', last_synced_at = NOW(), error_message = NULL, updated_at = NOW()`,
      [procoreProjectId, dealId, officeId]
    );
    await client.query("COMMIT");
    transactionOpen = false;
    console.log(
      `[Procore:worker] Created project ${procoreProjectId} for deal ${dealId}`
    );
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  }
}

async function handleSyncStage(
  client: any,
  schemaName: string,
  officeId: string,
  companyId: string,
  dealId: string,
  crmStageId: string
): Promise<void> {
  const dealResult = await client.query(
    `SELECT id, procore_project_id FROM ${schemaName}.deals WHERE id = $1 LIMIT 1`,
    [dealId]
  );
  const deal = dealResult.rows[0];
  if (!deal || deal.procore_project_id == null) return;

  const stageResult = await client.query(
    "SELECT procore_stage_mapping FROM public.pipeline_stage_config WHERE id = $1 LIMIT 1",
    [crmStageId]
  );
  const mapping: string | null = stageResult.rows[0]?.procore_stage_mapping ?? null;
  if (!mapping) {
    console.log(
      `[Procore:worker] No stage mapping for ${crmStageId} — skipping Procore update`
    );
    return;
  }

  if (!isDevMode()) {
    const token = await getWorkerProcoreToken();
    const res = await fetch(
      `${PROCORE_BASE_URL}/rest/v1.0/companies/${companyId}/projects/${deal.procore_project_id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: { stage: mapping } }),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Procore stage update failed: ${res.status} ${errText}`);
    }
  } else {
    console.log(`[Procore:worker:dev] Mock stage sync to "${mapping}" for project ${deal.procore_project_id}`);
  }

  await client.query(
    `UPDATE ${schemaName}.deals
     SET procore_last_synced_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [dealId]
  );
  await client.query(
    `INSERT INTO public.procore_sync_state
       (id, entity_type, procore_id, crm_entity_type, crm_entity_id, office_id,
        sync_direction, sync_status, last_synced_at, last_crm_updated_at, created_at, updated_at)
     VALUES (gen_random_uuid(), 'project', $1, 'deal', $2, $3,
             'crm_to_procore', 'synced', NOW(), NOW(), NOW(), NOW())
     ON CONFLICT (entity_type, procore_id, office_id) DO UPDATE SET
       sync_status = 'synced', last_synced_at = NOW(), last_crm_updated_at = NOW(),
       error_message = NULL, updated_at = NOW()`,
    [deal.procore_project_id, dealId, officeId]
  );
  console.log(
    `[Procore:worker] Synced stage "${mapping}" to Procore project ${deal.procore_project_id}`
  );
}

/**
 * Handle a procore_webhook job — processes a stored procore_webhook_log entry.
 */
export async function handleProcoreWebhookJob(jobPayload: any): Promise<void> {
  const { webhookLogId, eventType, payload } = jobPayload;
  const client = await pool.connect();
  try {
    const companyId = process.env.PROCORE_COMPANY_ID;
    if (!companyId) throw new Error("PROCORE_COMPANY_ID must be set");

    const procoreProjectId: number =
      payload?.project?.id ?? payload?.change_order?.project_id ?? null;

    if (procoreProjectId == null) {
      console.warn(
        `[Procore:webhook-job] Cannot determine project ID from webhook payload — skipping`
      );
      await markWebhookProcessed(client, webhookLogId, null);
      return;
    }

    // Resolve which office owns this project
    const officeResult = await client.query(
      `SELECT o.id AS office_id, o.slug
       FROM public.offices o
       JOIN public.procore_sync_state pss ON pss.office_id = o.id
       WHERE pss.entity_type = 'project' AND pss.procore_id = $1
       LIMIT 1`,
      [procoreProjectId]
    );

    if (officeResult.rows.length === 0) {
      console.warn(
        `[Procore:webhook-job] No CRM office linked to Procore project ${procoreProjectId}`
      );
      await markWebhookProcessed(client, webhookLogId, null);
      return;
    }

    const officeId: string = officeResult.rows[0].office_id;
    const officeSlug: string = officeResult.rows[0].slug;
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(officeSlug)) {
      console.error(`[Procore:worker] Invalid office slug: "${officeSlug}" — skipping`);
      await markWebhookProcessed(client, webhookLogId, `Invalid office slug: ${officeSlug}`);
      return;
    }
    const schemaName = `office_${officeSlug}`;

    await client.query("BEGIN");

    if (eventType === "project.update") {
      await syncProjectStatusToCrm(
        client,
        schemaName,
        officeId,
        procoreProjectId,
        payload
      );
    } else if (
      eventType === "change_order.create" ||
      eventType === "change_order.update"
    ) {
      const co = payload.change_order ?? payload;
      await syncChangeOrderToCrm(
        client,
        schemaName,
        officeId,
        procoreProjectId,
        co
      );
    }

    await markWebhookProcessed(client, webhookLogId, null);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const errMsg = err instanceof Error ? err.message : String(err);
    await markWebhookProcessed(client, webhookLogId, errMsg);
    throw err;
  } finally {
    client.release();
  }
}

async function syncProjectStatusToCrm(
  client: any,
  schemaName: string,
  officeId: string,
  procoreProjectId: number,
  payload: any
): Promise<void> {
  const dealResult = await client.query(
    `SELECT id, stage_id, stage_entered_at, updated_at
     FROM ${schemaName}.deals WHERE procore_project_id = $1 LIMIT 1`,
    [procoreProjectId]
  );
  if (dealResult.rows.length === 0) return;
  const dealId: string = dealResult.rows[0].id;
  const currentStageId: string = dealResult.rows[0].stage_id;
  const stageEnteredAt: Date | null = dealResult.rows[0].stage_entered_at;
  const crmUpdatedAt: Date = dealResult.rows[0].updated_at;

  // Conflict detection
  const syncStateResult = await client.query(
    `SELECT last_synced_at, last_crm_updated_at, last_procore_updated_at
     FROM public.procore_sync_state
     WHERE entity_type = 'project' AND procore_id = $1 AND office_id = $2 LIMIT 1`,
    [procoreProjectId, officeId]
  );
  const syncState = syncStateResult.rows[0];

  if (syncState) {
    const lastSynced: Date | null = syncState.last_synced_at;
    const lastCrmUpdate: Date = syncState.last_crm_updated_at ?? crmUpdatedAt;
    const procoreUpdatedAt = new Date(payload.updated_at ?? Date.now());

    if (
      lastSynced &&
      procoreUpdatedAt > lastSynced &&
      lastCrmUpdate > lastSynced
    ) {
      // Both sides changed since last sync — conflict
      await client.query(
        `UPDATE public.procore_sync_state
         SET sync_status = 'conflict',
             conflict_data = $1::jsonb,
             last_procore_updated_at = $2,
             updated_at = NOW()
         WHERE entity_type = 'project' AND procore_id = $3 AND office_id = $4`,
        [
          JSON.stringify({
            procore_status: payload.stage ?? payload.status,
            crm_deal_id: dealId,
            detected_at: new Date().toISOString(),
          }),
          procoreUpdatedAt,
          procoreProjectId,
          officeId,
        ]
      );
      console.warn(
        `[Procore:sync] Conflict detected for project ${procoreProjectId} / deal ${dealId}`
      );
      return; // Do not overwrite — admin resolves manually
    }
  }

  // --- Reverse stage sync: apply Procore stage back to CRM deal ---
  const procoreStage: string | undefined =
    payload.stage ?? payload.status ?? undefined;

  if (procoreStage) {
    const procoreStageKey = procoreStage.toLowerCase().trim();

    // Build reverse map: Procore stage name → CRM stage
    const reverseMapResult = await client.query(
      `SELECT id, name, display_order, procore_stage_mapping
       FROM public.pipeline_stage_config
       WHERE procore_stage_mapping IS NOT NULL`
    );

    const reverseMap = new Map<
      string,
      { stageId: string; stageName: string; displayOrder: number; ambiguous: boolean }
    >();

    for (const row of reverseMapResult.rows) {
      const mappingKey = (row.procore_stage_mapping as string).toLowerCase().trim();
      if (!mappingKey) continue;

      const existing = reverseMap.get(mappingKey);
      if (existing) {
        existing.ambiguous = true;
        console.warn(
          `[Procore:sync] Ambiguous reverse mapping: Procore stage "${mappingKey}" maps to ` +
            `both "${existing.stageName}" and "${row.name}"`
        );
      } else {
        reverseMap.set(mappingKey, {
          stageId: row.id,
          stageName: row.name,
          displayOrder: row.display_order,
          ambiguous: false,
        });
      }
    }

    const mapped = reverseMap.get(procoreStageKey);

    if (mapped && mapped.ambiguous) {
      console.warn(
        `[Procore:sync] Skipping stage update for project ${procoreProjectId}: ` +
          `Procore stage "${procoreStage}" maps to multiple CRM stages (ambiguous)`
      );
    } else if (mapped && mapped.stageId !== currentStageId) {
      // Stage differs — apply the change
      const targetStageId = mapped.stageId;

      // Determine forward/backward move by comparing display_order
      const currentOrderResult = await client.query(
        `SELECT display_order FROM public.pipeline_stage_config WHERE id = $1 LIMIT 1`,
        [currentStageId]
      );
      const currentOrder: number = currentOrderResult.rows[0]?.display_order ?? 0;
      const isBackwardMove = mapped.displayOrder < currentOrder;

      if (isBackwardMove) {
        console.warn(
          `[Procore:sync] Backward stage move for deal ${dealId}: ` +
            `current order ${currentOrder} -> target order ${mapped.displayOrder}. ` +
            `Allowing — Procore is system of record.`
        );
      }

      // Resolve a system user for changed_by (FK requires a real user UUID)
      const systemUserResult = await client.query(
        `SELECT id FROM public.users
         WHERE office_id = $1 AND is_active = true AND role IN ('admin', 'director')
         ORDER BY created_at ASC LIMIT 1`,
        [officeId]
      );
      const changedByUserId: string | null = systemUserResult.rows[0]?.id ?? null;

      if (!changedByUserId) {
        console.error(
          `[Procore:sync] No admin/director user found for office ${officeId} — ` +
            `cannot record stage history for deal ${dealId}`
        );
      } else {
        // Insert deal_stage_history audit record
        if (stageEnteredAt) {
          await client.query(
            `INSERT INTO ${schemaName}.deal_stage_history
             (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move,
              is_director_override, override_reason, duration_in_previous_stage)
             VALUES ($1, $2, $3, $4, $5, false, $6, (NOW() - $7::timestamptz))`,
            [
              dealId,
              currentStageId,
              targetStageId,
              changedByUserId,
              isBackwardMove,
              "Procore reverse sync",
              stageEnteredAt,
            ]
          );
        } else {
          await client.query(
            `INSERT INTO ${schemaName}.deal_stage_history
             (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move,
              is_director_override, override_reason)
             VALUES ($1, $2, $3, $4, $5, false, $6)`,
            [
              dealId,
              currentStageId,
              targetStageId,
              changedByUserId,
              isBackwardMove,
              "Procore reverse sync",
            ]
          );
        }
      }

      // Update deal stage and stage_entered_at
      await client.query(
        `UPDATE ${schemaName}.deals
         SET stage_id = $1,
             stage_entered_at = NOW(),
             procore_last_synced_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [targetStageId, dealId]
      );

      // Emit domain event via job_queue (outbox pattern)
      await client.query(
        `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
         VALUES ('domain_event', $1::jsonb, $2::uuid, 'pending', NOW())`,
        [
          JSON.stringify({
            eventName: "deal.stage.changed",
            dealId,
            fromStageId: currentStageId,
            toStageId: targetStageId,
            isBackwardMove,
            changedBy: "procore_sync",
            officeId,
          }),
          officeId,
        ]
      );

      console.log(
        `[Procore:sync] Reverse stage sync: deal ${dealId} moved from ` +
          `"${currentStageId}" to "${mapped.stageName}" (${targetStageId}) via Procore project ${procoreProjectId}`
      );
    } else if (!mapped) {
      console.log(
        `[Procore:sync] No reverse mapping for Procore stage "${procoreStage}" — ` +
          `skipping stage update for deal ${dealId}`
      );
    }
    // If mapped.stageId === currentStageId, stages already match — no action needed
  }

  // Always update procore_last_synced_at and sync state (even if no stage change)
  await client.query(
    `UPDATE ${schemaName}.deals
     SET procore_last_synced_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [dealId]
  );
  await client.query(
    `INSERT INTO public.procore_sync_state
       (id, entity_type, procore_id, crm_entity_type, crm_entity_id, office_id,
        sync_direction, sync_status, last_synced_at, last_procore_updated_at, created_at, updated_at)
     VALUES (gen_random_uuid(), 'project', $1, 'deal', $2, $3,
             'procore_to_crm', 'synced', NOW(), $4, NOW(), NOW())
     ON CONFLICT (entity_type, procore_id, office_id) DO UPDATE SET
       sync_status = 'synced', last_synced_at = NOW(), last_procore_updated_at = $4,
       conflict_data = NULL, error_message = NULL, updated_at = NOW()`,
    [procoreProjectId, dealId, officeId, new Date(payload.updated_at ?? Date.now())]
  );
}

/**
 * Sync a single change order from Procore into the CRM.
 */
async function syncChangeOrderToCrm(
  client: any,
  schemaName: string,
  officeId: string,
  procoreProjectId: number,
  procoreCo: any
): Promise<void> {
  // Find the deal linked to this Procore project
  const dealResult = await client.query(
    `SELECT id, deal_number, assigned_rep_id, change_order_total
     FROM ${schemaName}.deals WHERE procore_project_id = $1 LIMIT 1`,
    [procoreProjectId]
  );
  if (dealResult.rows.length === 0) {
    console.warn(
      `[Procore:sync] No CRM deal found for Procore project ${procoreProjectId} — skipping CO sync`
    );
    return;
  }
  const dealId: string = dealResult.rows[0].id;
  const dealNumber: string = dealResult.rows[0].deal_number ?? String(procoreProjectId);
  const assignedRepId: string = dealResult.rows[0].assigned_rep_id;
  const oldTotal: number = parseFloat(String(dealResult.rows[0].change_order_total ?? "0")) || 0;

  const procoreCoId: number = procoreCo.id;
  const coNumber: number = procoreCo.number ?? 0;
  const title: string = (procoreCo.title ?? "Change Order").substring(0, 500);
  const amount: number = parseFloat(String(procoreCo.grand_total ?? procoreCo.amount ?? "0")) || 0;

  // Map Procore CO status to CRM enum: approved/rejected/pending
  const procoreStatus: string = (procoreCo.status ?? "").toLowerCase();
  let crmStatus: "approved" | "rejected" | "pending" = "pending";
  if (procoreStatus === "approved") crmStatus = "approved";
  else if (procoreStatus === "rejected" || procoreStatus === "void") crmStatus = "rejected";

  const approvedAt: Date | null =
    crmStatus === "approved" && procoreCo.approved_at
      ? new Date(procoreCo.approved_at)
      : null;

  // Upsert change_orders (keyed by deal_id + co_number; update if procore_co_id matches)
  await client.query(
    `INSERT INTO ${schemaName}.change_orders
       (id, deal_id, co_number, title, amount, status, procore_co_id, approved_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (deal_id, co_number) DO UPDATE SET
       title = EXCLUDED.title,
       amount = EXCLUDED.amount,
       status = EXCLUDED.status,
       procore_co_id = EXCLUDED.procore_co_id,
       approved_at = EXCLUDED.approved_at,
       updated_at = NOW()`,
    [dealId, coNumber, title, amount, crmStatus, procoreCoId, approvedAt]
  );

  // Recalculate change_order_total on the deal (sum of approved COs)
  const updateResult = await client.query(
    `UPDATE ${schemaName}.deals
     SET change_order_total = (
       SELECT COALESCE(SUM(amount), 0)
       FROM ${schemaName}.change_orders
       WHERE deal_id = $1 AND status = 'approved'
     ),
     procore_last_synced_at = NOW(),
     updated_at = NOW()
     WHERE id = $1
     RETURNING change_order_total`,
    [dealId]
  );
  const newTotal: number =
    parseFloat(String(updateResult.rows[0]?.change_order_total ?? "0")) || 0;

  if (oldTotal !== newTotal) {
    await client.query(
      `INSERT INTO ${schemaName}.notifications
         (id, type, title, body, user_id, is_read, created_at)
       VALUES (gen_random_uuid(), 'system', 'Change Order Update', $1, $2, false, NOW())`,
      [
        `Deal ${dealNumber}: CO total changed from $${oldTotal.toFixed(2)} to $${newTotal.toFixed(2)}`,
        assignedRepId,
      ]
    );
    console.log(
      `[Procore:sync] Notification sent for deal ${dealId}: CO total ${oldTotal} → ${newTotal}`
    );
  }

  // Upsert procore_sync_state
  await client.query(
    `INSERT INTO public.procore_sync_state
       (id, entity_type, procore_id, crm_entity_type, crm_entity_id, office_id,
        sync_direction, sync_status, last_synced_at, last_procore_updated_at, created_at, updated_at)
     VALUES (gen_random_uuid(), 'change_order', $1, 'change_order', $2, $3,
             'procore_to_crm', 'synced', NOW(), NOW(), NOW(), NOW())
     ON CONFLICT (entity_type, procore_id, office_id) DO UPDATE SET
       sync_status = 'synced',
       last_synced_at = NOW(),
       last_procore_updated_at = NOW(),
       error_message = NULL,
       updated_at = NOW()`,
    [procoreCoId, dealId, officeId]
  );

  console.log(
    `[Procore:sync] Synced CO ${procoreCoId} (${crmStatus}) → deal ${dealId}`
  );
}

async function markWebhookProcessed(
  client: any,
  webhookLogId: number,
  errorMessage: string | null
): Promise<void> {
  await client.query(
    `UPDATE public.procore_webhook_log
     SET processed = $1, processed_at = NOW(), error_message = $2
     WHERE id = $3`,
    [errorMessage == null, errorMessage, webhookLogId]
  );
}

/**
 * Periodic poll job: runs every 15 minutes.
 * For each office, polls Procore for project and CO updates on linked deals.
 */
export async function runProcoreSync(): Promise<void> {
  console.log("[Worker:procore-sync] Starting periodic Procore poll...");

  const companyId = process.env.PROCORE_COMPANY_ID;
  if (!companyId) {
    console.error("[Worker:procore-sync] PROCORE_COMPANY_ID not set — skipping");
    return;
  }

  if (isDevMode()) {
    console.log("[Worker:procore-sync] Dev mode — skipping actual Procore poll");
    return;
  }

  // Fetch the list of active offices with a short-lived connection
  let officeRows: Array<{ id: string; slug: string }> = [];
  {
    const listClient = await pool.connect();
    try {
      const officeResult = await listClient.query(
        "SELECT id, slug FROM public.offices WHERE is_active = true"
      );
      officeRows = officeResult.rows;
    } finally {
      listClient.release();
    }
  }

  for (const office of officeRows) {
    const officeId: string = office.id;
    const officeSlug: string = office.slug;

    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(officeSlug)) {
      console.error(`[Procore:worker] Invalid office slug: "${officeSlug}" — skipping`);
      continue;
    }

    const schemaName = `office_${officeSlug}`;
    const client = await pool.connect();
    try {
      // Find all deals with a linked Procore project
      const dealsResult = await client.query(
        `SELECT id, procore_project_id, procore_last_synced_at
         FROM ${schemaName}.deals
         WHERE procore_project_id IS NOT NULL AND is_active = true`,
      );

      for (const deal of dealsResult.rows) {
        const procoreProjectId: number = deal.procore_project_id;
        const dealId: string = deal.id;

        try {
          // Fetch project details
          const project = await procoreWorkerFetch(
            `/rest/v1.0/companies/${companyId}/projects/${procoreProjectId}`
          );

          // Sync project status (conflict detection included)
          await client.query("BEGIN");
          await syncProjectStatusToCrm(
            client,
            schemaName,
            officeId,
            procoreProjectId,
            project
          );

          // Fetch and sync change orders
          const cosResult = await procoreWorkerFetch<any[]>(
            `/rest/v1.0/projects/${procoreProjectId}/change_orders/contracts`
          );
          const cos = Array.isArray(cosResult) ? cosResult : [];
          for (const co of cos) {
            await syncChangeOrderToCrm(
              client,
              schemaName,
              officeId,
              procoreProjectId,
              co
            );
          }

          await client.query("COMMIT");
        } catch (dealErr) {
          await client.query("ROLLBACK").catch(() => {});
          console.error(
            `[Worker:procore-sync] Failed to sync project ${procoreProjectId} (deal ${dealId}):`,
            dealErr
          );
        }
      }
    } catch (officeErr) {
      console.error(
        `[Worker:procore-sync] Failed to process office ${officeSlug}:`,
        officeErr
      );
    } finally {
      client.release();
    }
  }

  console.log("[Worker:procore-sync] Poll complete");
}

export async function runScheduledCatalogSync(): Promise<void> {
  console.log("[Worker:catalog-sync] Starting scheduled Procore catalog refresh...");

  if (!process.env.PROCORE_COMPANY_ID && !isDevMode()) {
    console.error("[Worker:catalog-sync] PROCORE_COMPANY_ID not set — skipping");
    return;
  }

  if (isDevMode()) {
    console.log("[Worker:catalog-sync] Dev mode — skipping actual Procore catalog refresh");
    return;
  }

  const { runScheduledCatalogSync: runServerScheduledCatalogSync } = await importFirstAvailable<{
    runScheduledCatalogSync: () => Promise<void>;
  }>(SERVER_PROCORE_SYNC_MODULES);

  await runServerScheduledCatalogSync();
  console.log("[Worker:catalog-sync] Scheduled Procore catalog refresh completed");
}
