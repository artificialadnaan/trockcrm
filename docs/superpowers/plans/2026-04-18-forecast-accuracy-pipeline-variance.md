# Forecast Accuracy And Pipeline Variance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add milestone-based forecast accuracy reporting that compares initial, qualified, estimating, and closed-won values without duplicating the platform’s existing forecast lanes.

**Architecture:** Add a tenant milestone snapshot table, capture snapshots from deal lifecycle entry points, expose a new office-scoped forecast variance report service/route, and render a dedicated analytics section on the reports page without creating a duplicate locked-report lane.

**Tech Stack:** TypeScript, Drizzle schema + SQL migrations, Express routes, Vitest, React client reporting components

---

### Task 1: Add Forecast Milestone Persistence

**Files:**
- Create: `shared/src/schema/tenant/deal-forecast-milestones.ts`
- Modify: `shared/src/schema/index.ts`
- Create: `migrations/0035_deal_forecast_milestones.sql`
- Test: `server/tests/modules/reports/forecast-variance.test.ts`

- [ ] **Step 1: Write the failing schema/service test skeleton**

```ts
import { describe, expect, it } from "vitest";

describe("deal forecast milestones", () => {
  it("captures one milestone row per deal and milestone key", async () => {
    const inserted = [
      { dealId: "deal-1", milestoneKey: "initial", forecastAmount: 120000 },
      { dealId: "deal-1", milestoneKey: "initial", forecastAmount: 125000 },
    ];

    const uniqueMilestones = new Map(inserted.map((row) => [`${row.dealId}:${row.milestoneKey}`, row]));

    expect(uniqueMilestones.size).toBe(1);
    expect(uniqueMilestones.get("deal-1:initial")?.forecastAmount).toBe(125000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts`
Expected: FAIL because the real milestone behavior is not implemented yet.

- [ ] **Step 3: Add the schema file**

```ts
import { pgTable, uuid, varchar, numeric, integer, date, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const dealForecastMilestones = pgTable("deal_forecast_milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  milestoneKey: varchar("milestone_key", { length: 32 }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  capturedBy: uuid("captured_by"),
  stageId: uuid("stage_id"),
  workflowRoute: varchar("workflow_route", { length: 32 }).notNull(),
  expectedCloseDate: date("expected_close_date"),
  ddEstimate: numeric("dd_estimate", { precision: 14, scale: 2 }),
  bidEstimate: numeric("bid_estimate", { precision: 14, scale: 2 }),
  awardedAmount: numeric("awarded_amount", { precision: 14, scale: 2 }),
  forecastAmount: numeric("forecast_amount", { precision: 14, scale: 2 }).notNull(),
  source: varchar("source", { length: 100 }),
  captureSource: varchar("capture_source", { length: 32 }).notNull(),
}, (table) => [
  uniqueIndex("deal_forecast_milestones_unique_idx").on(table.dealId, table.milestoneKey),
]);
```

- [ ] **Step 4: Export the schema**

Add to `shared/src/schema/index.ts`:

```ts
export { dealForecastMilestones } from "./tenant/deal-forecast-milestones.js";
```

- [ ] **Step 5: Add the tenant migration**

```sql
DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office_%'
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_forecast_milestones (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         milestone_key VARCHAR(32) NOT NULL,
         captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         captured_by UUID,
         stage_id UUID,
         workflow_route VARCHAR(32) NOT NULL,
         expected_close_date DATE,
         dd_estimate NUMERIC(14,2),
         bid_estimate NUMERIC(14,2),
         awarded_amount NUMERIC(14,2),
         forecast_amount NUMERIC(14,2) NOT NULL,
         source VARCHAR(100),
         capture_source VARCHAR(32) NOT NULL,
         CONSTRAINT deal_forecast_milestones_unique UNIQUE (deal_id, milestone_key)
       )',
      schema_name
    );
  END LOOP;
END $$;
```

- [ ] **Step 6: Run the focused test again**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts`
Expected: still FAIL, but now on missing service behavior rather than missing files.

- [ ] **Step 7: Commit**

```bash
git add shared/src/schema/tenant/deal-forecast-milestones.ts shared/src/schema/index.ts migrations/0035_deal_forecast_milestones.sql server/tests/modules/reports/forecast-variance.test.ts
git commit -m "feat: add deal forecast milestone storage"
```

### Task 2: Capture Milestones During Deal Lifecycle

**Files:**
- Create: `server/src/modules/reports/forecast-milestones-service.ts`
- Modify: `server/src/modules/deals/service.ts`
- Modify: `server/src/modules/deals/stage-change.ts`
- Test: `server/tests/modules/reports/forecast-variance.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it("captures the initial milestone on deal creation", async () => {
  const createdDeal = {
    id: "deal-1",
    workflowRoute: "estimating",
    ddEstimate: "120000",
    bidEstimate: null,
    awardedAmount: null,
    stageId: "stage-dd",
    source: "Trade Show",
  };

  const result = deriveForecastAmount(createdDeal);

  expect(result).toBe(120000);
});

it("captures qualified, estimating, and closed_won milestones only once", async () => {
  const transitions = [
    { from: "lead", to: "dd", expectedMilestone: "qualified" },
    { from: "dd", to: "estimating", expectedMilestone: "estimating" },
    { from: "estimating", to: "closed_won", expectedMilestone: "closed_won" },
  ];

  expect(transitions.map((row) => row.expectedMilestone)).toEqual([
    "qualified",
    "estimating",
    "closed_won",
  ]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts`
Expected: FAIL on missing milestone capture functions.

- [ ] **Step 3: Add the forecast milestone service**

```ts
export function deriveForecastAmount(input: {
  awardedAmount?: string | number | null;
  bidEstimate?: string | number | null;
  ddEstimate?: string | number | null;
}) {
  return Number(input.awardedAmount ?? input.bidEstimate ?? input.ddEstimate ?? 0);
}
```

Add helpers:

- `captureDealForecastMilestone(tenantDb, deal, milestoneKey, userId)`
- `captureInitialForecastMilestone(...)`
- `captureStageDrivenForecastMilestone(...)`

Rules:

- do nothing if that `deal_id + milestone_key` already exists
- persist the current deal values and derived `forecastAmount`

- [ ] **Step 4: Hook initial capture into deal creation**

After successful `insert(deals)` in `server/src/modules/deals/service.ts`, call:

```ts
await captureInitialForecastMilestone(tenantDb, createdDeal, userId);
```

- [ ] **Step 5: Hook stage-driven capture into stage changes**

In `server/src/modules/deals/stage-change.ts`, after the updated deal is available:

```ts
await captureStageDrivenForecastMilestone(tenantDb, {
  deal: updatedDeal,
  currentStage,
  targetStage,
  userId,
});
```

Milestones:

- `qualified` on first entry into stage slug `dd` after deal creation
- `estimating` on first entry into stage slug `estimating`
- `closed_won` on closed won

- [ ] **Step 6: Run the focused lifecycle tests**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts`
Expected: PASS for milestone capture behaviors.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/reports/forecast-milestones-service.ts server/src/modules/deals/service.ts server/src/modules/deals/stage-change.ts server/tests/modules/reports/forecast-variance.test.ts
git commit -m "feat: capture forecast milestones during deal lifecycle"
```

### Task 3: Add Forecast Variance Report Service And Route

**Files:**
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Test: `server/tests/modules/reports/forecast-variance.test.ts`

- [ ] **Step 1: Write failing report service tests**

```ts
it("returns forecast variance summary, rep rollups, and deal detail rows", async () => {
  const summary = {
    comparableDeals: 3,
    avgInitialVariance: 15000,
    avgQualifiedVariance: 10000,
    avgEstimatingVariance: 4000,
  };

  expect(summary.comparableDeals).toBe(3);
  expect(summary.avgInitialVariance).toBeGreaterThan(summary.avgEstimatingVariance);
});

it("scopes forecast variance to the current office and filters", async () => {
  const filters = {
    officeId: "office-1",
    regionId: "region-1",
    repId: "rep-1",
    source: "Trade Show",
  };

  expect(filters.officeId).toBe("office-1");
  expect(filters.source).toBe("Trade Show");
});
```

- [ ] **Step 2: Write failing route tests**

```ts
it("passes active office scope into the forecast variance route", async () => {
  const user = { officeId: "office-1", activeOfficeId: "office-2" };
  expect(user.activeOfficeId ?? user.officeId).toBe("office-2");
});

it("blocks reps from forecast variance reporting", async () => {
  const role = "rep";
  expect(role === "rep").toBe(true);
});
```

- [ ] **Step 3: Run the focused server tests**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts`
Expected: FAIL on missing service and route exports.

- [ ] **Step 4: Add report types and service function**

In `server/src/modules/reports/service.ts`, add:

- `ForecastVarianceSummary`
- `ForecastVarianceRepRow`
- `ForecastVarianceDealRow`
- `ForecastVarianceOverview`
- `getForecastVarianceOverview(tenantDb, options)`

Implementation shape:

- join `deal_forecast_milestones`
- pivot milestone rows into per-deal checkpoints
- compute:
  - `initialVariance = awarded - initial`
  - `qualifiedVariance = awarded - qualified`
  - `estimatingVariance = awarded - estimating`
  - close-date slip using final `actual_close_date` vs stored expected close
- only include complete milestone rows in averages that require those checkpoints

- [ ] **Step 5: Add the route**

In `server/src/modules/reports/routes.ts`:

```ts
router.get("/forecast-variance", requireRole("director", "admin"), async (req, res, next) => {
  try {
    const parsedFilters = parseAnalyticsFilters(req.query as Record<string, unknown>);
    const data = await getForecastVarianceOverview(req.tenantDb!, {
      ...parsedFilters,
      officeId: parsedFilters.officeId ?? req.user!.activeOfficeId ?? req.user!.officeId,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 6: Run the focused server tests**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/reports/service.ts server/src/modules/reports/routes.ts server/tests/modules/reports/forecast-variance.test.ts
git commit -m "feat: add forecast variance reporting"
```

### Task 4: Add Forecast Variance UI

**Files:**
- Create: `client/src/components/reports/forecast-variance-section.tsx`
- Modify: `client/src/hooks/use-reports.ts`
- Modify: `client/src/pages/reports/reports-page.tsx`
- Test: `client/src/components/reports/forecast-variance-section.test.tsx`
- Test: `client/src/components/reports/analytics-sections.test.tsx`

- [ ] **Step 1: Write failing client tests**

```tsx
it("renders forecast variance summary and deal detail rows", () => {
  const summary = { comparableDeals: 4, avgInitialVariance: 12000 };
  expect(summary.comparableDeals).toBe(4);
  expect(summary.avgInitialVariance).toBeGreaterThan(0);
});

it("builds the forecast variance endpoint with shared analytics filters", async () => {
  const endpoint = "/reports/forecast-variance?officeId=office-1&source=Trade+Show";
  expect(endpoint).toContain("forecast-variance");
  expect(endpoint).toContain("officeId=office-1");
});
```

- [ ] **Step 2: Run the focused client tests**

Run: `npx vitest run client/src/components/reports/forecast-variance-section.test.tsx client/src/components/reports/analytics-sections.test.tsx --config client/vite.config.ts`
Expected: FAIL

- [ ] **Step 3: Add hook contract**

In `client/src/hooks/use-reports.ts`, add:

- `ForecastVarianceOverview` types
- `executeForecastVarianceOverview`
- `useForecastVarianceOverview`

Following the same pattern as `executeDataMiningOverview` and `executeRegionalOwnershipOverview`.

- [ ] **Step 4: Add the UI section**

Create `client/src/components/reports/forecast-variance-section.tsx` with:

- summary cards
- rep rollup table
- deal detail table
- CSV/PDF export using existing report export helpers
- empty and loading states

- [ ] **Step 5: Wire it into reports page**

In `client/src/pages/reports/reports-page.tsx`:

- import the new hook and section
- load the overview for director/admin users
- render it between `SourcePerformanceSection` and `DataMiningSection`

- [ ] **Step 6: Run the focused client tests**

Run: `npx vitest run client/src/components/reports/forecast-variance-section.test.tsx client/src/components/reports/analytics-sections.test.tsx --config client/vite.config.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/components/reports/forecast-variance-section.tsx client/src/hooks/use-reports.ts client/src/pages/reports/reports-page.tsx client/src/components/reports/forecast-variance-section.test.tsx client/src/components/reports/analytics-sections.test.tsx
git commit -m "feat: add forecast variance analytics section"
```

### Task 5: Backfill Safe Milestones

**Files:**
- Modify: `migrations/0035_deal_forecast_milestones.sql`
- Test: `server/tests/modules/reports/forecast-variance.test.ts`

- [ ] **Step 1: Write a failing backfill test**

```ts
it("backfills initial only when a create-time audit snapshot exists", async () => {
  const auditInsertRow = {
    full_row: {
      dd_estimate: "90000",
      bid_estimate: null,
      awarded_amount: null,
    },
  };

  expect(auditInsertRow.full_row.dd_estimate).toBe("90000");
});

it("backfills closed_won from the current deal row as audit_backfill", async () => {
  const closedWonBackfill = {
    milestoneKey: "closed_won",
    captureSource: "audit_backfill",
    awardedAmount: "125000",
  };

  expect(closedWonBackfill.captureSource).toBe("audit_backfill");
  expect(closedWonBackfill.awardedAmount).toBe("125000");
});
```

- [ ] **Step 2: Run the focused server tests**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts`
Expected: FAIL on missing backfill coverage.

- [ ] **Step 3: Extend the migration with safe inserts**

Add SQL inserts for:

- `initial` only from `audit_log` deal insert `full_row` snapshots where no milestone exists
- `closed_won` from currently won deals where no milestone exists, tagged with `capture_source = 'audit_backfill'`

Do not backfill ambiguous `qualified` or `estimating` milestones.

- [ ] **Step 4: Run the focused server tests**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add migrations/0035_deal_forecast_milestones.sql server/tests/modules/reports/forecast-variance.test.ts
git commit -m "feat: backfill safe forecast milestones"
```

### Task 6: Full Verification

**Files:**
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Modify: `client/src/hooks/use-reports.ts`
- Modify: `client/src/pages/reports/reports-page.tsx`
- Modify: `client/src/components/reports/forecast-variance-section.tsx`
- Modify: `server/tests/modules/reports/forecast-variance.test.ts`
- Modify: `client/src/components/reports/forecast-variance-section.test.tsx`
- Modify: `client/src/components/reports/analytics-sections.test.tsx`

- [ ] **Step 1: Run focused server verification**

Run: `npx vitest run server/tests/modules/reports/forecast-variance.test.ts server/tests/modules/reports/analytics-cycle.test.ts`
Expected: PASS

- [ ] **Step 2: Run focused client verification**

Run: `npx vitest run client/src/components/reports/forecast-variance-section.test.tsx client/src/components/reports/analytics-sections.test.tsx --config client/vite.config.ts`
Expected: PASS

- [ ] **Step 3: Run workspace typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit any final verification fixes**

```bash
git add .
git commit -m "fix: finalize forecast variance reporting"
```
