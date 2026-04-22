# HubSpot Ownership Seeding And Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed active leads and deals from HubSpot ownership, surface rep-scoped cleanup work, and expose director/admin ownership resolution queues without hiding unassigned records behind office placeholder owners.

**Architecture:** Extend the existing HubSpot migration/admin surface instead of building a parallel system. Add explicit ownership sync metadata to leads and deals, add a small public mapping table for HubSpot owner identity resolution, build a server-side cleanup evaluation service, and expose the resulting work in two places: rep-facing `My Cleanup` and admin/director ownership queues under migration/data scrub.

**Tech Stack:** PostgreSQL, Drizzle ORM, Express, React, TypeScript, Vitest, existing HubSpot migration client, existing dashboard/reporting hooks

---

## File Map

### Database / Schema

- Create: `migrations/0042_hubspot_ownership_seeding_and_cleanup.sql`
- Create: `shared/src/schema/public/hubspot-owner-mappings.ts`
- Modify: `shared/src/schema/public/index.ts`
- Modify: `shared/src/schema/index.ts`
- Modify: `shared/src/schema/tenant/deals.ts`
- Modify: `shared/src/schema/tenant/leads.ts`

### Server Ownership Sync / Cleanup

- Create: `server/src/modules/admin/ownership-sync-service.ts`
- Create: `server/src/modules/admin/cleanup-queue-service.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/admin/users-service.ts`
- Modify: `server/src/modules/migration/hubspot-client.ts`
- Test: `server/tests/modules/admin/ownership-sync-service.test.ts`
- Test: `server/tests/modules/admin/cleanup-queue-service.test.ts`

### Client Admin / Director Surfaces

- Create: `client/src/hooks/use-ownership-cleanup.ts`
- Create: `client/src/components/admin/ownership-queue-table.tsx`
- Modify: `client/src/pages/admin/migration/migration-dashboard-page.tsx`
- Modify: `client/src/pages/admin/migration/migration-deals-page.tsx`
- Test: `client/src/pages/admin/migration/migration-dashboard-page.test.tsx`

### Client Rep Surfaces

- Create: `client/src/components/dashboard/my-cleanup-card.tsx`
- Create: `client/src/pages/pipeline/my-cleanup-page.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx`
- Test: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`

### Verification

- Modify: `docs/superpowers/specs/2026-04-20-hubspot-ownership-seeding-and-cleanup-design.md` only if review uncovers a spec mismatch during implementation

---

### Task 1: Add Ownership Sync Schema

**Files:**
- Create: `migrations/0042_hubspot_ownership_seeding_and_cleanup.sql`
- Create: `shared/src/schema/public/hubspot-owner-mappings.ts`
- Modify: `shared/src/schema/public/index.ts`
- Modify: `shared/src/schema/index.ts`
- Modify: `shared/src/schema/tenant/deals.ts`
- Modify: `shared/src/schema/tenant/leads.ts`
- Test: `server/tests/modules/admin/ownership-sync-service.test.ts`

- [ ] **Step 1: Write the failing schema-facing test**

Add assertions in `server/tests/modules/admin/ownership-sync-service.test.ts` that expect the sync service to read and write:

```ts
expect(dealRow.hubspotOwnerId).toBe("12345");
expect(dealRow.hubspotOwnerEmail).toBe("rep@trock.dev");
expect(dealRow.ownershipSyncStatus).toBe("matched");
expect(dealRow.unassignedReasonCode).toBeNull();
```

- [ ] **Step 2: Run the targeted test to verify the new columns/types do not exist yet**

Run: `npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts`

Expected: FAIL with column, property, or import errors for ownership metadata.

- [ ] **Step 3: Add the SQL migration**

Create `migrations/0042_hubspot_ownership_seeding_and_cleanup.sql` with:

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

Define the new table in `shared/src/schema/public/hubspot-owner-mappings.ts`:

```ts
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

Extend `deals` and `leads` with:

```ts
hubspotOwnerId: varchar("hubspot_owner_id", { length: 64 }),
hubspotOwnerEmail: varchar("hubspot_owner_email", { length: 320 }),
ownershipSyncedAt: timestamp("ownership_synced_at", { withTimezone: true }),
ownershipSyncStatus: varchar("ownership_sync_status", { length: 32 }),
unassignedReasonCode: varchar("unassigned_reason_code", { length: 64 }),
```

- [ ] **Step 5: Re-run the targeted test**

Run: `npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts`

Expected: still FAIL, but now on missing service logic rather than missing schema.

- [ ] **Step 6: Commit**

```bash
git add migrations/0042_hubspot_ownership_seeding_and_cleanup.sql shared/src/schema/public/hubspot-owner-mappings.ts shared/src/schema/public/index.ts shared/src/schema/index.ts shared/src/schema/tenant/deals.ts shared/src/schema/tenant/leads.ts server/tests/modules/admin/ownership-sync-service.test.ts
git commit -m "feat: add ownership sync schema"
```

---

### Task 2: Build HubSpot Owner Mapping And Assignment Sync

**Files:**
- Create: `server/src/modules/admin/ownership-sync-service.ts`
- Modify: `server/src/modules/migration/hubspot-client.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Test: `server/tests/modules/admin/ownership-sync-service.test.ts`

- [ ] **Step 1: Expand the failing service test with the core assignment cases**

Add tests for:

```ts
it("assigns active deals when the HubSpot owner maps to a CRM user", async () => {});
it("marks active deals unassigned when the owner email does not map", async () => {});
it("does not assign inactive users", async () => {});
it("captures dry-run counts without mutating records", async () => {});
```

- [ ] **Step 2: Run the test to verify the service does not exist yet**

Run: `npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts`

Expected: FAIL with missing `runOwnershipSync` export or failed expectations.

- [ ] **Step 3: Extend HubSpot owner extraction if needed**

In `server/src/modules/migration/hubspot-client.ts`, keep `fetchAllOwners()` as the source of owner records and normalize the result shape for sync:

```ts
export interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}
```

Add a helper:

```ts
export function normalizeHubSpotOwnerEmail(owner: HubSpotOwner): string | null {
  return owner.email?.trim().toLowerCase() ?? null;
}
```

- [ ] **Step 4: Implement the sync service**

Create `server/src/modules/admin/ownership-sync-service.ts` with a service entry point like:

```ts
export async function runOwnershipSync(input: {
  dryRun?: boolean;
  officeId?: string;
}): Promise<{
  assigned: number;
  unchanged: number;
  unmatched: number;
  inactiveUserConflicts: number;
}> { /* ... */ }
```

Core logic:

```ts
const owners = await fetchAllOwners();
const usersByEmail = new Map(activeUsers.map((u) => [u.email.toLowerCase(), u]));

for (const owner of owners) {
  const email = normalizeHubSpotOwnerEmail(owner);
  const mappedUser = email ? usersByEmail.get(email) : null;

  await upsertHubspotOwnerMapping({
    hubspotOwnerId: owner.id,
    hubspotOwnerEmail: email,
    userId: mappedUser?.id ?? null,
    mappingStatus: mappedUser ? "matched" : "unmatched",
    failureReasonCode: mappedUser ? null : "owner_mapping_failure",
  });
}
```

Then update active tenant records:

```ts
await db.execute(sql`
  UPDATE deals
  SET assigned_rep_id = ${userId},
      hubspot_owner_id = ${ownerId},
      hubspot_owner_email = ${ownerEmail},
      ownership_synced_at = NOW(),
      ownership_sync_status = 'matched',
      unassigned_reason_code = NULL
  WHERE is_active = true
    AND hubspot_owner_id = ${ownerId}
`);
```

And unmatched path:

```ts
await db.execute(sql`
  UPDATE deals
  SET hubspot_owner_id = ${ownerId},
      hubspot_owner_email = ${ownerEmail},
      ownership_synced_at = NOW(),
      ownership_sync_status = 'unmatched',
      unassigned_reason_code = 'owner_mapping_failure'
  WHERE is_active = true
    AND hubspot_owner_id = ${ownerId}
`);
```

Apply the same model to `leads`.

- [ ] **Step 5: Add admin routes for dry-run and apply**

Add routes in `server/src/modules/admin/routes.ts`:

```ts
router.post("/admin/ownership-sync/dry-run", authMiddleware, requireRole(["admin"]), async (_req, res) => {
  res.json(await runOwnershipSync({ dryRun: true }));
});

router.post("/admin/ownership-sync/apply", authMiddleware, requireRole(["admin"]), async (_req, res) => {
  res.json(await runOwnershipSync({ dryRun: false }));
});
```

- [ ] **Step 6: Run the targeted test until it passes**

Run: `npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/admin/ownership-sync-service.ts server/src/modules/admin/routes.ts server/src/modules/migration/hubspot-client.ts server/tests/modules/admin/ownership-sync-service.test.ts
git commit -m "feat: sync ownership from hubspot owners"
```

---

### Task 3: Build Cleanup Queue Evaluation

**Files:**
- Create: `server/src/modules/admin/cleanup-queue-service.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Test: `server/tests/modules/admin/cleanup-queue-service.test.ts`

- [ ] **Step 1: Write the failing cleanup rules test**

Add tests covering:

```ts
it("returns my cleanup items for the assigned rep only", async () => {});
it("returns office ownership queue items for unassigned records", async () => {});
it("emits missing_next_step and missing_budget_status reason codes", async () => {});
it("omits records once the missing data is fixed", async () => {});
```

- [ ] **Step 2: Run the cleanup test to verify the service is missing**

Run: `npx vitest run server/tests/modules/admin/cleanup-queue-service.test.ts`

Expected: FAIL with missing module or missing reason codes.

- [ ] **Step 3: Implement rule evaluation**

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
  | "owner_mapping_failure";
```

Add entry points:

```ts
export async function getMyCleanupQueue(userId: string): Promise<CleanupQueueItem[]> { /* ... */ }
export async function getOfficeOwnershipQueue(officeId: string): Promise<CleanupQueueItem[]> { /* ... */ }
export async function getGlobalOwnershipExceptions(): Promise<CleanupQueueItem[]> { /* ... */ }
```

Rule example:

```ts
if (!row.next_step) reasons.push("missing_next_step");
if (!row.next_step_due_at) reasons.push("missing_next_step_due_at");
if (!row.budget_status) reasons.push("missing_budget_status");
if (!row.assigned_rep_id) reasons.push("unassigned_owner");
if (row.unassigned_reason_code === "owner_mapping_failure") reasons.push("owner_mapping_failure");
```

- [ ] **Step 4: Add API routes for each queue**

In `server/src/modules/admin/routes.ts`:

```ts
router.get("/admin/cleanup/my", authMiddleware, async (req, res) => {
  res.json(await getMyCleanupQueue(req.user!.id));
});

router.get("/admin/cleanup/office", authMiddleware, requireRole(["director", "admin"]), async (req, res) => {
  res.json(await getOfficeOwnershipQueue(req.user!.officeId));
});

router.get("/admin/cleanup/exceptions", authMiddleware, requireRole(["admin"]), async (_req, res) => {
  res.json(await getGlobalOwnershipExceptions());
});
```

- [ ] **Step 5: Run the cleanup test**

Run: `npx vitest run server/tests/modules/admin/cleanup-queue-service.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/admin/cleanup-queue-service.ts server/src/modules/admin/routes.ts server/tests/modules/admin/cleanup-queue-service.test.ts
git commit -m "feat: add cleanup queue evaluation"
```

---

### Task 4: Add Director/Admin Reassignment Actions

**Files:**
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/admin/users-service.ts`
- Test: `server/tests/modules/admin/ownership-sync-service.test.ts`

- [ ] **Step 1: Add the failing reassignment tests**

Cover:

```ts
it("allows directors to reassign unassigned records within their office", async () => {});
it("blocks directors from cross-office reassignment", async () => {});
it("allows admins to reassign across offices", async () => {});
```

- [ ] **Step 2: Run the ownership test file and confirm reassignment failures**

Run: `npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts`

Expected: FAIL on missing reassignment route/service.

- [ ] **Step 3: Add reassignment route logic**

In `server/src/modules/admin/routes.ts`:

```ts
router.post("/admin/cleanup/reassign", authMiddleware, requireRole(["director", "admin"]), async (req, res) => {
  const { recordType, recordId, userId } = req.body;
  res.json(await reassignCleanupRecord(req.user!, { recordType, recordId, userId }));
});
```

Implement office guard checks:

```ts
if (actor.role === "director" && targetUser.officeId !== actor.officeId) {
  throw new AppError(403, "Directors can only assign within their office");
}
```

- [ ] **Step 4: Re-run the ownership test file**

Run: `npx vitest run server/tests/modules/admin/ownership-sync-service.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/admin/routes.ts server/src/modules/admin/users-service.ts server/tests/modules/admin/ownership-sync-service.test.ts
git commit -m "feat: add ownership reassignment actions"
```

---

### Task 5: Build Rep Cleanup UI

**Files:**
- Create: `client/src/hooks/use-ownership-cleanup.ts`
- Create: `client/src/components/dashboard/my-cleanup-card.tsx`
- Create: `client/src/pages/pipeline/my-cleanup-page.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx`
- Test: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`

- [ ] **Step 1: Write the failing rep dashboard test**

Add assertions like:

```tsx
expect(screen.getByText("My Cleanup")).toBeInTheDocument();
expect(screen.getByText("3 records need enrichment")).toBeInTheDocument();
expect(screen.getByRole("link", { name: /open cleanup queue/i })).toHaveAttribute("href", "/pipeline/my-cleanup");
```

- [ ] **Step 2: Run the dashboard test**

Run: `npx vitest run client/src/pages/dashboard/rep-dashboard-page.test.tsx`

Expected: FAIL because the cleanup card and route do not exist.

- [ ] **Step 3: Add the hook**

Create `client/src/hooks/use-ownership-cleanup.ts`:

```ts
export function useMyCleanupQueue() {
  return useApiQuery<CleanupQueueItem[]>("/api/admin/cleanup/my");
}

export function useOfficeOwnershipQueue() {
  return useApiQuery<CleanupQueueItem[]>("/api/admin/cleanup/office");
}
```

- [ ] **Step 4: Add the rep dashboard card**

Create `client/src/components/dashboard/my-cleanup-card.tsx`:

```tsx
export function MyCleanupCard({ count }: { count: number }) {
  return (
    <Card className="border-amber-200 bg-amber-50/50">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">My Cleanup</p>
            <p className="text-sm text-slate-600">{count} records need enrichment</p>
          </div>
          <Link to="/pipeline/my-cleanup" className="text-sm font-medium text-[#CC0000]">
            Open queue
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Add the dedicated rep page and route**

Create `client/src/pages/pipeline/my-cleanup-page.tsx` and register it in `client/src/App.tsx`:

```tsx
<Route path="/pipeline/my-cleanup" element={<RequireRole allowedRoles={["rep", "director", "admin"]}><MyCleanupPage /></RequireRole>} />
```

Keep the sidebar consolidated by not adding a new top-level nav item; link to it from the dashboard card and existing parent pages only.

- [ ] **Step 6: Re-run the rep dashboard test**

Run: `npx vitest run client/src/pages/dashboard/rep-dashboard-page.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/use-ownership-cleanup.ts client/src/components/dashboard/my-cleanup-card.tsx client/src/pages/pipeline/my-cleanup-page.tsx client/src/App.tsx client/src/pages/dashboard/rep-dashboard-page.tsx client/src/pages/dashboard/rep-dashboard-page.test.tsx
git commit -m "feat: add rep cleanup workflow"
```

---

### Task 6: Build Migration Ownership Queue UI

**Files:**
- Create: `client/src/components/admin/ownership-queue-table.tsx`
- Modify: `client/src/pages/admin/migration/migration-dashboard-page.tsx`
- Modify: `client/src/pages/admin/migration/migration-deals-page.tsx`
- Test: `client/src/pages/admin/migration/migration-dashboard-page.test.tsx`

- [ ] **Step 1: Write the failing migration dashboard test**

Add assertions like:

```tsx
expect(screen.getByText("Office Ownership Queue")).toBeInTheDocument();
expect(screen.getByText("Unassigned active records")).toBeInTheDocument();
expect(screen.getByRole("button", { name: /reassign/i })).toBeInTheDocument();
```

- [ ] **Step 2: Run the migration dashboard test**

Run: `npx vitest run client/src/pages/admin/migration/migration-dashboard-page.test.tsx`

Expected: FAIL because the ownership queue section does not exist.

- [ ] **Step 3: Build the shared queue table**

Create `client/src/components/admin/ownership-queue-table.tsx`:

```tsx
export function OwnershipQueueTable({ rows, onReassign }: Props) {
  return (
    <table className="w-full">
      <thead>...</thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.recordType}:${row.recordId}`}>
            <td>{row.recordName}</td>
            <td>{row.reasonCode}</td>
            <td>{row.officeName}</td>
            <td><Button onClick={() => onReassign(row)}>Reassign</Button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Add the new migration sections**

Extend `client/src/pages/admin/migration/migration-dashboard-page.tsx` with:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Office Ownership Queue</CardTitle>
  </CardHeader>
  <CardContent>
    <OwnershipQueueTable rows={officeQueue} onReassign={openReassignDialog} />
  </CardContent>
</Card>
```

Keep `Pipeline Hygiene` in the `Data Hygiene` destination card, but add ownership resolution as the first migration action below the summary cards.

- [ ] **Step 5: Re-run the migration dashboard test**

Run: `npx vitest run client/src/pages/admin/migration/migration-dashboard-page.test.tsx`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/components/admin/ownership-queue-table.tsx client/src/pages/admin/migration/migration-dashboard-page.tsx client/src/pages/admin/migration/migration-deals-page.tsx client/src/pages/admin/migration/migration-dashboard-page.test.tsx
git commit -m "feat: add ownership queue to migration"
```

---

### Task 7: Add End-To-End Verification And Deploy Checks

**Files:**
- Modify: `server/tests/modules/admin/ownership-sync-service.test.ts`
- Modify: `server/tests/modules/admin/cleanup-queue-service.test.ts`
- Modify: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`
- Modify: `client/src/pages/admin/migration/migration-dashboard-page.test.tsx`

- [ ] **Step 1: Run the targeted automated suite**

Run:

```bash
npx vitest run \
  server/tests/modules/admin/ownership-sync-service.test.ts \
  server/tests/modules/admin/cleanup-queue-service.test.ts \
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

- [ ] **Step 3: Run the client production build**

Run:

```bash
npm run build --workspace=client
```

Expected: PASS with only pre-existing chunk-size warnings.

- [ ] **Step 4: Commit final verification-only fixes**

```bash
git add server/tests/modules/admin/ownership-sync-service.test.ts server/tests/modules/admin/cleanup-queue-service.test.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx client/src/pages/admin/migration/migration-dashboard-page.test.tsx
git commit -m "test: cover ownership seeding cleanup flows"
```

---

## Self-Review

### Spec Coverage

- ownership-first seeding: Tasks 1 and 2
- explicit unmatched/unassigned handling: Tasks 2, 3, and 4
- rep-scoped cleanup queue: Tasks 3 and 5
- director/admin office queue: Tasks 3, 4, and 6
- global exceptions: Task 3
- migration/data scrub extension instead of parallel tool: Task 6
- reporting/landing counts: Tasks 3, 5, and 6

No spec gaps remain for the first implementation slice.

### Placeholder Scan

- no `TODO` or `TBD` placeholders
- each task includes exact files, commands, and intended code shape
- no “write tests for above” style placeholder steps

### Type Consistency

- ownership metadata names are consistent across schema, service, and queue tasks:
  - `hubspotOwnerId`
  - `hubspotOwnerEmail`
  - `ownershipSyncedAt`
  - `ownershipSyncStatus`
  - `unassignedReasonCode`
- queue entry point names are consistent:
  - `getMyCleanupQueue`
  - `getOfficeOwnershipQueue`
  - `getGlobalOwnershipExceptions`
