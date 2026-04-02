# Plan 8: Procore Integration

**Date:** 2026-04-02
**Sprint window:** April 21–25, 2026
**Spec refs:** Section 7 (Procore Integration), Section 20 (SyncHub v3 Integration Boundary), Section 24 (Integration Retry & Idempotency)

---

## Context

The CRM is the deal lifecycle authority. Procore is the project execution system of record. This plan wires them together:

- **CRM → Procore:** Deal won creates a Procore project. Stage changes update Procore project status (guardrailed by `pipeline_stage_config.procore_stage_mapping`).
- **Procore → CRM:** Webhooks + periodic poll bring in project status changes, change orders. `procore_sync_state` tracks every link and surfaces conflicts for admin review — no auto-overwrites.
- **SyncHub → CRM:** One-way push endpoint receives Bid Board opportunities. SyncHub is read-only from the CRM's perspective; the CRM does not read SyncHub's database.

No Playwright. All Procore interaction is REST API + webhooks.

---

## Source of Truth Boundaries

| Domain | Authority | Direction |
|---|---|---|
| Deal stage, pipeline position, estimates | CRM | CRM → Procore |
| Deal contacts, assigned rep, lost reason | CRM | CRM only (not synced) |
| Project status, schedule, budget | Procore | Procore → CRM (read) |
| Change orders (amounts, approval status) | Procore | Procore → CRM (read) |
| Project creation from won deals | CRM | CRM → Procore (write) |
| Bid Board opportunities | SyncHub | SyncHub → CRM (push) |

On conflict: authority system wins. `procore_sync_state.conflict_data` stores the divergence. Admin reviews and resolves manually.

---

## Existing Schema (read-only reference)

### `public.procore_sync_state`
- `id` UUID PK
- `entity_type` ENUM(`project`, `bid`, `change_order`, `contact`)
- `procore_id` BIGINT — Procore's internal ID
- `crm_entity_type` VARCHAR(50)
- `crm_entity_id` UUID
- `office_id` UUID FK → offices.id
- `sync_direction` ENUM(`crm_to_procore`, `procore_to_crm`, `bidirectional`)
- `last_synced_at` TIMESTAMPTZ
- `last_procore_updated_at` TIMESTAMPTZ
- `last_crm_updated_at` TIMESTAMPTZ
- `sync_status` ENUM(`synced`, `pending`, `conflict`, `error`) DEFAULT `synced`
- `conflict_data` JSONB
- `error_message` TEXT
- UNIQUE(`entity_type`, `procore_id`, `office_id`)

### `public.procore_webhook_log`
- `id` BIGSERIAL PK
- `event_type` VARCHAR(100)
- `resource_id` BIGINT
- `payload` JSONB
- `processed` BOOLEAN DEFAULT false
- `processed_at` TIMESTAMPTZ
- `error_message` TEXT
- `received_at` TIMESTAMPTZ DEFAULT NOW()

### `tenant.deals` (Procore fields)
- `procore_project_id` BIGINT — set when CRM creates the Procore project
- `procore_bid_id` BIGINT — set when SyncHub pushes a bid-linked opportunity
- `procore_last_synced_at` TIMESTAMPTZ

### `tenant.change_orders`
- `procore_co_id` BIGINT — Procore's CO ID (nullable; set on inbound sync)

### `public.pipeline_stage_config`
- `procore_stage_mapping` VARCHAR(100) — Procore project status value. NULL = do not sync this stage.

---

## Tasks

### Task 1: Procore API client

**File:** `server/src/lib/procore-client.ts`

OAuth client credentials flow. All Procore API calls funnel through this client. Implements retry (3 attempts, exponential backoff: 1s → 3s → 9s) and circuit breaker (open after 5 consecutive failures, half-open after 60s) per spec Section 24.

```typescript
// server/src/lib/procore-client.ts

const PROCORE_BASE_URL = "https://api.procore.com";
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 3000, 9000];
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 60_000;

type CircuitState = "closed" | "open" | "half_open";

interface CircuitBreaker {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

const breaker: CircuitBreaker = {
  state: "closed",
  failures: 0,
  openedAt: null,
};

function checkCircuit(): void {
  if (breaker.state === "open") {
    const elapsed = Date.now() - (breaker.openedAt ?? 0);
    if (elapsed >= CIRCUIT_BREAKER_RESET_MS) {
      breaker.state = "half_open";
      console.warn("[Procore] Circuit breaker half-open — probing");
    } else {
      throw new Error("[Procore] Circuit breaker is OPEN — refusing request");
    }
  }
}

function recordSuccess(): void {
  breaker.failures = 0;
  breaker.state = "closed";
  breaker.openedAt = null;
}

function recordFailure(): void {
  breaker.failures += 1;
  if (breaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    breaker.state = "open";
    breaker.openedAt = Date.now();
    console.error(
      `[Procore] Circuit breaker OPEN after ${breaker.failures} consecutive failures`
    );
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.value;
  }

  const clientId = process.env.PROCORE_CLIENT_ID;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PROCORE_CLIENT_ID and PROCORE_CLIENT_SECRET must be set");
  }

  const res = await fetch(`${PROCORE_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[Procore] Token fetch failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    // data.expires_in is in seconds; subtract 60s buffer
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

async function procoreFetch<T = any>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  checkCircuit();

  const token = await getAccessToken();
  const url = `${PROCORE_BASE_URL}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
        if (attempt < MAX_RETRIES) {
          console.warn(
            `[Procore] 429 rate limited — waiting ${retryAfter}s (attempt ${attempt + 1}/${MAX_RETRIES})`
          );
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw new Error(`[Procore] Rate limited (429) after ${MAX_RETRIES} retries`);
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`[Procore] ${method} ${path} failed: ${res.status} ${errBody}`);
      }

      const data: T = res.status === 204 ? ({} as T) : await res.json();
      recordSuccess();
      return data;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_MS[attempt] ?? 9000;
        console.warn(
          `[Procore] Request failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms:`,
          err
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      recordFailure();
      throw err;
    }
  }

  // TypeScript requires an explicit return — unreachable
  throw new Error("[Procore] Unexpected exit from retry loop");
}

export const procoreClient = {
  get: <T = any>(path: string) => procoreFetch<T>("GET", path),
  post: <T = any>(path: string, body: unknown) => procoreFetch<T>("POST", path, body),
  patch: <T = any>(path: string, body: unknown) => procoreFetch<T>("PATCH", path, body),
  delete: <T = any>(path: string) => procoreFetch<T>("DELETE", path),
  /** Expose circuit breaker state for admin status endpoint */
  getCircuitState: () => ({ ...breaker }),
};
```

**Required env vars:**
- `PROCORE_CLIENT_ID`
- `PROCORE_CLIENT_SECRET`
- `PROCORE_COMPANY_ID` — Procore company ID (used in all API paths)

---

### Task 2: Procore sync service

**File:** `server/src/modules/procore/sync-service.ts`

Two functions:
1. `createProcoreProject(tenantDb, deal, officeId)` — called by the `deal.won` handler. Idempotent: checks `deals.procore_project_id` first. Creates the project via REST, writes back `procore_project_id` and `procore_last_synced_at`, upserts `procore_sync_state`.
2. `syncDealStageToProcore(tenantDb, dealId, crmStageId, officeId)` — called by the `deal.stage.changed` handler. Reads `pipeline_stage_config.procore_stage_mapping` for the CRM stage. If mapping exists, patches Procore project status. If no mapping, skips (logs reason). Updates `procore_sync_state`.

```typescript
// server/src/modules/procore/sync-service.ts

import { eq, and } from "drizzle-orm";
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
      // stage set to the Procore equivalent of "In Production" for won deals
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
```

---

### Task 3: Webhook receiver

**File:** `server/src/modules/procore/webhook-routes.ts`

`POST /api/webhooks/procore` — public route (no JWT, added before `authMiddleware`). Validates `X-Procore-Signature` HMAC-SHA256 against `PROCORE_WEBHOOK_SECRET`. Idempotency: checks `procore_webhook_log` for a duplicate with same `event_type` + `resource_id` within the last 60 seconds before processing.

Supported event types: `project.update`, `change_order.create`, `change_order.update`. All events are written to `procore_webhook_log` first (durability), then dispatched.

```typescript
// server/src/modules/procore/webhook-routes.ts

import { Router } from "express";
import crypto from "crypto";
import { db } from "../../db.js";
import { procoreWebhookLog } from "@trock-crm/shared/schema";
import { and, eq, gt, sql } from "drizzle-orm";

const router = Router();

function verifyProcoreSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  const secret = process.env.PROCORE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[Procore:webhook] PROCORE_WEBHOOK_SECRET not set — rejecting");
    return false;
  }
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signatureHeader.replace(/^sha256=/, ""), "hex")
    );
  } catch {
    return false;
  }
}

// Raw body capture middleware (needed for HMAC verification)
// Applied only to this route — must be mounted BEFORE express.json() for this path
router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-procore-signature"] as string | undefined;

      if (!verifyProcoreSignature(rawBody, signature)) {
        console.warn("[Procore:webhook] Signature verification failed — rejecting");
        return res.status(401).json({ error: "Invalid signature" });
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Invalid JSON" });
      }

      const eventType: string = payload.event_type ?? payload.resource_name ?? "unknown";
      const resourceId: number = payload.id ?? payload.resource_id ?? 0;

      // Dedup check: same event_type + resource_id within 60 seconds
      const sixtySecondsAgo = new Date(Date.now() - 60_000);
      const [recentDuplicate] = await db
        .select({ id: procoreWebhookLog.id })
        .from(procoreWebhookLog)
        .where(
          and(
            eq(procoreWebhookLog.eventType, eventType),
            eq(procoreWebhookLog.resourceId, resourceId),
            gt(procoreWebhookLog.receivedAt, sixtySecondsAgo)
          )
        )
        .limit(1);

      if (recentDuplicate) {
        console.log(
          `[Procore:webhook] Duplicate event ${eventType}:${resourceId} within 60s — skipping`
        );
        return res.json({ status: "duplicate_skipped" });
      }

      // Write to log (durable record before processing)
      const [logEntry] = await db
        .insert(procoreWebhookLog)
        .values({
          eventType,
          resourceId,
          payload,
          processed: false,
        })
        .returning();

      // Acknowledge immediately — process async via job_queue
      res.json({ status: "accepted", logId: logEntry.id });

      // Dispatch to job_queue for async processing
      // Uses raw SQL because this is outside tenant context (public schema)
      await db.execute(
        sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
            VALUES ('procore_webhook', ${JSON.stringify({
              webhookLogId: logEntry.id,
              eventType,
              resourceId,
              payload,
            })}::jsonb, NULL, 'pending', NOW())`
      );
    } catch (err) {
      next(err);
    }
  }
);

export const procoreWebhookRoutes = router;
```

**Mount in `server/src/app.ts` BEFORE the auth+tenant router:**
```typescript
// Procore webhooks — public, signature-verified, no JWT
import { procoreWebhookRoutes } from "./modules/procore/webhook-routes.js";
app.use("/api/webhooks/procore", procoreWebhookRoutes);
```

**Required env vars:**
- `PROCORE_WEBHOOK_SECRET` — shared secret configured in Procore's webhook settings

---

### Task 4: SyncHub integration endpoint

**File:** `server/src/modules/procore/synchub-routes.ts`

`POST /api/integrations/synchub/opportunities` — authenticated by a shared secret header (`X-SyncHub-Secret`), not by JWT. One-way push from SyncHub. Creates or updates a CRM deal from a Bid Board opportunity. Sets `procore_bid_id` on the deal if a Procore bid ID is provided.

This route lives outside the JWT-protected tenant router. It uses an internal shared secret (`SYNCHUB_INTEGRATION_SECRET` env var). The office is resolved from the payload's `office_slug` field.

```typescript
// server/src/modules/procore/synchub-routes.ts

import { Router } from "express";
import { eq, and, ilike } from "drizzle-orm";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

// SyncHub shared-secret auth middleware
function requireSyncHubSecret(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  const secret = process.env.SYNCHUB_INTEGRATION_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "SYNCHUB_INTEGRATION_SECRET not configured" });
  }
  if (req.headers["x-synchub-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * POST /api/integrations/synchub/opportunities
 *
 * Payload shape (sent by SyncHub):
 * {
 *   office_slug: string;           // e.g. "dallas"
 *   bid_board_id: string;          // SyncHub internal ID for dedup
 *   procore_bid_id?: number;       // Procore bid ID (if available)
 *   name: string;                  // Project name
 *   stage_slug: string;            // CRM stage slug (e.g. "dd", "estimating")
 *   property_address?: string;
 *   property_city?: string;
 *   property_state?: string;
 *   property_zip?: string;
 *   dd_estimate?: string;          // Numeric string
 *   source?: string;               // "bid_board"
 *   assigned_rep_email?: string;   // Rep to assign (matched by email)
 * }
 */
router.post("/opportunities", requireSyncHubSecret, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      office_slug,
      bid_board_id,
      procore_bid_id,
      name,
      stage_slug,
      property_address,
      property_city,
      property_state,
      property_zip,
      dd_estimate,
      source = "bid_board",
      assigned_rep_email,
    } = req.body;

    if (!office_slug || !bid_board_id || !name || !stage_slug) {
      throw new AppError(400, "office_slug, bid_board_id, name, and stage_slug are required");
    }

    // Validate office slug format (prevent injection)
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(office_slug)) {
      throw new AppError(400, "Invalid office_slug format");
    }

    // Resolve office
    const officeResult = await client.query(
      "SELECT id FROM public.offices WHERE slug = $1 AND is_active = true LIMIT 1",
      [office_slug]
    );
    if (officeResult.rows.length === 0) {
      throw new AppError(404, `Office not found: ${office_slug}`);
    }
    const officeId: string = officeResult.rows[0].id;
    const schemaName = `office_${office_slug}`;

    // Resolve stage
    const stageResult = await client.query(
      "SELECT id FROM public.pipeline_stage_config WHERE slug = $1 LIMIT 1",
      [stage_slug]
    );
    if (stageResult.rows.length === 0) {
      throw new AppError(400, `Unknown stage slug: ${stage_slug}`);
    }
    const stageId: string = stageResult.rows[0].id;

    // Resolve assigned rep (optional — fallback to a system/admin user)
    let assignedRepId: string | null = null;
    if (assigned_rep_email) {
      const repResult = await client.query(
        "SELECT id FROM public.users WHERE email = $1 AND is_active = true LIMIT 1",
        [assigned_rep_email.toLowerCase()]
      );
      assignedRepId = repResult.rows[0]?.id ?? null;
    }
    if (!assignedRepId) {
      // Fallback: pick any active admin/director in this office
      const fallbackResult = await client.query(
        `SELECT id FROM public.users
         WHERE office_id = $1 AND is_active = true AND role IN ('admin', 'director')
         ORDER BY created_at ASC LIMIT 1`,
        [officeId]
      );
      if (fallbackResult.rows.length === 0) {
        throw new AppError(500, "No admin/director found to assign opportunity to");
      }
      assignedRepId = fallbackResult.rows[0].id;
    }

    await client.query("BEGIN");

    // Idempotency: check for existing deal with this bid_board_id (stored in source field + name match
    // OR via a dedicated synchub_bid_board_id column if added in a future migration).
    // For now: match by procore_bid_id if provided (most reliable), else by name + stage + office.
    let existingDealId: string | null = null;
    if (procore_bid_id != null) {
      const existingResult = await client.query(
        `SELECT id FROM ${schemaName}.deals WHERE procore_bid_id = $1 LIMIT 1`,
        [procore_bid_id]
      );
      existingDealId = existingResult.rows[0]?.id ?? null;
    }

    if (existingDealId) {
      // Update the existing deal's stage and bid ID
      await client.query(
        `UPDATE ${schemaName}.deals
         SET stage_id = $1, procore_bid_id = $2, updated_at = NOW()
         WHERE id = $3`,
        [stageId, procore_bid_id ?? null, existingDealId]
      );
      await client.query("COMMIT");
      console.log(`[SyncHub] Updated existing deal ${existingDealId} from Bid Board push`);
      return res.json({ status: "updated", deal_id: existingDealId });
    }

    // Generate deal number: TR-{YYYY}-{NNNN}
    const year = new Date().getFullYear();
    const prefix = `TR-${year}-`;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [prefix]);
    const maxResult = await client.query(
      `SELECT deal_number FROM ${schemaName}.deals
       WHERE deal_number LIKE $1 ORDER BY deal_number DESC LIMIT 1 FOR UPDATE`,
      [`${prefix}%`]
    );
    let nextSeq = 1;
    if (maxResult.rows.length > 0) {
      const parsed = parseInt(maxResult.rows[0].deal_number.replace(prefix, ""), 10);
      if (!isNaN(parsed)) nextSeq = parsed + 1;
    }
    const dealNumber = `${prefix}${String(nextSeq).padStart(4, "0")}`;

    // Insert new deal
    const insertResult = await client.query(
      `INSERT INTO ${schemaName}.deals
       (deal_number, name, stage_id, assigned_rep_id, procore_bid_id,
        property_address, property_city, property_state, property_zip,
        dd_estimate, source, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, NOW(), NOW())
       RETURNING id`,
      [
        dealNumber,
        name,
        stageId,
        assignedRepId,
        procore_bid_id ?? null,
        property_address ?? null,
        property_city ?? null,
        property_state ?? null,
        property_zip ?? null,
        dd_estimate ?? null,
        source,
      ]
    );

    const newDealId: string = insertResult.rows[0].id;

    // Write to job_queue so worker can fire deal.created notification
    await client.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
       VALUES ('domain_event', $1::jsonb, $2, 'pending', NOW())`,
      [
        JSON.stringify({
          eventName: "deal.created",
          dealId: newDealId,
          source: "synchub_bid_board",
          officeId,
        }),
        officeId,
      ]
    );

    await client.query("COMMIT");

    console.log(`[SyncHub] Created deal ${dealNumber} (${newDealId}) from Bid Board push`);
    res.status(201).json({ status: "created", deal_id: newDealId, deal_number: dealNumber });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export const syncHubRoutes = router;
```

**Mount in `server/src/app.ts` BEFORE the auth+tenant router (no JWT required):**
```typescript
import { syncHubRoutes } from "./modules/procore/synchub-routes.js";
app.use("/api/integrations/synchub", syncHubRoutes);
```

**Required env vars:**
- `SYNCHUB_INTEGRATION_SECRET` — shared secret; SyncHub sends this in `X-SyncHub-Secret` header

---

### Task 5: Deal-to-project automation (deal.won event handler)

**File:** `server/src/modules/procore/event-handlers.ts`

Registers listeners on the event bus for `deal.won` and `deal.stage.changed`. Both write a `procore_sync` job to `job_queue` and let the worker execute the Procore API call asynchronously (same outbox pattern used by the deals module).

The reason to go async via job_queue rather than calling `createProcoreProject` synchronously in the event handler: the `deal.won` event fires after the DB transaction commits (in the stage-change handler). By that point, the deal record is visible to the worker. If the Procore API call fails, the job stays in `pending` state and retries on the next poll cycle — the deal is not rolled back.

```typescript
// server/src/modules/procore/event-handlers.ts

import { eventBus } from "../../events/bus.js";
import { db } from "../../db.js";
import { sql } from "drizzle-orm";
import type { DomainEvent } from "../../events/types.js";

/**
 * Register Procore event handlers on the in-process event bus.
 * Call once during server startup (in createApp or index.ts).
 */
export function registerProcoreEventHandlers(): void {
  // deal.won → create Procore project
  eventBus.onEvent("deal.won", async (event: DomainEvent) => {
    const { dealId, officeId } = event.payload as { dealId: string; officeId: string };
    if (!dealId || !officeId) return;

    try {
      await db.execute(
        sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
            VALUES ('procore_sync', ${JSON.stringify({
              action: "create_project",
              dealId,
              officeId,
            })}::jsonb, ${officeId}, 'pending', NOW())`
      );
      console.log(`[Procore:events] Queued create_project job for deal ${dealId}`);
    } catch (err) {
      console.error("[Procore:events] Failed to enqueue create_project job:", err);
    }
  });

  // deal.stage.changed → update Procore project status
  eventBus.onEvent("deal.stage.changed", async (event: DomainEvent) => {
    const { dealId, newStageId, officeId } = event.payload as {
      dealId: string;
      newStageId: string;
      officeId: string;
    };
    if (!dealId || !newStageId || !officeId) return;

    try {
      await db.execute(
        sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
            VALUES ('procore_sync', ${JSON.stringify({
              action: "sync_stage",
              dealId,
              crmStageId: newStageId,
              officeId,
            })}::jsonb, ${officeId}, 'pending', NOW())`
      );
      console.log(
        `[Procore:events] Queued sync_stage job for deal ${dealId} → stage ${newStageId}`
      );
    } catch (err) {
      console.error("[Procore:events] Failed to enqueue sync_stage job:", err);
    }
  });
}
```

**Wire in `server/src/app.ts` (call after `initSsePush()`):**
```typescript
import { registerProcoreEventHandlers } from "./modules/procore/event-handlers.js";
// ... inside createApp(), after initSsePush():
registerProcoreEventHandlers();
```

---

### Task 6: Change order sync (inbound from Procore)

**File:** `worker/src/jobs/procore-sync.ts` (section: `syncChangeOrdersForDeal`)

The worker's `procore_webhook` and `procore_poll` job handlers call this function when a `change_order.create` or `change_order.update` event arrives. It:

1. Finds the deal linked to the Procore project ID.
2. Upserts the change order in `tenant.change_orders` (keyed by `procore_co_id`).
3. Recalculates `deals.change_order_total` by summing all approved COs.
4. Upserts `procore_sync_state` for the CO.

```typescript
// Worker-side: part of worker/src/jobs/procore-sync.ts

/**
 * Sync a single change order from Procore into the CRM.
 * Uses raw SQL (worker can't import from server package).
 *
 * @param client - pg.PoolClient in an active transaction
 * @param schemaName - e.g. "office_dallas"
 * @param officeId - UUID
 * @param procoreProjectId - Procore project ID
 * @param procoreCo - Raw CO object from Procore REST API
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
    `SELECT id FROM ${schemaName}.deals WHERE procore_project_id = $1 LIMIT 1`,
    [procoreProjectId]
  );
  if (dealResult.rows.length === 0) {
    console.warn(
      `[Procore:sync] No CRM deal found for Procore project ${procoreProjectId} — skipping CO sync`
    );
    return;
  }
  const dealId: string = dealResult.rows[0].id;

  const procoreCoId: number = procoreCo.id;
  const coNumber: number = procoreCo.number ?? 0;
  const title: string = (procoreCo.title ?? "Change Order").substring(0, 500);
  const amount: string = String(procoreCo.grand_total ?? procoreCo.amount ?? "0");

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
  await client.query(
    `UPDATE ${schemaName}.deals
     SET change_order_total = (
       SELECT COALESCE(SUM(amount), 0)
       FROM ${schemaName}.change_orders
       WHERE deal_id = $1 AND status = 'approved'
     ),
     procore_last_synced_at = NOW(),
     updated_at = NOW()
     WHERE id = $1`,
    [dealId]
  );

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
```

---

### Task 7: Procore sync worker job

**File:** `worker/src/jobs/procore-sync.ts`

Handles two job types from `job_queue`:
- `procore_sync` — dispatches by `action` field: `create_project` or `sync_stage`
- `procore_webhook` — processes a stored `procore_webhook_log` entry

Also exports `runProcoreSync()` — the periodic poll function, scheduled every 15 minutes.

The poll:
1. Fetches all active offices.
2. For each office, finds deals with `procore_project_id` set.
3. For each linked project, calls `GET /rest/v1.0/companies/{company_id}/projects/{project_id}/change_orders/contracts` to pull COs.
4. Applies conflict detection: if `last_procore_updated_at > last_synced_at` AND `last_crm_updated_at > last_synced_at`, sets `sync_status = 'conflict'` and writes `conflict_data`.

```typescript
// worker/src/jobs/procore-sync.ts

import { pool } from "../db.js";

const PROCORE_BASE_URL = "https://api.procore.com";

// Inline token cache for worker (mirrors server/src/lib/procore-client.ts but
// without the circuit breaker — worker failures are surfaced via job_queue status)
let workerCachedToken: { value: string; expiresAt: number } | null = null;

async function getWorkerProcoreToken(): Promise<string> {
  if (workerCachedToken && workerCachedToken.expiresAt - Date.now() > 60_000) {
    return workerCachedToken.value;
  }
  const clientId = process.env.PROCORE_CLIENT_ID;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PROCORE_CLIENT_ID and PROCORE_CLIENT_SECRET must be set");
  }
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
  const dealResult = await client.query(
    `SELECT id, name, procore_project_id, property_address, property_city,
            property_state, property_zip
     FROM ${schemaName}.deals WHERE id = $1 LIMIT 1`,
    [dealId]
  );
  const deal = dealResult.rows[0];
  if (!deal) {
    console.warn(`[Procore:worker] handleCreateProject: deal ${dealId} not found`);
    return;
  }
  // Idempotency guard
  if (deal.procore_project_id != null) {
    console.log(
      `[Procore:worker] Deal ${dealId} already has procore_project_id ${deal.procore_project_id} — skip`
    );
    return;
  }

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
  const procoreProjectId: number = project.id;

  await client.query("BEGIN");
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
  console.log(
    `[Procore:worker] Created project ${procoreProjectId} for deal ${dealId}`
  );
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
    `SELECT id, updated_at FROM ${schemaName}.deals WHERE procore_project_id = $1 LIMIT 1`,
    [procoreProjectId]
  );
  if (dealResult.rows.length === 0) return;
  const dealId: string = dealResult.rows[0].id;
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

  // No conflict — update procore_last_synced_at on deal
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

// syncChangeOrderToCrm is defined in Task 6 above — include it in this file

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

  const client = await pool.connect();
  try {
    // Get all active offices
    const officeResult = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    for (const office of officeResult.rows) {
      const officeId: string = office.id;
      const officeSlug: string = office.slug;
      const schemaName = `office_${officeSlug}`;

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
            // Procore endpoint: GET /rest/v1.0/projects/{project_id}/change_orders/contracts
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
      }
    }
  } finally {
    client.release();
  }

  console.log("[Worker:procore-sync] Poll complete");
}
```

**Register cron in `worker/src/index.ts`:**
```typescript
import { runProcoreSync } from "./jobs/procore-sync.js";

// Procore sync poll: every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  console.log("[Worker:cron] Running Procore sync...");
  try {
    await runProcoreSync();
  } catch (err) {
    console.error("[Worker:cron] Procore sync failed:", err);
  }
});
console.log("[Worker] Cron scheduled: Procore sync every 15 minutes");
```

**Register job handlers in `worker/src/jobs/index.ts`:**
```typescript
import { registerJob } from "../queue.js";
import { handleProcoreSyncJob, handleProcoreWebhookJob } from "./procore-sync.js";

registerJob("procore_sync", handleProcoreSyncJob);
registerJob("procore_webhook", handleProcoreWebhookJob);
```

---

### Task 8: Backend tests

**Files:**
- `server/tests/modules/procore/sync-service.test.ts`
- `server/tests/modules/procore/webhook-routes.test.ts`
- `server/tests/modules/procore/synchub-routes.test.ts`

All tests use Vitest (same framework as existing tests). Procore API calls are mocked via `vi.mock`. DB interactions use the existing test PostgreSQL schema.

```typescript
// server/tests/modules/procore/sync-service.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock procore-client before importing sync-service
vi.mock("../../../src/lib/procore-client.js", () => ({
  procoreClient: {
    post: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
  },
}));

import { procoreClient } from "../../../src/lib/procore-client.js";
import {
  createProcoreProject,
  syncDealStageToProcore,
} from "../../../src/modules/procore/sync-service.js";

const mockTenantDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
};

describe("createProcoreProject", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips if procore_project_id already set (idempotency)", async () => {
    mockTenantDb.limit.mockResolvedValueOnce([
      { id: "deal-1", procoreProjectId: 99999, name: "Test Deal" },
    ]);
    await createProcoreProject(mockTenantDb as any, "deal-1", "office-id");
    expect(procoreClient.post).not.toHaveBeenCalled();
  });

  it("creates project and writes back procore_project_id", async () => {
    mockTenantDb.limit
      .mockResolvedValueOnce([
        {
          id: "deal-1",
          procoreProjectId: null,
          name: "Test Deal",
          propertyAddress: "123 Main St",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
        },
      ])
      .mockResolvedValueOnce([]); // upsertSyncState select
    vi.mocked(procoreClient.post).mockResolvedValueOnce({ id: 12345 });

    await createProcoreProject(mockTenantDb as any, "deal-1", "office-id");

    expect(procoreClient.post).toHaveBeenCalledWith(
      expect.stringContaining("/projects"),
      expect.objectContaining({ project: expect.objectContaining({ name: "Test Deal" }) })
    );
    expect(mockTenantDb.update).toHaveBeenCalled();
  });

  it("records error in sync_state on Procore API failure", async () => {
    mockTenantDb.limit.mockResolvedValueOnce([
      { id: "deal-1", procoreProjectId: null, name: "Test Deal" },
    ]);
    vi.mocked(procoreClient.post).mockRejectedValueOnce(new Error("API error"));

    // Should not throw — Procore failure doesn't roll back the won deal
    await expect(
      createProcoreProject(mockTenantDb as any, "deal-1", "office-id")
    ).resolves.not.toThrow();
  });
});

describe("syncDealStageToProcore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips if deal has no procore_project_id", async () => {
    mockTenantDb.limit.mockResolvedValueOnce([
      { id: "deal-1", procoreProjectId: null },
    ]);
    await syncDealStageToProcore(mockTenantDb as any, "deal-1", "stage-id", "office-id");
    expect(procoreClient.patch).not.toHaveBeenCalled();
  });

  it("skips if stage has no procore_stage_mapping", async () => {
    mockTenantDb.limit.mockResolvedValueOnce([
      { id: "deal-1", procoreProjectId: 12345 },
    ]);
    // db.select for stage config returns null mapping
    mockTenantDb.limit.mockResolvedValueOnce([{ procoreStageMapping: null }]);
    await syncDealStageToProcore(mockTenantDb as any, "deal-1", "stage-id", "office-id");
    expect(procoreClient.patch).not.toHaveBeenCalled();
  });

  it("patches Procore project status when mapping exists", async () => {
    mockTenantDb.limit
      .mockResolvedValueOnce([{ id: "deal-1", procoreProjectId: 12345 }])
      .mockResolvedValueOnce([{ procoreStageMapping: "In Production" }])
      .mockResolvedValueOnce([]); // upsertSyncState
    vi.mocked(procoreClient.patch).mockResolvedValueOnce({});

    await syncDealStageToProcore(mockTenantDb as any, "deal-1", "stage-id", "office-id");

    expect(procoreClient.patch).toHaveBeenCalledWith(
      expect.stringContaining("/12345"),
      { project: { stage: "In Production" } }
    );
  });
});
```

```typescript
// server/tests/modules/procore/webhook-routes.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import request from "supertest";
import express from "express";

// Mount the webhook router in a minimal test app
const WEBHOOK_SECRET = "test-webhook-secret-abc123";
process.env.PROCORE_WEBHOOK_SECRET = WEBHOOK_SECRET;

vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    and: vi.fn(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 1 }]),
    execute: vi.fn().mockResolvedValue(undefined),
  },
}));

import { procoreWebhookRoutes } from "../../../src/modules/procore/webhook-routes.js";

const app = express();
app.use("/api/webhooks/procore", procoreWebhookRoutes);

function makeSignature(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

describe("POST /api/webhooks/procore", () => {
  it("returns 401 on missing signature", async () => {
    const res = await request(app)
      .post("/api/webhooks/procore")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ event_type: "project.update", id: 1 }));
    expect(res.status).toBe(401);
  });

  it("returns 401 on invalid signature", async () => {
    const body = JSON.stringify({ event_type: "project.update", id: 1 });
    const res = await request(app)
      .post("/api/webhooks/procore")
      .set("Content-Type", "application/json")
      .set("X-Procore-Signature", "sha256=deadbeef")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("returns 200 and accepts a valid signed webhook", async () => {
    const body = JSON.stringify({ event_type: "project.update", id: 42 });
    const sig = makeSignature(body);
    const res = await request(app)
      .post("/api/webhooks/procore")
      .set("Content-Type", "application/json")
      .set("X-Procore-Signature", sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
  });

  it("returns duplicate_skipped for a recent duplicate event", async () => {
    // Mock db.limit to return a recent duplicate
    const { db } = await import("../../../src/db.js");
    vi.mocked(db.limit).mockResolvedValueOnce([{ id: 99 }]);

    const body = JSON.stringify({ event_type: "project.update", id: 42 });
    const sig = makeSignature(body);
    const res = await request(app)
      .post("/api/webhooks/procore")
      .set("Content-Type", "application/json")
      .set("X-Procore-Signature", sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("duplicate_skipped");
  });
});
```

```typescript
// server/tests/modules/procore/synchub-routes.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const SYNCHUB_SECRET = "test-synchub-secret";
process.env.SYNCHUB_INTEGRATION_SECRET = SYNCHUB_SECRET;

// Mock pool — raw SQL
vi.mock("../../../src/db.js", () => ({
  pool: {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
  },
}));

import { syncHubRoutes } from "../../../src/modules/procore/synchub-routes.js";

const app = express();
app.use(express.json());
app.use("/api/integrations/synchub", syncHubRoutes);

describe("POST /api/integrations/synchub/opportunities", () => {
  it("returns 401 with wrong secret", async () => {
    const res = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("X-SyncHub-Secret", "wrong-secret")
      .send({ office_slug: "dallas", bid_board_id: "bb-1", name: "Test", stage_slug: "dd" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("X-SyncHub-Secret", SYNCHUB_SECRET)
      .send({ office_slug: "dallas" }); // missing bid_board_id, name, stage_slug
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid office_slug format", async () => {
    const res = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("X-SyncHub-Secret", SYNCHUB_SECRET)
      .send({
        office_slug: "dallas; DROP TABLE deals;",
        bid_board_id: "bb-1",
        name: "Test",
        stage_slug: "dd",
      });
    expect(res.status).toBe(400);
  });
});
```

---

### Task 9: Frontend

Three UI surfaces: admin sync status page, deal detail Procore panel, personal project board for reps.

**Files:**
- `client/src/components/procore/procore-sync-status.tsx` — admin only
- `client/src/components/procore/deal-procore-panel.tsx` — deal detail tab
- `client/src/pages/procore-board.tsx` — rep's personal project board

#### 9a. Admin sync status page

`GET /api/procore/sync-status` (admin-only route, Task 10) returns:
```json
{
  "summary": {
    "synced": 42,
    "conflict": 3,
    "error": 1,
    "pending": 0
  },
  "conflicts": [
    {
      "id": "uuid",
      "entity_type": "project",
      "procore_id": 12345,
      "crm_entity_id": "deal-uuid",
      "conflict_data": { "procore_status": "Closed", "detected_at": "..." },
      "updated_at": "2026-04-21T..."
    }
  ],
  "circuit_breaker": { "state": "closed", "failures": 0, "openedAt": null }
}
```

```typescript
// client/src/components/procore/procore-sync-status.tsx

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

interface SyncSummary {
  synced: number;
  conflict: number;
  error: number;
  pending: number;
}

interface SyncConflict {
  id: string;
  entity_type: string;
  procore_id: number;
  crm_entity_id: string;
  conflict_data: Record<string, unknown>;
  updated_at: string;
}

interface SyncStatus {
  summary: SyncSummary;
  conflicts: SyncConflict[];
  circuit_breaker: { state: string; failures: number; openedAt: number | null };
}

export function ProcoreSyncStatus() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/procore/sync-status", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading Procore sync status...</div>;
  if (error) return <div className="p-6 text-sm text-destructive">Error: {error}</div>;
  if (!status) return null;

  const cbState = status.circuit_breaker.state;
  const cbBadgeVariant =
    cbState === "closed" ? "default" : cbState === "half_open" ? "secondary" : "destructive";

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Procore Sync Status</h2>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(["synced", "pending", "conflict", "error"] as const).map((key) => (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium capitalize text-muted-foreground">
                {key}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-bold">{status.summary[key]}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Circuit breaker */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Procore API Circuit Breaker:</span>
        <Badge variant={cbBadgeVariant as any} className="capitalize">
          {cbState.replace("_", " ")}
        </Badge>
        {status.circuit_breaker.failures > 0 && (
          <span className="text-sm text-muted-foreground">
            ({status.circuit_breaker.failures} consecutive failures)
          </span>
        )}
      </div>

      {/* Conflicts table */}
      {status.conflicts.length > 0 && (
        <div>
          <h3 className="mb-3 text-base font-semibold">Conflicts Requiring Review</h3>
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">Entity</th>
                  <th className="px-4 py-2 text-left font-medium">Procore ID</th>
                  <th className="px-4 py-2 text-left font-medium">Conflict Data</th>
                  <th className="px-4 py-2 text-left font-medium">Detected</th>
                  <th className="px-4 py-2 text-left font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {status.conflicts.map((c, i) => (
                  <tr
                    key={c.id}
                    className={i % 2 === 0 ? "bg-background" : "bg-muted/30"}
                  >
                    <td className="px-4 py-2 capitalize">{c.entity_type}</td>
                    <td className="px-4 py-2 font-mono">{c.procore_id}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {JSON.stringify(c.conflict_data)}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {new Date(c.updated_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await fetch(`/api/procore/sync-conflicts/${c.id}/resolve`, {
                            method: "POST",
                            credentials: "include",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ resolution: "accept_crm" }),
                          });
                          load();
                        }}
                      >
                        Accept CRM
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
```

#### 9b. Deal detail Procore panel

Shown as a tab on the deal detail page. Displays sync state, Procore project link, and a list of synced change orders.

```typescript
// client/src/components/procore/deal-procore-panel.tsx

import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface ProcorePanelProps {
  dealId: string;
  procoreProjectId: number | null;
  procoreLastSyncedAt: string | null;
  changeOrderTotal: string | null;
}

interface SyncStateInfo {
  sync_status: "synced" | "pending" | "conflict" | "error";
  last_synced_at: string | null;
  error_message: string | null;
}

interface ChangeOrder {
  id: string;
  co_number: number;
  title: string;
  amount: string;
  status: "pending" | "approved" | "rejected";
  procore_co_id: number | null;
}

export function DealProcorePanel({
  dealId,
  procoreProjectId,
  procoreLastSyncedAt,
  changeOrderTotal,
}: ProcorePanelProps) {
  const [syncState, setSyncState] = useState<SyncStateInfo | null>(null);
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [syncRes, coRes] = await Promise.all([
          fetch(`/api/procore/deals/${dealId}/sync-state`, { credentials: "include" }),
          fetch(`/api/deals/${dealId}/change-orders`, { credentials: "include" }),
        ]);
        if (syncRes.ok) setSyncState(await syncRes.json());
        if (coRes.ok) {
          const data = await coRes.json();
          setChangeOrders(data.changeOrders ?? []);
        }
      } catch {
        // Non-blocking — Procore panel failure should not break the deal detail page
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [dealId]);

  const statusVariant: Record<string, string> = {
    synced: "default",
    pending: "secondary",
    conflict: "destructive",
    error: "destructive",
  };

  const procoreUrl = procoreProjectId
    ? `https://app.procore.com/projects/${procoreProjectId}`
    : null;

  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Procore Link</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {procoreProjectId ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Project ID:</span>
                <span className="font-mono text-sm">{procoreProjectId}</span>
                <a
                  href={procoreUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 underline hover:text-blue-800"
                >
                  Open in Procore
                </a>
              </div>
              {syncState && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Sync status:</span>
                  <Badge
                    variant={statusVariant[syncState.sync_status] as any}
                    className="capitalize"
                  >
                    {syncState.sync_status}
                  </Badge>
                  {syncState.error_message && (
                    <span className="text-xs text-destructive">{syncState.error_message}</span>
                  )}
                </div>
              )}
              {procoreLastSyncedAt && (
                <p className="text-xs text-muted-foreground">
                  Last synced: {new Date(procoreLastSyncedAt).toLocaleString()}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No Procore project linked. A project will be created automatically when this
              deal is marked as Closed Won.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Change orders */}
      {changeOrders.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Change Orders
              {changeOrderTotal != null && Number(changeOrderTotal) !== 0 && (
                <span className="ml-2 text-base font-bold">
                  Total: ${Number(changeOrderTotal).toLocaleString()}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-1 text-left font-medium text-muted-foreground">CO #</th>
                  <th className="py-1 text-left font-medium text-muted-foreground">Title</th>
                  <th className="py-1 text-right font-medium text-muted-foreground">Amount</th>
                  <th className="py-1 text-left font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {changeOrders.map((co) => (
                  <tr key={co.id} className="border-b last:border-0">
                    <td className="py-2 font-mono">{co.co_number}</td>
                    <td className="py-2">{co.title}</td>
                    <td className="py-2 text-right">
                      ${Number(co.amount).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <Badge
                        variant={
                          co.status === "approved"
                            ? "default"
                            : co.status === "rejected"
                            ? "destructive"
                            : "secondary"
                        }
                        className="capitalize"
                      >
                        {co.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {loading && (
        <p className="text-xs text-muted-foreground">Loading Procore data...</p>
      )}
    </div>
  );
}
```

#### 9c. Personal project board (rep view)

Shows a rep's active deals that are linked to Procore projects — a personal view of their in-production work. Route: `/procore-board`.

```typescript
// client/src/pages/procore-board.tsx

import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

interface ProjectBoardDeal {
  id: string;
  deal_number: string;
  name: string;
  procore_project_id: number;
  procore_last_synced_at: string | null;
  change_order_total: string;
  stage_name: string;
  stage_color: string;
}

export function ProcoreBoardPage() {
  const [deals, setDeals] = useState<ProjectBoardDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/procore/my-projects", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => setDeals(data.deals ?? []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading your Procore projects...</div>
    );
  if (error)
    return <div className="p-6 text-sm text-destructive">Error: {error}</div>;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">My Procore Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Active deals linked to Procore projects
        </p>
      </div>

      {deals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No deals are currently linked to Procore projects.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {deals.map((deal) => (
            <Card key={deal.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base font-semibold leading-tight">
                    {deal.name}
                  </CardTitle>
                  <Badge
                    style={{ backgroundColor: deal.stage_color ?? undefined }}
                    className="shrink-0 text-white"
                  >
                    {deal.stage_name}
                  </Badge>
                </div>
                <p className="font-mono text-xs text-muted-foreground">{deal.deal_number}</p>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Procore Project</span>
                  <a
                    href={`https://app.procore.com/projects/${deal.procore_project_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-blue-600 underline hover:text-blue-800"
                  >
                    #{deal.procore_project_id}
                  </a>
                </div>
                {Number(deal.change_order_total) !== 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">CO Total</span>
                    <span className="font-medium">
                      ${Number(deal.change_order_total).toLocaleString()}
                    </span>
                  </div>
                )}
                {deal.procore_last_synced_at && (
                  <p className="text-xs text-muted-foreground">
                    Synced: {new Date(deal.procore_last_synced_at).toLocaleString()}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### Task 10: Route wiring

**File:** `server/src/modules/procore/routes.ts`

All Procore-specific API routes under `/api/procore`:

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/procore/sync-status` | admin | Sync summary + conflicts + circuit breaker state |
| POST | `/api/procore/sync-conflicts/:id/resolve` | admin | Resolve a conflict (accept CRM or Procore value) |
| GET | `/api/procore/deals/:dealId/sync-state` | any role | Sync state for a specific deal |
| GET | `/api/procore/my-projects` | any role | Deals with linked Procore projects for the requesting user |
| GET | `/api/deals/:id/change-orders` | any role | Change orders for a deal (add to existing deals router) |

```typescript
// server/src/modules/procore/routes.ts

import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { procoreSyncState } from "@trock-crm/shared/schema";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { db } from "../../db.js";
import { procoreClient } from "../../lib/procore-client.js";

const router = Router();

// GET /api/procore/sync-status — admin overview
router.get(
  "/sync-status",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const [summary, conflicts] = await Promise.all([
        db.execute<{ sync_status: string; count: string }>(sql`
          SELECT sync_status, COUNT(*) as count
          FROM public.procore_sync_state
          GROUP BY sync_status
        `),
        db
          .select()
          .from(procoreSyncState)
          .where(eq(procoreSyncState.syncStatus, "conflict"))
          .orderBy(procoreSyncState.updatedAt),
      ]);

      const summaryMap: Record<string, number> = {
        synced: 0,
        pending: 0,
        conflict: 0,
        error: 0,
      };
      for (const row of summary.rows as any[]) {
        summaryMap[row.sync_status] = parseInt(row.count, 10);
      }

      await req.commitTransaction!();
      res.json({
        summary: summaryMap,
        conflicts,
        circuit_breaker: procoreClient.getCircuitState(),
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/procore/sync-conflicts/:id/resolve — admin manually resolves conflict
router.post(
  "/sync-conflicts/:id/resolve",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { resolution } = req.body;
      if (!resolution || !["accept_crm", "accept_procore"].includes(resolution)) {
        throw new AppError(400, "resolution must be 'accept_crm' or 'accept_procore'");
      }

      const result = await db
        .update(procoreSyncState)
        .set({
          syncStatus: "synced",
          conflictData: null,
          errorMessage: null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(procoreSyncState.id, req.params.id))
        .returning();

      if (result.length === 0) {
        throw new AppError(404, "Sync conflict record not found");
      }

      await req.commitTransaction!();
      res.json({ success: true, record: result[0] });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/procore/deals/:dealId/sync-state — sync state for a single deal
router.get("/deals/:dealId/sync-state", async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(procoreSyncState)
      .where(
        and(
          eq(procoreSyncState.crmEntityType, "deal"),
          eq(procoreSyncState.crmEntityId, req.params.dealId)
        )
      )
      .limit(1);

    await req.commitTransaction!();
    res.json(rows[0] ?? null);
  } catch (err) {
    next(err);
  }
});

// GET /api/procore/my-projects — rep's deals linked to Procore projects
router.get("/my-projects", async (req, res, next) => {
  try {
    // Raw SQL: join deals to stage config, filter by procore_project_id IS NOT NULL
    // Reps see only their own; directors/admins see all
    const userId = req.user!.id;
    const role = req.user!.role;

    const rows = await req.tenantClient!.query(
      `SELECT d.id, d.deal_number, d.name, d.procore_project_id,
              d.procore_last_synced_at, d.change_order_total,
              psc.name AS stage_name, psc.color AS stage_color
       FROM deals d
       JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       WHERE d.procore_project_id IS NOT NULL
         AND d.is_active = true
         ${role === "rep" ? "AND d.assigned_rep_id = $1" : ""}
       ORDER BY d.updated_at DESC`,
      role === "rep" ? [userId] : []
    );

    await req.commitTransaction!();
    res.json({ deals: rows.rows });
  } catch (err) {
    next(err);
  }
});

export const procoreRoutes = router;
```

**Add to `server/src/modules/deals/routes.ts` (change orders list endpoint):**
```typescript
// GET /api/deals/:id/change-orders
import { changeOrders } from "@trock-crm/shared/schema";
import { asc } from "drizzle-orm";

router.get("/:id/change-orders", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const cos = await req.tenantDb!
      .select()
      .from(changeOrders)
      .where(eq(changeOrders.dealId, req.params.id))
      .orderBy(asc(changeOrders.coNumber));

    await req.commitTransaction!();
    res.json({ changeOrders: cos });
  } catch (err) {
    next(err);
  }
});
```

**Mount in `server/src/app.ts`:**
```typescript
import { procoreRoutes } from "./modules/procore/routes.js";
// Inside tenantRouter section (auth + tenant middleware required):
tenantRouter.use("/procore", procoreRoutes);

// Outside tenant router (no JWT):
import { procoreWebhookRoutes } from "./modules/procore/webhook-routes.js";
import { syncHubRoutes } from "./modules/procore/synchub-routes.js";
app.use("/api/webhooks/procore", procoreWebhookRoutes);
app.use("/api/integrations/synchub", syncHubRoutes);
```

**Add Procore Board to client routing in `client/src/App.tsx`:**
```typescript
import { ProcoreBoardPage } from "./pages/procore-board";
// Inside router:
<Route path="/procore-board" element={<ProcoreBoardPage />} />
```

**Add to sidebar navigation:**
```typescript
// client/src/components/layout/sidebar.tsx
// Add under the rep-visible nav items:
{ label: "Procore Projects", href: "/procore-board", icon: BuildingIcon }
```

---

## New files summary

| File | Description |
|---|---|
| `server/src/lib/procore-client.ts` | OAuth client, retry + circuit breaker |
| `server/src/modules/procore/sync-service.ts` | `createProcoreProject`, `syncDealStageToProcore`, `upsertSyncState` |
| `server/src/modules/procore/webhook-routes.ts` | `POST /api/webhooks/procore` |
| `server/src/modules/procore/synchub-routes.ts` | `POST /api/integrations/synchub/opportunities` |
| `server/src/modules/procore/event-handlers.ts` | `registerProcoreEventHandlers()` |
| `server/src/modules/procore/routes.ts` | `/api/procore/*` tenant routes |
| `worker/src/jobs/procore-sync.ts` | Worker job handlers + `runProcoreSync()` |
| `client/src/components/procore/procore-sync-status.tsx` | Admin sync dashboard |
| `client/src/components/procore/deal-procore-panel.tsx` | Deal detail Procore tab |
| `client/src/pages/procore-board.tsx` | Rep's project board |
| `server/tests/modules/procore/sync-service.test.ts` | Unit tests |
| `server/tests/modules/procore/webhook-routes.test.ts` | Webhook route tests |
| `server/tests/modules/procore/synchub-routes.test.ts` | SyncHub route tests |

## Modified files

| File | Change |
|---|---|
| `server/src/app.ts` | Mount webhook, SyncHub, and procore tenant routes; call `registerProcoreEventHandlers()` |
| `server/src/modules/deals/routes.ts` | Add `GET /:id/change-orders` |
| `worker/src/index.ts` | Add 15-minute Procore sync cron |
| `worker/src/jobs/index.ts` | Register `procore_sync` and `procore_webhook` job handlers |
| `client/src/App.tsx` | Add `/procore-board` route |
| `client/src/components/layout/sidebar.tsx` | Add Procore Projects nav item |

## Required env vars (new)

| Var | Description |
|---|---|
| `PROCORE_CLIENT_ID` | OAuth app client ID |
| `PROCORE_CLIENT_SECRET` | OAuth app client secret |
| `PROCORE_COMPANY_ID` | Procore company ID (used in all API paths) |
| `PROCORE_WEBHOOK_SECRET` | HMAC secret from Procore webhook settings |
| `SYNCHUB_INTEGRATION_SECRET` | Shared secret for SyncHub → CRM push endpoint |

## Implementation notes

1. **Webhook raw body:** `express.raw({ type: "application/json" })` must be applied on the webhook route before `express.json()` parses the body — HMAC verification requires the raw bytes. The webhook router imports and applies its own `express.raw` middleware inline; mount it on `app` (not on `tenantRouter`) to avoid the global JSON middleware touching it first.

2. **Outbox durability:** All Procore API calls go through `job_queue`, not inline in request handlers. A Procore API outage does not block deal stage changes or deal-won transitions. The job stays `pending` and retries on the next poll cycle.

3. **Conflict resolution UI:** The "Accept CRM" button in the admin panel marks the conflict as resolved without writing to Procore. If the resolution should push the CRM value to Procore, a separate "Push to Procore" action should be added in a follow-up (out of scope for Plan 8).

4. **SyncHub dedup:** The current implementation keys idempotency on `procore_bid_id`. If SyncHub pushes an opportunity without a `procore_bid_id`, the dedup falls back to none (a new deal is created on every push). A future migration adding `synchub_bid_board_id VARCHAR(100)` to `deals` would give stronger dedup without relying on Procore IDs.

5. **Change order pagination:** Procore's CO endpoint is paginated. The poll implementation in Task 7 fetches the first page only. If T Rock projects accumulate many COs, add offset pagination using Procore's `page` and `per_page` query params.
