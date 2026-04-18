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
import { deriveForecastAmount } from "../../../src/modules/reports/forecast-milestones-service.js";

describe("deal forecast milestones", () => {
  it("derives forecast amount from awarded, bid, then dd values", () => {
    expect(deriveForecastAmount({ awardedAmount: "150000", bidEstimate: "120000", ddEstimate: "90000" })).toBe(150000);
    expect(deriveForecastAmount({ awardedAmount: null, bidEstimate: "120000", ddEstimate: "90000" })).toBe(120000);
    expect(deriveForecastAmount({ awardedAmount: null, bidEstimate: null, ddEstimate: "90000" })).toBe(90000);
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
import { describe, expect, it, vi } from "vitest";
import { captureStageDrivenForecastMilestone, deriveForecastAmount } from "../../../src/modules/reports/forecast-milestones-service.js";

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

  expect(deriveForecastAmount(createdDeal)).toBe(120000);
});

it("captures qualified, estimating, and closed_won milestones only once", async () => {
  const tenantDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) } as any;
  await captureStageDrivenForecastMilestone(tenantDb, {
    deal: { id: "deal-1", workflowRoute: "estimating", ddEstimate: "100000", bidEstimate: "120000", awardedAmount: "130000", stageId: "stage-dd" },
    currentStage: { slug: "lead" },
    targetStage: { slug: "dd" },
    userId: "user-1",
  });

  expect(tenantDb.execute).toHaveBeenCalledTimes(1);
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
import { describe, expect, it, vi } from "vitest";
import { getForecastVarianceOverview } from "../../../src/modules/reports/service.js";

function createMockTenantDb(rows: any[] = []) {
  const queue = Array.isArray(rows[0]) ? [...(rows as any[][])] : [rows];
  return {
    execute: vi.fn().mockImplementation(async () => ({ rows: queue.shift() ?? [] })),
  } as any;
}

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  return "";
}

it("returns forecast variance summary, rep rollups, and deal detail rows", async () => {
  const tenantDb = createMockTenantDb([
    [{ comparable_deals: "3", avg_initial_variance: "15000", avg_qualified_variance: "10000", avg_estimating_variance: "4000", avg_close_drift_days: "12" }],
    [{ rep_id: "rep-1", rep_name: "Jordan", comparable_deals: "2", avg_initial_variance: "12000", avg_qualified_variance: "8000", avg_estimating_variance: "4000", avg_close_drift_days: "10" }],
    [{ deal_id: "deal-1", deal_name: "North Plaza", rep_name: "Jordan", workflow_route: "estimating", initial_forecast: "100000", qualified_forecast: "110000", estimating_forecast: "120000", awarded_amount: "125000", initial_variance: "25000", qualified_variance: "15000", estimating_variance: "5000", close_drift_days: "7" }],
  ]);

  const result = await getForecastVarianceOverview(tenantDb, { officeId: "office-1" });

  expect(result.summary.comparableDeals).toBe(3);
  expect(result.repRollups[0].repName).toBe("Jordan");
  expect(result.deals[0].dealName).toBe("North Plaza");
});

it("scopes forecast variance to the current office and filters", async () => {
  const tenantDb = createMockTenantDb([[], [], []]);
  await getForecastVarianceOverview(tenantDb, {
    officeId: "office-1",
    regionId: "region-1",
    repId: "rep-1",
    source: "Trade Show",
  });

  const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
  expect(queryText).toContain("office_id");
  expect(queryText).toContain("region_id");
  expect(queryText).toContain("assigned_rep_id");
});
```

- [ ] **Step 2: Write failing route tests**

```ts
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const { reportRoutes } = await import("../../../src/modules/reports/routes.js");

it("passes active office scope into the forecast variance route", async () => {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { role: "director", officeId: "office-1", activeOfficeId: "office-2" };
    req.tenantDb = {};
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/reports", reportRoutes);

  const response = await request(app).get("/api/reports/forecast-variance?from=2026-01-01&to=2026-12-31");
  expect(response.status).toBe(200);
});

it("blocks reps from forecast variance reporting", async () => {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { role: "rep", officeId: "office-1" };
    req.tenantDb = {};
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/reports", reportRoutes);

  const response = await request(app).get("/api/reports/forecast-variance");
  expect(response.status).toBe(403);
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ForecastVarianceSection } from "./forecast-variance-section";

const mockApi = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: mockApi,
}));

beforeEach(() => {
  mockApi.mockReset();
});

it("renders forecast variance summary and deal detail rows", () => {
  const html = renderToStaticMarkup(
    <ForecastVarianceSection
      loading={false}
      data={{
        summary: { comparableDeals: 4, avgInitialVariance: 12000, avgQualifiedVariance: 8000, avgEstimatingVariance: 3000, avgCloseDriftDays: 6 },
        repRollups: [],
        deals: [{ dealId: "deal-1", dealName: "North Plaza", repName: "Jordan", workflowRoute: "estimating", initialForecast: 100000, qualifiedForecast: 110000, estimatingForecast: 120000, awardedAmount: 125000, initialVariance: 25000, qualifiedVariance: 15000, estimatingVariance: 5000, closeDriftDays: 7 }],
      }}
    />
  );

  expect(html).toContain("Forecast Accuracy");
  expect(html).toContain("North Plaza");
});

it("builds the forecast variance endpoint with shared analytics filters", async () => {
  const { executeForecastVarianceOverview } = await import("@/hooks/use-reports");
  await executeForecastVarianceOverview({ officeId: "office-1", source: "Trade Show" });

  expect(mockApi).toHaveBeenCalledWith("/reports/forecast-variance?officeId=office-1&source=Trade+Show");
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
import { describe, expect, it } from "vitest";
import { buildForecastMilestoneBackfillRows } from "../../../src/modules/reports/forecast-milestones-service.js";

it("backfills initial only when a create-time audit snapshot exists", async () => {
  const rows = buildForecastMilestoneBackfillRows({
    auditInsertRow: {
      full_row: { dd_estimate: "90000", bid_estimate: null, awarded_amount: null, workflow_route: "estimating", source: "Trade Show" },
    },
    closedWonDealRow: null,
  });

  expect(rows.map((row) => row.milestoneKey)).toEqual(["initial"]);
});

it("backfills closed_won from the current deal row as audit_backfill", async () => {
  const rows = buildForecastMilestoneBackfillRows({
    auditInsertRow: null,
    closedWonDealRow: {
      awardedAmount: "125000",
      workflowRoute: "estimating",
      actualCloseDate: "2026-04-01",
      source: "Trade Show",
    },
  });

  expect(rows[0].milestoneKey).toBe("closed_won");
  expect(rows[0].captureSource).toBe("audit_backfill");
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
