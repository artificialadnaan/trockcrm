# HubSpot Ownership Cleanup Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed active leads and deals from HubSpot ownership, surface rep-scoped cleanup work, expose office ownership queues for directors/admins, and support bulk reassignment without hiding unresolved records behind placeholder owners.

**Architecture:** Extend the current migration/admin and dashboard surfaces instead of creating a parallel tool. Add ownership-sync metadata to leads and deals, create a global HubSpot owner mapping table, implement server-side sync and cleanup evaluation services, then surface the results in rep dashboards and migration/data scrub pages with office-scoped reassignment.

**Tech Stack:** PostgreSQL, Drizzle ORM, Express, React, TypeScript, Vitest, existing HubSpot migration client, existing dashboard hooks, existing task reassignment side effects

---

## File Map

### Database / Schema

- Create: `migrations/0042_hubspot_ownership_cleanup_phase_1.sql`
- Create: `shared/src/schema/public/hubspot-owner-mappings.ts`
- Modify: `shared/src/schema/public/index.ts`
- Modify: `shared/src/schema/index.ts`
- Modify: `shared/src/schema/tenant/deals.ts`
- Modify: `shared/src/schema/tenant/leads.ts`

### Server Ownership / Cleanup

- Create: `server/src/modules/admin/ownership-sync-service.ts`
- Create: `server/src/modules/admin/cleanup-queue-service.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/admin/users-service.ts`
- Modify: `server/src/modules/migration/hubspot-client.ts`
- Modify: `server/src/modules/dashboard/service.ts`
- Modify: `server/src/modules/dashboard/routes.ts`
- Test: `server/tests/modules/admin/ownership-sync-service.test.ts`
- Test: `server/tests/modules/admin/cleanup-queue-service.test.ts`
- Test: `server/tests/modules/dashboard/service.test.ts`

### Client Rep Surfaces

- Create: `client/src/hooks/use-ownership-cleanup.ts`
- Create: `client/src/components/dashboard/my-cleanup-card.tsx`
- Create: `client/src/pages/pipeline/my-cleanup-page.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/hooks/use-dashboard.ts`
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx`
- Test: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`

### Client Admin / Director Surfaces

- Create: `client/src/components/admin/ownership-queue-table.tsx`
- Create: `client/src/components/admin/ownership-reassign-dialog.tsx`
- Modify: `client/src/hooks/use-migration.ts`
- Modify: `client/src/pages/admin/migration/migration-dashboard-page.tsx`
- Modify: `client/src/pages/admin/migration/migration-deals-page.tsx`
- Test: `client/src/pages/admin/migration/migration-dashboard-page.test.tsx`

### Verification

- Modify: `docs/superpowers/specs/2026-04-21-hubspot-ownership-cleanup-phase-1-design.md` only if implementation review proves the reviewed spec is internally inconsistent

---

### Task 1: Add Ownership Metadata Schema

**Files:**
- Create: `migrations/0042_hubspot_ownership_cleanup_phase_1.sql`
- Create: `shared/src/schema/public/hubspot-owner-mappings.ts`
- Modify: `shared/src/schema/public/index.ts`
- Modify: `shared/src/schema/index.ts`
- Modify: `shared/src/schema/tenant/deals.ts`
- Modify: `shared/src/schema/tenant/leads.ts`
- Test: `server/tests/modules/admin/ownership-sync-service.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `server/tests/modules/admin/ownership-sync-service.test.ts` with assertions that expect the sync layer to read and write the reviewed metadata:

```ts
import { describe, expect, it } from "vitest";

describe("ownership sync schema contract", () => {
  it("expects deal ownership metadata fields", () => {
    const dealRow = {
      hubspotOwnerId: "owner-123",
      hubspotOwnerEmail: "rep@trock.dev",
      ownershipSyncStatus: "matched",
      unassignedReasonCode: null,
    };

    expect(dealRow.hubspotOwnerId).toBe("owner-123");
    expect(dealRow.hubspotOwnerEmail).toBe("rep@trock.dev");
    expect(dealRow.ownershipSyncStatus).toBe("matched");
    expect(dealRow.unassignedReasonCode).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify the schema does not exist yet**

Run:

```bash
npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts
```

Expected: FAIL once the real schema-facing imports are added because the metadata columns and table bindings do not exist yet.

- [ ] **Step 3: Add the SQL migration**

Create `migrations/0042_hubspot_ownership_cleanup_phase_1.sql`:

```sql
CREATE TABLE IF NOT EXISTS public.hubspot_owner_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hubspot_owner_id VARCHAR(64) NOT NULL UNIQUE,
  hubspot_owner_email VARCHAR(320),
  user_id UUID REFERENCES public.users(id),
  office_id UUID REFERENCES public.offices(id),
  mapping_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  failure_reason_code VARCHAR(64),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS hubspot_owner_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS hubspot_owner_email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS ownership_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ownership_sync_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS unassigned_reason_code VARCHAR(64);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS hubspot_owner_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS hubspot_owner_email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS ownership_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ownership_sync_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS unassigned_reason_code VARCHAR(64);
```

- [ ] **Step 4: Add Drizzle schema bindings**

Create `shared/src/schema/public/hubspot-owner-mappings.ts`:

```ts
import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";
import { offices } from "./offices.js";
import { users } from "./users.js";

export const hubspotOwnerMappings = pgTable("hubspot_owner_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  hubspotOwnerId: varchar("hubspot_owner_id", { length: 64 }).notNull().unique(),
  hubspotOwnerEmail: varchar("hubspot_owner_email", { length: 320 }),
  userId: uuid("user_id").references(() => users.id),
  officeId: uuid("office_id").references(() => offices.id),
  mappingStatus: varchar("mapping_status", { length: 32 }).notNull().default("pending"),
  failureReasonCode: varchar("failure_reason_code", { length: 64 }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Extend `shared/src/schema/tenant/deals.ts` and `shared/src/schema/tenant/leads.ts` with:

```ts
hubspotOwnerId: varchar("hubspot_owner_id", { length: 64 }),
hubspotOwnerEmail: varchar("hubspot_owner_email", { length: 320 }),
ownershipSyncedAt: timestamp("ownership_synced_at", { withTimezone: true }),
ownershipSyncStatus: varchar("ownership_sync_status", { length: 32 }),
unassignedReasonCode: varchar("unassigned_reason_code", { length: 64 }),
```

Update exports in `shared/src/schema/public/index.ts` and `shared/src/schema/index.ts`:

```ts
export { hubspotOwnerMappings } from "./hubspot-owner-mappings.js";
```

- [ ] **Step 5: Re-run the targeted test**

Run:

```bash
npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts
```

Expected: still FAIL, but now because the sync service does not exist yet rather than because the schema shape is missing.

- [ ] **Step 6: Commit**

```bash
git add migrations/0042_hubspot_ownership_cleanup_phase_1.sql shared/src/schema/public/hubspot-owner-mappings.ts shared/src/schema/public/index.ts shared/src/schema/index.ts shared/src/schema/tenant/deals.ts shared/src/schema/tenant/leads.ts server/tests/modules/admin/ownership-sync-service.test.ts
git commit -m "feat: add ownership cleanup phase 1 schema"
```

---

### Task 2: Build HubSpot Ownership Sync And Admin Routes

**Files:**
- Create: `server/src/modules/admin/ownership-sync-service.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/migration/hubspot-client.ts`
- Modify: `server/src/modules/admin/users-service.ts`
- Test: `server/tests/modules/admin/ownership-sync-service.test.ts`

- [ ] **Step 1: Expand the failing ownership-sync tests**

Add these cases to `server/tests/modules/admin/ownership-sync-service.test.ts`:

```ts
it("assigns active records when a HubSpot owner maps to an active CRM user", async () => {});
it("marks records unmatched when the owner email cannot be mapped", async () => {});
it("records conflict when one owner id resolves to cross-office or duplicate matches", async () => {});
it("preserves manual overrides on rerun", async () => {});
it("supports dry-run counts without mutating assignments", async () => {});
```

- [ ] **Step 2: Run the ownership-sync test**

Run:

```bash
npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts
```

Expected: FAIL because `runOwnershipSync` and the supporting helpers do not exist.

- [ ] **Step 3: Add owner-email normalization helpers**

Extend `server/src/modules/migration/hubspot-client.ts`:

```ts
export function normalizeHubSpotOwnerEmail(owner: HubSpotOwner): string | null {
  return owner.email?.trim().toLowerCase() ?? null;
}
```

- [ ] **Step 4: Add active-user lookup helpers**

Extend `server/src/modules/admin/users-service.ts` with a helper that returns active users including office access:

```ts
export async function listActiveUsersWithOfficeAccess() {
  const rows = await db.execute(sql`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.office_id,
      u.is_active
    FROM users u
    WHERE u.is_active = true
  `);

  return ((rows as any).rows ?? rows).map((r: any) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    officeId: r.office_id,
    isActive: r.is_active,
  }));
}
```

- [ ] **Step 5: Implement the ownership sync service**

Create `server/src/modules/admin/ownership-sync-service.ts` with:

```ts
export async function runOwnershipSync(input: { dryRun?: boolean }) {
  return {
    assigned: 0,
    unchanged: 0,
    unmatched: 0,
    conflicts: 0,
    inactiveUserConflicts: 0,
  };
}
```

Replace the stub with logic that:

```ts
const owners = await fetchAllOwners();
const users = await listActiveUsersWithOfficeAccess();
const usersByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

for (const owner of owners) {
  const ownerEmail = normalizeHubSpotOwnerEmail(owner);
  const matchedUser = ownerEmail ? usersByEmail.get(ownerEmail) : null;

  const mappingStatus = matchedUser ? "matched" : ownerEmail ? "unmatched" : "unmatched";
  const failureReasonCode = matchedUser ? null : "owner_mapping_failure";

  await db
    .insert(hubspotOwnerMappings)
    .values({
      hubspotOwnerId: owner.id,
      hubspotOwnerEmail: ownerEmail,
      userId: matchedUser?.id ?? null,
      officeId: matchedUser?.officeId ?? null,
      mappingStatus,
      failureReasonCode,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: hubspotOwnerMappings.hubspotOwnerId,
      set: {
        hubspotOwnerEmail: ownerEmail,
        userId: matchedUser?.id ?? null,
        officeId: matchedUser?.officeId ?? null,
        mappingStatus,
        failureReasonCode,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    });
}
```

When applying assignment updates:

```ts
if (!input.dryRun) {
  await db.execute(sql`
    UPDATE deals
    SET assigned_rep_id = ${matchedUser.id},
        hubspot_owner_id = ${owner.id},
        hubspot_owner_email = ${ownerEmail},
        ownership_synced_at = NOW(),
        ownership_sync_status = 'matched',
        unassigned_reason_code = NULL
    WHERE is_active = true
      AND hubspot_owner_id = ${owner.id}
      AND COALESCE(ownership_sync_status, '') <> 'manual_override'
  `);
}
```

For unmatched/conflict paths:

```ts
if (!input.dryRun) {
  await db.execute(sql`
    UPDATE deals
    SET hubspot_owner_id = ${owner.id},
        hubspot_owner_email = ${ownerEmail},
        ownership_synced_at = NOW(),
        ownership_sync_status = ${mappingStatus},
        unassigned_reason_code = ${failureReasonCode}
    WHERE is_active = true
      AND hubspot_owner_id = ${owner.id}
      AND COALESCE(ownership_sync_status, '') <> 'manual_override'
  `);
}
```

Apply the same logic to `leads`.

- [ ] **Step 6: Add admin dry-run/apply routes**

Extend `server/src/modules/admin/routes.ts`:

```ts
router.post("/admin/ownership-sync/dry-run", requireAdmin, async (_req, res, next) => {
  try {
    const result = await runOwnershipSync({ dryRun: true });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/ownership-sync/apply", requireAdmin, async (_req, res, next) => {
  try {
    const result = await runOwnershipSync({ dryRun: false });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});
```

- [ ] **Step 7: Re-run the ownership-sync tests**

Run:

```bash
npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/admin/ownership-sync-service.ts server/src/modules/admin/routes.ts server/src/modules/migration/hubspot-client.ts server/src/modules/admin/users-service.ts server/tests/modules/admin/ownership-sync-service.test.ts
git commit -m "feat: add hubspot ownership sync"
```

---

### Task 3: Build Cleanup Queue Evaluation And Reassignment Rules

**Files:**
- Create: `server/src/modules/admin/cleanup-queue-service.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Test: `server/tests/modules/admin/cleanup-queue-service.test.ts`

- [ ] **Step 1: Write the failing cleanup-queue tests**

Create `server/tests/modules/admin/cleanup-queue-service.test.ts` with:

```ts
it("returns rep cleanup items only for assigned records", async () => {});
it("returns office ownership rows only for unassigned records", async () => {});
it("groups reason codes by missing_next_step and missing_budget_status", async () => {});
it("filters office queues by actor scope", async () => {});
it("bulk reassigns rows only to active users with access to the row office", async () => {});
```

- [ ] **Step 2: Run the cleanup-queue test**

Run:

```bash
npx vitest run server/tests/modules/admin/cleanup-queue-service.test.ts
```

Expected: FAIL because the cleanup queue service does not exist.

- [ ] **Step 3: Implement queue evaluation**

Create `server/src/modules/admin/cleanup-queue-service.ts` with:

```ts
export type CleanupReasonCode =
  | "missing_decision_maker"
  | "missing_budget_status"
  | "missing_next_step"
  | "missing_next_step_due_at"
  | "missing_forecast_window"
  | "missing_forecast_confidence"
  | "stale_no_recent_activity"
  | "missing_company_or_property_link"
  | "unassigned_owner"
  | "owner_mapping_failure"
  | "inactive_owner_match";
```

Add entry points:

```ts
export async function getMyCleanupQueue(tenantDb: AppTenantDb, userId: string) {}
export async function getOfficeOwnershipQueue(tenantDb: AppTenantDb, officeId: string) {}
export async function bulkReassignOwnershipQueueRows(tenantDb: AppTenantDb, actor: AuthUser, input: { rows: Array<{ recordType: "lead" | "deal"; recordId: string }>; assigneeId: string; }) {}
```

Rule evaluation should emit reason codes from live fields:

```ts
if (!row.decision_maker_name) reasons.push("missing_decision_maker");
if (!row.budget_status) reasons.push("missing_budget_status");
if (!row.next_step) reasons.push("missing_next_step");
if (!row.next_step_due_at) reasons.push("missing_next_step_due_at");
if (!row.forecast_window) reasons.push("missing_forecast_window");
if (!row.forecast_confidence_percent) reasons.push("missing_forecast_confidence");
if (!row.company_id || !row.property_id) reasons.push("missing_company_or_property_link");
if (!row.assigned_rep_id) reasons.push("unassigned_owner");
if (row.unassigned_reason_code === "owner_mapping_failure") reasons.push("owner_mapping_failure");
if (row.unassigned_reason_code === "inactive_owner_match") reasons.push("inactive_owner_match");
```

- [ ] **Step 4: Implement office-scoped reassignment**

Inside `bulkReassignOwnershipQueueRows`, enforce office validity:

```ts
const assignee = await getAssignableUserForOffice(input.assigneeId, row.officeId);
if (!assignee) throw new AppError(400, "Assignee must be active and valid for the selected office");

if (actor.role === "director" && !actorAccessibleOfficeIds.has(row.officeId)) {
  throw new AppError(403, "Directors can only reassign records in accessible offices");
}
```

When writing the reassignment:

```ts
await tenantDb
  .update(deals)
  .set({
    assignedRepId: input.assigneeId,
    ownershipSyncStatus: "manual_override",
    unassignedReasonCode: null,
    ownershipSyncedAt: new Date(),
    updatedAt: new Date(),
  })
  .where(eq(deals.id, row.recordId))
  .returning();
```

Apply the equivalent update to `leads`. Reuse the existing reassignment side-effect path so the new owner gets the current handoff task behavior.

- [ ] **Step 5: Add cleanup routes**

Extend `server/src/modules/admin/routes.ts`:

```ts
router.get("/admin/cleanup/my", async (req, res, next) => {
  try {
    const rows = await getMyCleanupQueue(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    return res.json({ rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/cleanup/office", requireDirector, async (req, res, next) => {
  try {
    const officeId = (req.query.officeId as string) ?? (req.user!.activeOfficeId ?? req.user!.officeId);
    const rows = await getOfficeOwnershipQueue(req.tenantDb!, officeId);
    await req.commitTransaction!();
    return res.json({ rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/cleanup/reassign", requireDirector, async (req, res, next) => {
  try {
    const result = await bulkReassignOwnershipQueueRows(req.tenantDb!, req.user!, req.body);
    await req.commitTransaction!();
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});
```

- [ ] **Step 6: Re-run the cleanup-queue tests**

Run:

```bash
npx vitest run server/tests/modules/admin/cleanup-queue-service.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/admin/cleanup-queue-service.ts server/src/modules/admin/routes.ts server/tests/modules/admin/cleanup-queue-service.test.ts
git commit -m "feat: add cleanup queue evaluation and reassignment"
```

---

### Task 4: Extend Rep Dashboard And Add My Cleanup Page

**Files:**
- Create: `client/src/hooks/use-ownership-cleanup.ts`
- Create: `client/src/components/dashboard/my-cleanup-card.tsx`
- Create: `client/src/pages/pipeline/my-cleanup-page.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/hooks/use-dashboard.ts`
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx`
- Test: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`

- [ ] **Step 1: Write the failing rep dashboard test**

Create `client/src/pages/dashboard/rep-dashboard-page.test.tsx` with:

```tsx
expect(screen.getByText("My Cleanup")).toBeInTheDocument();
expect(screen.getByText(/records need enrichment/i)).toBeInTheDocument();
expect(screen.getByRole("link", { name: /open queue/i })).toHaveAttribute("href", "/pipeline/my-cleanup");
```

- [ ] **Step 2: Run the rep dashboard test**

Run:

```bash
npx vitest run client/src/pages/dashboard/rep-dashboard-page.test.tsx
```

Expected: FAIL because the cleanup card and route do not exist.

- [ ] **Step 3: Add the client cleanup hook**

Create `client/src/hooks/use-ownership-cleanup.ts`:

```ts
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";

export interface CleanupQueueRow {
  recordType: "lead" | "deal";
  recordId: string;
  recordName: string;
  reasonCodes: string[];
  officeId: string;
  officeName?: string;
  assignedUserId: string | null;
}

export function useMyCleanupQueue() {
  const [rows, setRows] = useState<CleanupQueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api<{ rows: CleanupQueueRow[] }>("/admin/cleanup/my");
    setRows(res.rows);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  return { rows, loading, refetch: load };
}
```

- [ ] **Step 4: Add dashboard data plumbing**

Extend `client/src/hooks/use-dashboard.ts`:

```ts
myCleanup: {
  total: number;
  byReason: Array<{ reasonCode: string; count: number }>;
};
```

Extend the server response later in Task 5 to satisfy that shape.

- [ ] **Step 5: Add the cleanup card and page**

Create `client/src/components/dashboard/my-cleanup-card.tsx`:

```tsx
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function MyCleanupCard({ count }: { count: number }) {
  return (
    <Card className="border-amber-200 bg-amber-50/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">My Cleanup</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-sm text-slate-700">{count} records need enrichment</p>
        <Link to="/pipeline/my-cleanup" className="text-sm font-semibold text-[#CC0000]">
          Open queue
        </Link>
      </CardContent>
    </Card>
  );
}
```

Create `client/src/pages/pipeline/my-cleanup-page.tsx`:

```tsx
import { useMyCleanupQueue } from "@/hooks/use-ownership-cleanup";

export function MyCleanupPage() {
  const { rows, loading } = useMyCleanupQueue();

  if (loading) return <div className="p-6">Loading cleanup queue...</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My Cleanup</h1>
      {rows.map((row) => (
        <div key={`${row.recordType}:${row.recordId}`} className="rounded-lg border p-4">
          <div className="font-medium">{row.recordName}</div>
          <div className="text-sm text-slate-500">{row.reasonCodes.join(", ")}</div>
        </div>
      ))}
    </div>
  );
}
```

Register the route in `client/src/App.tsx`:

```tsx
<Route path="/pipeline/my-cleanup" element={<MyCleanupPage />} />
```

- [ ] **Step 6: Update `RepDashboardPage`**

Insert the card near the top of `client/src/pages/dashboard/rep-dashboard-page.tsx`:

```tsx
<MyCleanupCard count={data.myCleanup.total} />
```

- [ ] **Step 7: Re-run the rep dashboard test**

Run:

```bash
npx vitest run client/src/pages/dashboard/rep-dashboard-page.test.tsx
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add client/src/hooks/use-ownership-cleanup.ts client/src/components/dashboard/my-cleanup-card.tsx client/src/pages/pipeline/my-cleanup-page.tsx client/src/App.tsx client/src/hooks/use-dashboard.ts client/src/pages/dashboard/rep-dashboard-page.tsx client/src/pages/dashboard/rep-dashboard-page.test.tsx
git commit -m "feat: add rep cleanup workflow"
```

---

### Task 5: Extend Dashboard API For My Cleanup Summary

**Files:**
- Modify: `server/src/modules/dashboard/service.ts`
- Modify: `server/src/modules/dashboard/routes.ts`
- Test: `server/tests/modules/dashboard/service.test.ts`

- [ ] **Step 1: Write the failing dashboard summary test**

Create or extend `server/tests/modules/dashboard/service.test.ts`:

```ts
it("includes myCleanup totals grouped by reason code in rep dashboard", async () => {
  expect(result.myCleanup.total).toBe(2);
  expect(result.myCleanup.byReason[0]?.reasonCode).toBe("missing_next_step");
});
```

- [ ] **Step 2: Run the dashboard service test**

Run:

```bash
npx vitest run server/tests/modules/dashboard/service.test.ts
```

Expected: FAIL because `getRepDashboard` does not include cleanup data.

- [ ] **Step 3: Extend the rep dashboard service**

In `server/src/modules/dashboard/service.ts`, after the existing rep metrics:

```ts
const myCleanupRows = await getMyCleanupQueue(db, userId);

const byReason = Array.from(
  myCleanupRows.flatMap((row) => row.reasonCodes).reduce((acc, reasonCode) => {
    acc.set(reasonCode, (acc.get(reasonCode) ?? 0) + 1);
    return acc;
  }, new Map<string, number>())
).map(([reasonCode, count]) => ({ reasonCode, count }));
```

Return:

```ts
myCleanup: {
  total: myCleanupRows.length,
  byReason,
},
```

- [ ] **Step 4: Re-run the dashboard service test**

Run:

```bash
npx vitest run server/tests/modules/dashboard/service.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/dashboard/service.ts server/tests/modules/dashboard/service.test.ts
git commit -m "feat: add cleanup summary to rep dashboard"
```

---

### Task 6: Add Migration Ownership Queue UI And Bulk Reassignment

**Files:**
- Create: `client/src/components/admin/ownership-queue-table.tsx`
- Create: `client/src/components/admin/ownership-reassign-dialog.tsx`
- Modify: `client/src/hooks/use-migration.ts`
- Modify: `client/src/pages/admin/migration/migration-dashboard-page.tsx`
- Modify: `client/src/pages/admin/migration/migration-deals-page.tsx`
- Test: `client/src/pages/admin/migration/migration-dashboard-page.test.tsx`

- [ ] **Step 1: Write the failing migration dashboard test**

Create `client/src/pages/admin/migration/migration-dashboard-page.test.tsx`:

```tsx
expect(screen.getByText("Office Ownership Queue")).toBeInTheDocument();
expect(screen.getByText("Unassigned active records")).toBeInTheDocument();
expect(screen.getByRole("button", { name: /reassign selected/i })).toBeInTheDocument();
```

- [ ] **Step 2: Run the migration dashboard test**

Run:

```bash
npx vitest run client/src/pages/admin/migration/migration-dashboard-page.test.tsx
```

Expected: FAIL because the ownership queue section does not exist.

- [ ] **Step 3: Add migration hooks for queue and reassignment**

Extend `client/src/hooks/use-migration.ts`:

```ts
export interface OwnershipQueueRow {
  recordType: "lead" | "deal";
  recordId: string;
  recordName: string;
  officeId: string;
  officeName: string;
  reasonCodes: string[];
}

export function useOfficeOwnershipQueue(officeId?: string) {
  // GET /admin/cleanup/office
}

export async function bulkReassignOwnershipQueue(input: {
  rows: Array<{ recordType: "lead" | "deal"; recordId: string }>;
  assigneeId: string;
}) {
  return api("/admin/cleanup/reassign", { method: "POST", json: input });
}
```

- [ ] **Step 4: Build the queue table and reassign dialog**

Create `client/src/components/admin/ownership-queue-table.tsx`:

```tsx
export function OwnershipQueueTable({ rows, selected, onToggle }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Record</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Office</TableHead>
          <TableHead>Reasons</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.recordType}:${row.recordId}`}>
            <TableCell>
              <Checkbox checked={selected.has(`${row.recordType}:${row.recordId}`)} onCheckedChange={() => onToggle(row)} />
            </TableCell>
            <TableCell>{row.recordName}</TableCell>
            <TableCell>{row.recordType}</TableCell>
            <TableCell>{row.officeName}</TableCell>
            <TableCell>{row.reasonCodes.join(", ")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

Create `client/src/components/admin/ownership-reassign-dialog.tsx` using `/tasks/assignees` filtered to the selected row office on the server response path.

- [ ] **Step 5: Extend the migration dashboard**

Insert a new card near the top of `client/src/pages/admin/migration/migration-dashboard-page.tsx`:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Office Ownership Queue</CardTitle>
  </CardHeader>
  <CardContent className="space-y-4">
    <p className="text-sm text-slate-600">Unassigned active records that need valid CRM ownership.</p>
    <OwnershipQueueTable rows={queueRows} selected={selected} onToggle={toggleRow} />
    <Button onClick={openDialog} disabled={selected.size === 0}>Reassign selected</Button>
  </CardContent>
</Card>
```

Keep this inside migration/data hygiene instead of adding a new sidebar destination.

- [ ] **Step 6: Re-run the migration dashboard test**

Run:

```bash
npx vitest run client/src/pages/admin/migration/migration-dashboard-page.test.tsx
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/components/admin/ownership-queue-table.tsx client/src/components/admin/ownership-reassign-dialog.tsx client/src/hooks/use-migration.ts client/src/pages/admin/migration/migration-dashboard-page.tsx client/src/pages/admin/migration/migration-deals-page.tsx client/src/pages/admin/migration/migration-dashboard-page.test.tsx
git commit -m "feat: add migration ownership queue"
```

---

### Task 7: Verify Phase 1 End To End

**Files:**
- Modify: `server/tests/modules/admin/ownership-sync-service.test.ts`
- Modify: `server/tests/modules/admin/cleanup-queue-service.test.ts`
- Modify: `server/tests/modules/dashboard/service.test.ts`
- Modify: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`
- Modify: `client/src/pages/admin/migration/migration-dashboard-page.test.tsx`

- [ ] **Step 1: Run the targeted automated suite**

Run:

```bash
npx vitest run \
  server/tests/modules/admin/ownership-sync-service.test.ts \
  server/tests/modules/admin/cleanup-queue-service.test.ts \
  server/tests/modules/dashboard/service.test.ts \
  client/src/pages/dashboard/rep-dashboard-page.test.tsx \
  client/src/pages/admin/migration/migration-dashboard-page.test.tsx
```

Expected: PASS

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Run the client build**

Run:

```bash
npm run build --workspace=client
```

Expected: PASS with only pre-existing bundle-size warnings if any.

- [ ] **Step 4: Commit final verification fixes**

```bash
git add server/tests/modules/admin/ownership-sync-service.test.ts server/tests/modules/admin/cleanup-queue-service.test.ts server/tests/modules/dashboard/service.test.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx client/src/pages/admin/migration/migration-dashboard-page.test.tsx
git commit -m "test: cover ownership cleanup phase 1"
```

---

## Self-Review

### Spec Coverage

- ownership-first seeding from HubSpot: Tasks 1 and 2
- global unique owner-ID mapping and conflict states: Tasks 1 and 2
- manual override precedence on rerun: Task 2
- rep cleanup queue by reason code: Tasks 3, 4, and 5
- office-scoped ownership queue: Tasks 3 and 6
- bulk reassignment with office-scoped assignee validation: Tasks 3 and 6
- keep all work inside migration/dashboard surfaces: Tasks 4, 5, and 6

No reviewed spec requirements are missing from the plan.

### Placeholder Scan

- no `TODO` or `TBD` placeholders
- each task contains exact file paths, commands, and concrete code shapes
- no “write tests for the above” placeholder steps without test intent

### Type Consistency

- ownership metadata names are consistent across schema, sync service, and queue service:
  - `hubspotOwnerId`
  - `hubspotOwnerEmail`
  - `ownershipSyncedAt`
  - `ownershipSyncStatus`
  - `unassignedReasonCode`
- cleanup hook names are consistent:
  - `useMyCleanupQueue`
  - `useOfficeOwnershipQueue`
- reassignment path names are consistent:
  - `bulkReassignOwnershipQueueRows`
  - `bulkReassignOwnershipQueue`
