# Manager Alerts and SLA Escalations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add office-aware manager alerts on top of the intervention system, including preview/send controls on `/admin/intervention-analytics`, weekday office-local scheduled delivery, and deterministic drill-ins back into `/admin/interventions`.

**Architecture:** Extend the existing intervention analytics stack rather than creating a parallel alerting system. Persist one latest manager-alert snapshot per office plus a send-ledger for dedupe, add AI-ops routes for preview/send, surface the snapshot on the analytics page, and add one worker job that evaluates office-local `8:00 AM` delivery windows.

**Tech Stack:** TypeScript, React, Express, Drizzle/Postgres tenant schemas, node-cron worker jobs, Vitest.

---

### Task 1: Sync the worktree to the merged intervention analytics baseline

**Files:**
- Verify: `client/src/App.tsx`
- Verify: `client/src/components/layout/sidebar.tsx`
- Verify: `client/src/pages/admin/admin-intervention-workspace-page.tsx`
- Verify after sync: `client/src/pages/admin/admin-intervention-analytics-page.tsx`
- Verify after sync: `client/src/hooks/use-intervention-analytics.ts`

- [ ] **Step 1: Confirm this worktree is missing the merged analytics slice**

Run:

```bash
rg --files client/src | rg 'intervention-analytics|admin-intervention'
```

Expected: only workspace files are present and the analytics page is missing.

- [ ] **Step 2: Bring the worktree up to current `main` before implementing**

Run:

```bash
git fetch origin
git rebase origin/main
```

Expected: the branch now contains the merged analytics/dashboard baseline.

- [ ] **Step 3: Verify the expected analytics files now exist**

Run:

```bash
rg --files client/src | rg 'intervention-analytics|admin-intervention'
```

Expected: includes:

```text
client/src/pages/admin/admin-intervention-analytics-page.tsx
client/src/hooks/use-intervention-analytics.ts
```

- [ ] **Step 4: Commit the baseline sync if the rebase produced local resolution commits**

```bash
git status --short
git commit -m "chore: sync manager alerts branch to intervention analytics baseline"
```

Expected: no unresolved conflicts remain.

### Task 2: Add schema support for manager-alert notifications and snapshot persistence

**Files:**
- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/schema/tenant/notifications.ts`
- Create: `shared/src/schema/tenant/ai-manager-alert-snapshots.ts`
- Create: `shared/src/schema/tenant/ai-manager-alert-send-ledger.ts`
- Modify: `shared/src/schema/index.ts`
- Create: `migrations/0029_ai_manager_alerts.sql`
- Test: `server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts`

- [ ] **Step 1: Write the failing service test for snapshot persistence and dedupe contract**

Add a test skeleton like:

```ts
it("persists one latest manager alert snapshot row per office and enforces one send ledger row per recipient per office-local day", async () => {
  const tenantDb = createTenantDb();
  const result = await persistManagerAlertSnapshot(tenantDb as any, {
    officeId: "office-1",
    snapshotKind: "manager_alert_summary",
    snapshotMode: "preview",
    scannedAt: new Date("2026-04-16T13:00:00.000Z"),
    payloadJson: { families: { overdueHighCritical: 2 } },
  });

  expect(result.snapshot.snapshotKind).toBe("manager_alert_summary");
  expect(result.snapshot.snapshotMode).toBe("preview");
});
```

- [ ] **Step 2: Run the focused test to verify the new schema/service primitives do not exist yet**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts
```

Expected: FAIL with missing schema/service exports.

- [ ] **Step 3: Add the new notification type**

Update `shared/src/types/enums.ts`:

```ts
export const NOTIFICATION_TYPES = [
  "stale_deal",
  "inbound_email",
  "task_assigned",
  "approval_needed",
  "activity_drop",
  "deal_won",
  "deal_lost",
  "stage_change",
  "touchpoint_alert",
  "manager_alert_summary",
  "system",
] as const;
```

- [ ] **Step 4: Add tenant snapshot and send-ledger schema files**

Create `shared/src/schema/tenant/ai-manager-alert-snapshots.ts`:

```ts
import { jsonb, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const aiManagerAlertSnapshotModeEnum = pgEnum("ai_manager_alert_snapshot_mode", ["preview", "sent"]);

export const aiManagerAlertSnapshots = pgTable(
  "ai_manager_alert_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").notNull(),
    snapshotKind: varchar("snapshot_kind", { length: 100 }).notNull(),
    snapshotMode: aiManagerAlertSnapshotModeEnum("snapshot_mode").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    payloadJson: jsonb("payload_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ai_manager_alert_snapshots_kind_uidx").on(table.officeId, table.snapshotKind),
  ]
);
```

Create `shared/src/schema/tenant/ai-manager-alert-send-ledger.ts`:

```ts
import { date, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const aiManagerAlertSendLedger = pgTable(
  "ai_manager_alert_send_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").notNull(),
    recipientUserId: uuid("recipient_user_id").notNull(),
    summaryType: varchar("summary_type", { length: 100 }).notNull(),
    officeLocalDate: date("office_local_date").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ai_manager_alert_send_ledger_uidx").on(
      table.officeId,
      table.recipientUserId,
      table.summaryType,
      table.officeLocalDate
    ),
  ]
);
```

- [ ] **Step 5: Export the new schema**

Add to `shared/src/schema/index.ts`:

```ts
export { aiManagerAlertSnapshots, aiManagerAlertSnapshotModeEnum } from "./tenant/ai-manager-alert-snapshots.js";
export { aiManagerAlertSendLedger } from "./tenant/ai-manager-alert-send-ledger.js";
```

- [ ] **Step 6: Add the tenant-scoped migration**

Create `migrations/0029_ai_manager_alerts.sql` with the same tenant-schema loop pattern as `0027`/`0028`:

```sql
DO $$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    EXECUTE format('
      CREATE TYPE %I.ai_manager_alert_snapshot_mode AS ENUM (''preview'', ''sent'')
    ', schema_name);

    EXECUTE format('
      CREATE TABLE %I.ai_manager_alert_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        office_id uuid NOT NULL,
        snapshot_kind varchar(100) NOT NULL,
        snapshot_mode %I.ai_manager_alert_snapshot_mode NOT NULL,
        scanned_at timestamptz NOT NULL,
        sent_at timestamptz,
        payload_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    ', schema_name, schema_name);

    EXECUTE format('
      CREATE UNIQUE INDEX ai_manager_alert_snapshots_kind_uidx
      ON %I.ai_manager_alert_snapshots (office_id, snapshot_kind)
    ', schema_name);

    EXECUTE format('
      CREATE TABLE %I.ai_manager_alert_send_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        office_id uuid NOT NULL,
        recipient_user_id uuid NOT NULL,
        summary_type varchar(100) NOT NULL,
        office_local_date date NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now()
      )
    ', schema_name);

    EXECUTE format('
      CREATE UNIQUE INDEX ai_manager_alert_send_ledger_uidx
      ON %I.ai_manager_alert_send_ledger (office_id, recipient_user_id, summary_type, office_local_date)
    ', schema_name);
  END LOOP;
END $$;
```

- [ ] **Step 7: Run the focused test again**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts
```

Expected: still FAIL, now on missing service implementation instead of missing schema symbols.

- [ ] **Step 8: Commit**

```bash
git add shared/src/types/enums.ts shared/src/schema/tenant/ai-manager-alert-snapshots.ts shared/src/schema/tenant/ai-manager-alert-send-ledger.ts shared/src/schema/index.ts migrations/0029_ai_manager_alerts.sql server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts
git commit -m "feat: add manager alert schema foundation"
```

### Task 3: Add office timezone support and due-office scheduling primitives

**Files:**
- Modify: `shared/src/schema/public/offices.ts`
- Modify: `server/src/modules/admin/offices-service.ts`
- Create: `server/src/lib/office-timezone.ts`
- Test: `server/tests/lib/office-timezone.test.ts`

- [ ] **Step 1: Write the failing timezone helper test**

```ts
import { describe, expect, it } from "vitest";
import { isOfficeLocalSendDue } from "../../src/lib/office-timezone.js";

describe("office-local manager alert scheduling", () => {
  it("fires at 8:00 AM in the office timezone", () => {
    const due = isOfficeLocalSendDue({
      timezone: "America/Chicago",
      nowUtc: new Date("2026-04-16T13:00:00.000Z"),
      targetHour: 8,
    });

    expect(due).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run server/tests/lib/office-timezone.test.ts
```

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Add explicit office timezone storage if missing**

Update `shared/src/schema/public/offices.ts` with a new field:

```ts
timezone: varchar("timezone", { length: 100 }).default("America/Chicago").notNull(),
```

Propagate it through any office admin service/input types in `server/src/modules/admin/offices-service.ts`.

- [ ] **Step 4: Implement timezone helper**

Create `server/src/lib/office-timezone.ts`:

```ts
export function isOfficeLocalSendDue(input: {
  timezone: string;
  nowUtc: Date;
  targetHour: number;
}) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timezone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(input.nowUtc).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour ?? "0");
  const minute = Number(parts.minute ?? "0");
  const weekday = parts.weekday;
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  return isWeekday && hour === input.targetHour && minute < 5;
}
```

- [ ] **Step 5: Run the timezone tests**

Run:

```bash
npx vitest run server/tests/lib/office-timezone.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/src/schema/public/offices.ts server/src/modules/admin/offices-service.ts server/src/lib/office-timezone.ts server/tests/lib/office-timezone.test.ts
git commit -m "feat: add office-local manager alert scheduling primitives"
```

### Task 4: Implement manager-alert snapshot generation and send transaction logic

**Files:**
- Create: `server/src/modules/ai-copilot/intervention-manager-alerts-service.ts`
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Test: `server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts`

- [ ] **Step 1: Expand the failing service test with the real alert families**

Add tests for:

```ts
it("builds overdue high/critical, snooze-breached, escalated-open, and assignee-overload families", async () => {
  const dashboard = await getManagerAlertSnapshot(tenantDb as any, {
    officeId: "office-1",
    timezone: "America/Chicago",
    now: new Date("2026-04-16T15:00:00.000Z"),
  });

  expect(dashboard.families.overdueHighCritical.count).toBe(2);
  expect(dashboard.families.snoozeBreached.count).toBe(1);
  expect(dashboard.families.escalatedOpen.count).toBe(1);
  expect(dashboard.families.assigneeOverload.count).toBe(1);
});
```

And transaction semantics:

```ts
it("rolls back the send ledger claim when notification creation fails", async () => {
  await expect(sendManagerAlertSummary(tenantDb as any, input)).rejects.toThrow();
  expect(tenantDb.state.sendLedger).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to capture the red state**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts
```

Expected: FAIL on missing service functions and payloads.

- [ ] **Step 3: Implement the manager-alert service**

Create `server/src/modules/ai-copilot/intervention-manager-alerts-service.ts` with:

```ts
import { and, eq, inArray, sql } from "drizzle-orm";
import { aiManagerAlertSendLedger, aiManagerAlertSnapshots, users } from "@trock-crm/shared/schema";
import { getInterventionAnalyticsDashboard } from "./intervention-service.js";
import { createNotification } from "../notifications/service.js";

const MANAGER_ALERT_SNAPSHOT_KIND = "manager_alert_summary";
const MANAGER_ALERT_NOTIFICATION_TYPE = "manager_alert_summary";

export async function getLatestManagerAlertSnapshot(...) { /* read persisted row */ }
export async function runManagerAlertPreview(...) { /* compute fresh + upsert preview snapshot */ }
export async function sendManagerAlertSummary(...) { /* tx: claim ledger, create notification, upsert sent snapshot */ }
export async function buildManagerAlertSnapshot(...) { /* deterministic family counts, queue links, assignee overload weights */ }
```

Include the exact overload weights from the spec and produce one normalized payload shape used by preview and send.

- [ ] **Step 4: Keep notification creation single-link**

The notification body should be plain text like:

```ts
const body = [
  "High-priority intervention pressure needs attention today.",
  `Overdue high/critical: ${snapshot.families.overdueHighCritical.count}.`,
  `Expired snoozes: ${snapshot.families.snoozeBreached.count}.`,
  `Unresolved escalations: ${snapshot.families.escalatedOpen.count}.`,
  `Assignee overload: ${snapshot.families.assigneeOverload.count}.`,
].join(" ");
```

And the single `link` should be:

```ts
const link = "/admin/intervention-analytics";
```

- [ ] **Step 5: Reuse the current intervention queue path builder**

Where the snapshot needs queue links, use the existing workspace link helpers from `use-admin-interventions` semantics, mirrored on the server as needed:

```ts
function buildInterventionQueueLink(input: {
  view?: "overdue" | "snooze-breached" | "escalated";
  severity?: "critical" | "high" | "medium" | "low";
  assigneeId?: string | null;
  caseId?: string | null;
}) { ... }
```

- [ ] **Step 6: Run the service tests**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/ai-copilot/intervention-manager-alerts-service.ts server/src/modules/ai-copilot/intervention-service.ts server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts
git commit -m "feat: add manager alert snapshot and send service"
```

### Task 5: Add AI-ops routes for latest snapshot, preview scan, and manual send

**Files:**
- Modify: `server/src/modules/ai-copilot/routes.ts`
- Test: `server/tests/modules/ai-copilot/routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests like:

```ts
it("returns the latest persisted manager alert snapshot", async () => {
  interventionManagerAlertMocks.getLatestManagerAlertSnapshot.mockResolvedValue({ snapshotMode: "preview" });
  const response = await request(app).get("/api/ai/ops/intervention-manager-alerts").expect(200);
  expect(response.body.snapshotMode).toBe("preview");
});

it("runs a preview-only manager alert scan", async () => {
  await request(app).post("/api/ai/ops/intervention-manager-alerts/scan").expect(200);
});

it("sends manager alerts manually", async () => {
  await request(app).post("/api/ai/ops/intervention-manager-alerts/send").expect(200);
});
```

- [ ] **Step 2: Run the route tests to confirm they fail**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/routes.test.ts
```

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Add the routes**

In `server/src/modules/ai-copilot/routes.ts` add:

```ts
router.get("/ops/intervention-manager-alerts", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const snapshot = await getLatestManagerAlertSnapshot(req.tenantDb!, {
      officeId: req.user!.officeId!,
    });
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

router.post("/ops/intervention-manager-alerts/scan", requireRole("admin", "director"), async (req, res, next) => {
  ...
});

router.post("/ops/intervention-manager-alerts/send", requireRole("admin", "director"), async (req, res, next) => {
  ...
});
```

- [ ] **Step 4: Run the route tests**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/routes.test.ts
```

Expected: PASS for the new manager-alert routes.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/ai-copilot/routes.ts server/tests/modules/ai-copilot/routes.test.ts
git commit -m "feat: add manager alert ai ops routes"
```

### Task 6: Add the analytics-page Manager Alerts panel and manual controls

**Files:**
- Modify: `client/src/hooks/use-ai-ops.ts`
- Create: `client/src/hooks/use-manager-alerts.ts`
- Create: `client/src/components/ai/manager-alerts-panel.tsx`
- Modify: `client/src/pages/admin/admin-intervention-analytics-page.tsx`
- Test: `client/src/hooks/use-manager-alerts.test.ts`
- Test: `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`

- [ ] **Step 1: Write the failing client tests**

```tsx
it("renders the manager alerts panel with latest snapshot counts", async () => {
  render(<AdminInterventionAnalyticsPage />);
  expect(await screen.findByText("Manager Alerts")).toBeInTheDocument();
  expect(screen.getByText("Run Manager Alert Scan")).toBeInTheDocument();
  expect(screen.getByText("Send Alerts")).toBeInTheDocument();
});
```

And hook tests:

```ts
it("calls preview and send endpoints", async () => {
  await runManagerAlertScan();
  await sendManagerAlerts();
  expect(apiMock).toHaveBeenCalledWith("/ai/ops/intervention-manager-alerts/scan", expect.anything());
  expect(apiMock).toHaveBeenCalledWith("/ai/ops/intervention-manager-alerts/send", expect.anything());
});
```

- [ ] **Step 2: Run the client tests to confirm they fail**

Run:

```bash
npx vitest run client/src/hooks/use-manager-alerts.test.ts client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: FAIL because the panel/hook do not exist.

- [ ] **Step 3: Add the client hook**

Create `client/src/hooks/use-manager-alerts.ts`:

```ts
import { api } from "../lib/api";

export async function fetchManagerAlerts() {
  return api("/ai/ops/intervention-manager-alerts");
}

export async function runManagerAlertScan() {
  return api("/ai/ops/intervention-manager-alerts/scan", { method: "POST" });
}

export async function sendManagerAlerts() {
  return api("/ai/ops/intervention-manager-alerts/send", { method: "POST" });
}
```

- [ ] **Step 4: Add the panel component**

Create `client/src/components/ai/manager-alerts-panel.tsx` that renders:

```tsx
<section className="rounded-xl border border-border/80 bg-white p-5 space-y-4">
  <div className="flex items-start justify-between gap-4">
    <div>
      <h2 className="text-lg font-semibold">Manager Alerts</h2>
      <p className="text-sm text-muted-foreground">Latest office alert snapshot for intervention pressure.</p>
    </div>
    <div className="flex gap-2">
      <Button variant="outline" onClick={onScan}>Run Manager Alert Scan</Button>
      <Button onClick={onSend}>Send Alerts</Button>
    </div>
  </div>
  {/* family cards + overloaded assignees + links */}
</section>
```

- [ ] **Step 5: Mount the panel on the analytics page**

Update `client/src/pages/admin/admin-intervention-analytics-page.tsx` to fetch the latest snapshot and render `<ManagerAlertsPanel />` above or alongside the existing SLA analytics sections.

- [ ] **Step 6: Run the client tests**

Run:

```bash
npx vitest run client/src/hooks/use-manager-alerts.test.ts client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/use-ai-ops.ts client/src/hooks/use-manager-alerts.ts client/src/components/ai/manager-alerts-panel.tsx client/src/pages/admin/admin-intervention-analytics-page.tsx client/src/hooks/use-manager-alerts.test.ts client/src/pages/admin/admin-intervention-analytics-page.test.tsx
git commit -m "feat: add manager alerts panel and controls"
```

### Task 7: Add worker job and office-local weekday scheduling

**Files:**
- Create: `worker/src/jobs/ai-intervention-manager-alerts.ts`
- Modify: `worker/src/jobs/index.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/tests/jobs/ai-intervention-manager-alerts.test.ts`

- [ ] **Step 1: Write the failing worker job test**

```ts
it("sends manager alerts for due offices at 8:00 AM local time and skips missing schemas", async () => {
  await runAiInterventionManagerAlerts({
    now: new Date("2026-04-16T13:00:00.000Z"),
  });

  expect(insertedNotifications).toHaveLength(2);
  expect(skippedSchemas).toContain("office_dfw");
});
```

- [ ] **Step 2: Run the worker test to confirm it fails**

Run:

```bash
npx vitest run worker/tests/jobs/ai-intervention-manager-alerts.test.ts
```

Expected: FAIL because the job does not exist.

- [ ] **Step 3: Implement the worker job**

Create `worker/src/jobs/ai-intervention-manager-alerts.ts`:

```ts
import { getPool } from "../db.js";
import { isOfficeLocalSendDue } from "../../server/src/lib/office-timezone.js";

export async function runAiInterventionManagerAlerts(input?: { now?: Date }) {
  const now = input?.now ?? new Date();
  // load active offices
  // skip missing tenant schemas
  // check timezone due window
  // call shared manager alert send service
}
```

Match the existing safe skip pattern from:

- `worker/src/jobs/ai-disconnect-digest.ts`
- `worker/src/jobs/ai-disconnect-escalation.ts`

- [ ] **Step 4: Register the job**

Update:

```ts
// worker/src/jobs/index.ts
registerJob("ai_intervention_manager_alerts", ...);
```

And schedule it in `worker/src/index.ts` with a frequent evaluator cron, for example every 5 minutes:

```ts
cron.schedule("*/5 * * * *", async () => {
  console.log("[Worker:cron] Running intervention manager alerts...");
  try {
    await runAiInterventionManagerAlerts();
  } catch (err) {
    console.error("[Worker:cron] Intervention manager alerts failed:", err);
  }
});
```

Do not hardcode the actual send timezone here; the office-local due helper decides which offices are due.

- [ ] **Step 5: Run the worker test**

Run:

```bash
npx vitest run worker/tests/jobs/ai-intervention-manager-alerts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/jobs/ai-intervention-manager-alerts.ts worker/src/jobs/index.ts worker/src/index.ts worker/tests/jobs/ai-intervention-manager-alerts.test.ts
git commit -m "feat: add scheduled manager alert worker job"
```

### Task 8: Full integration verification

**Files:**
- Verify: `server/src/modules/ai-copilot/intervention-manager-alerts-service.ts`
- Verify: `server/src/modules/ai-copilot/routes.ts`
- Verify: `client/src/pages/admin/admin-intervention-analytics-page.tsx`
- Verify: `worker/src/jobs/ai-intervention-manager-alerts.ts`

- [ ] **Step 1: Run the focused server/worker/client suites**

Run:

```bash
npx vitest run \
  server/tests/modules/ai-copilot/intervention-manager-alerts-service.test.ts \
  server/tests/modules/ai-copilot/routes.test.ts \
  worker/tests/jobs/ai-intervention-manager-alerts.test.ts \
  client/src/hooks/use-manager-alerts.test.ts \
  client/src/pages/admin/admin-intervention-analytics-page.test.tsx \
  --config client/vite.config.ts
```

Expected: PASS.

- [ ] **Step 2: Run workspace typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: no whitespace or patch corruption issues.

- [ ] **Step 4: Commit the final integration checkpoint**

```bash
git add .
git commit -m "feat: add manager alerts and sla escalations"
```

- [ ] **Step 5: Production validation checklist after merge**

Run after deploy:

```bash
node scripts/playwright-production-audit.mjs
```

Then manually verify:

- `/admin/intervention-analytics` shows `Manager Alerts`
- `Run Manager Alert Scan` updates latest snapshot without sending
- `Send Alerts` creates one `manager_alert_summary` notification per office recipient
- clicking the notification opens `/admin/intervention-analytics`
- alert family cards drill into the exact `/admin/interventions` filters
- duplicate same-day send is suppressed
- scheduled weekday office-local send works in a controlled office/time test

Expected: no crashes, no duplicate notifications, no queue-link drift.

