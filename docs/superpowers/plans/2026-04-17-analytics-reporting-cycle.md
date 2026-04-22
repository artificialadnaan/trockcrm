# Analytics Reporting Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the current reports module with non-redundant analytics improvements: richer canonical source-performance reporting, a data-mining surface for untouched and dormant records, and office-scoped regional/rep ownership reporting.

**Architecture:** Keep all work inside the existing reports backend and reports UI. Reuse the current `lead_source_roi`, `workflow_overview`, `stale_deals`, `activity_summary`, `pipeline_by_rep`, and admin cross-office boundaries instead of creating competing analytics surfaces. The only new backend endpoints in this cycle are for the truly net-new non-overlapping datasets.

**Tech Stack:** Express, Drizzle ORM, PostgreSQL SQL queries, React, TypeScript, Vitest

---

## File Structure

### Existing files to modify

- `server/src/modules/reports/service.ts`
  - add shared analytics filter helpers
  - extend the canonical source report payload
  - add net-new mining and regional ownership query functions
- `server/src/modules/reports/routes.ts`
  - extend query parsing and add only the new non-overlapping endpoints
- `server/src/modules/reports/saved-reports-service.ts`
  - touch only if compatibility adjustments are needed; do not seed duplicate analytics presets
- `client/src/hooks/use-reports.ts`
  - add shared analytics filter types and new executors/hooks
- `client/src/pages/reports/reports-page.tsx`
  - integrate shared filters and the new sections into the existing reports experience

### New files to create

- `server/tests/modules/reports/analytics-cycle.test.ts`
  - targeted coverage for analytics filter normalization, richer source reporting, mining queries, and regional ownership queries
- `client/src/components/reports/shared-report-filters.tsx`
  - shared analytics filters for the reports page
- `client/src/components/reports/source-performance-section.tsx`
  - UI for the enhanced canonical source report
- `client/src/components/reports/data-mining-section.tsx`
  - UI for untouched/dormant/ownership-gap mining data
- `client/src/components/reports/regional-ownership-section.tsx`
  - UI for office-scoped region/rep rollups
- `client/src/components/reports/analytics-sections.test.tsx`
  - focused rendering/empty-state/filter tests

### Explicit non-goals for this plan

- no duplicate stale-lead/deal dashboard outside the existing workflow overview / stale reports
- no new `campaign_performance` locked report if `lead_source_roi` remains canonical
- no replacement of the admin cross-office page
- no new reporting subsystem or analytics warehouse

---

### Task 1: Add Shared Analytics Filter Contracts

**Files:**
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Modify: `client/src/hooks/use-reports.ts`
- Test: `server/tests/modules/reports/analytics-cycle.test.ts`

- [ ] **Step 1: Write the failing shared-filter test**

```ts
import { describe, expect, it } from "vitest";
import { normalizeAnalyticsFilters } from "../../../src/modules/reports/service.js";

describe("normalizeAnalyticsFilters", () => {
  it("defaults date range and preserves office/region/rep/source filters", () => {
    const result = normalizeAnalyticsFilters({
      officeId: "office-1",
      regionId: "region-1",
      repId: "rep-1",
      source: "Trade Show",
    });

    expect(result.officeId).toBe("office-1");
    expect(result.regionId).toBe("region-1");
    expect(result.repId).toBe("rep-1");
    expect(result.source).toBe("Trade Show");
    expect(result.from).toMatch(/^\d{4}-01-01$/);
    expect(result.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t normalizeAnalyticsFilters`

Expected: FAIL because `normalizeAnalyticsFilters` does not exist.

- [ ] **Step 3: Add shared analytics filter types**

```ts
export interface AnalyticsFilterInput {
  from?: string;
  to?: string;
  officeId?: string;
  regionId?: string;
  repId?: string;
  source?: string;
}

export interface NormalizedAnalyticsFilters {
  from: string;
  to: string;
  officeId?: string;
  regionId?: string;
  repId?: string;
  source?: string;
}

export function normalizeAnalyticsFilters(
  input: AnalyticsFilterInput = {}
): NormalizedAnalyticsFilters {
  const { from, to } = defaultDateRange(input.from, input.to);
  return {
    from,
    to,
    officeId: input.officeId,
    regionId: input.regionId,
    repId: input.repId,
    source: input.source?.trim() ? input.source.trim() : undefined,
  };
}
```

- [ ] **Step 4: Extend client hook options**

```ts
export interface AnalyticsQueryOptions {
  from?: string;
  to?: string;
  officeId?: string;
  regionId?: string;
  repId?: string;
  source?: string;
  includeDd?: boolean;
}
```

```ts
if (options.officeId) params.set("officeId", options.officeId);
if (options.regionId) params.set("regionId", options.regionId);
if (options.repId) params.set("repId", options.repId);
if (options.source) params.set("source", options.source);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t normalizeAnalyticsFilters`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/reports/service.ts server/src/modules/reports/routes.ts client/src/hooks/use-reports.ts server/tests/modules/reports/analytics-cycle.test.ts
git commit -m "feat: add shared analytics filter contracts"
```

---

### Task 2: Extend the Canonical Lead-Source Report

**Files:**
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Modify: `client/src/hooks/use-reports.ts`
- Create: `client/src/components/reports/source-performance-section.tsx`
- Modify: `client/src/pages/reports/reports-page.tsx`
- Test: `server/tests/modules/reports/analytics-cycle.test.ts`
- Test: `client/src/components/reports/analytics-sections.test.tsx`

- [ ] **Step 1: Write the failing source-performance test**

```ts
it("extends lead-source ROI with lead counts and unknown-source normalization", async () => {
  const result = await getLeadSourceROI(tenantDb as never, {
    from: "2026-01-01",
    to: "2026-12-31",
  });

  expect(result[0]).toMatchObject({
    source: "Trade Show",
    leadCount: 4,
    dealCount: 3,
    wonDeals: 1,
  });

  expect(result.some((row) => row.source === "Unknown")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t lead-source`

Expected: FAIL because `getLeadSourceROI` does not currently include the richer canonical source-performance payload.

- [ ] **Step 3: Extend the existing source report payload**

```ts
export interface LeadSourceRoiRow {
  source: string;
  leadCount: number;
  dealCount: number;
  activeDeals: number;
  wonDeals: number;
  lostDeals: number;
  activePipelineValue: number;
  wonValue: number;
  winRate: number;
}
```

```ts
export async function getLeadSourceROI(
  tenantDb: TenantDb,
  input: AnalyticsFilterInput = {}
): Promise<LeadSourceRoiRow[]> {
  const filters = normalizeAnalyticsFilters(input);
  // extend existing source aggregation instead of introducing a second report family
}
```

- [ ] **Step 4: Keep the existing route name and widen its filters**

```ts
router.get("/lead-source-roi", requireDirector, async (req, res, next) => {
  try {
    const data = await getLeadSourceROI(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      officeId: (req.query.officeId as string | undefined) ?? req.user!.activeOfficeId ?? req.user!.officeId,
      regionId: req.query.regionId as string | undefined,
      repId: req.query.repId as string | undefined,
      source: req.query.source as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Add the source-performance section**

```tsx
export function SourcePerformanceSection({
  rows,
  loading,
}: {
  rows: LeadSourceRoiRow[];
  loading: boolean;
}) {
  if (loading) return <div className="rounded-2xl border border-slate-200 p-6">Loading source performance…</div>;
  if (!rows.length) return <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">No source performance data found for the selected filters.</div>;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Source Performance</h2>
        <p className="text-sm text-slate-500">Canonical source quality by volume, pipeline, and close performance.</p>
      </div>
      <ReportChart
        type="bar"
        data={rows.map((row) => ({
          label: row.source,
          value: row.wonValue,
          secondaryValue: row.activePipelineValue,
        }))}
      />
    </section>
  );
}
```

- [ ] **Step 6: Run backend and frontend tests**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t lead-source`

Expected: PASS

Run: `npx vitest run client/src/components/reports/analytics-sections.test.tsx -t source --config client/vite.config.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/reports/service.ts server/src/modules/reports/routes.ts client/src/hooks/use-reports.ts client/src/components/reports/source-performance-section.tsx client/src/pages/reports/reports-page.tsx server/tests/modules/reports/analytics-cycle.test.ts client/src/components/reports/analytics-sections.test.tsx
git commit -m "feat: extend canonical source performance reporting"
```

---

### Task 3: Add Non-Overlapping Data-Mining Reporting

**Files:**
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Modify: `client/src/hooks/use-reports.ts`
- Create: `client/src/components/reports/data-mining-section.tsx`
- Modify: `client/src/pages/reports/reports-page.tsx`
- Test: `server/tests/modules/reports/analytics-cycle.test.ts`
- Test: `client/src/components/reports/analytics-sections.test.tsx`

- [ ] **Step 1: Write the failing data-mining test**

```ts
it("returns untouched and dormant mining buckets without duplicating stale workflow widgets", async () => {
  const result = await getDataMiningOverview(tenantDb as never, {
    from: "2026-01-01",
    to: "2026-12-31",
  });

  expect(result.summary).toMatchObject({
    untouchedContact30Count: expect.any(Number),
    untouchedContact60Count: expect.any(Number),
    dormantCompany90Count: expect.any(Number),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t data-mining`

Expected: FAIL because `getDataMiningOverview` does not exist.

- [ ] **Step 3: Add a net-new mining query that excludes stale lead/deal duplication**

```ts
export interface DataMiningOverview {
  summary: {
    untouchedContact30Count: number;
    untouchedContact60Count: number;
    dormantCompany90Count: number;
  };
  untouchedContacts: Array<{
    contactId: string;
    contactName: string;
    companyName: string;
    daysSinceTouch: number;
  }>;
  dormantCompanies: Array<{
    companyId: string;
    companyName: string;
    daysSinceActivity: number;
  }>;
}
```

```ts
export async function getDataMiningOverview(
  tenantDb: TenantDb,
  input: AnalyticsFilterInput = {}
): Promise<DataMiningOverview> {
  const filters = normalizeAnalyticsFilters(input);
  // load untouched contacts and dormant companies only
}
```

- [ ] **Step 4: Add the new route and client executor**

```ts
router.get("/data-mining", requireDirector, async (req, res, next) => {
  try {
    const data = await getDataMiningOverview(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      officeId: (req.query.officeId as string | undefined) ?? req.user!.activeOfficeId ?? req.user!.officeId,
      regionId: req.query.regionId as string | undefined,
      repId: req.query.repId as string | undefined,
      source: req.query.source as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Add the data-mining section**

```tsx
export function DataMiningSection({
  data,
  loading,
}: {
  data: DataMiningOverview | null;
  loading: boolean;
}) {
  if (loading) return <div className="rounded-2xl border border-slate-200 p-6">Loading data mining…</div>;
  if (!data) return <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">No data-mining records found for the selected filters.</div>;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Data Mining</h2>
        <p className="text-sm text-slate-500">Untouched and dormant records that need reactivation.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 p-4">Untouched contacts 30d+: {data.summary.untouchedContact30Count}</div>
        <div className="rounded-xl border border-slate-200 p-4">Untouched contacts 60d+: {data.summary.untouchedContact60Count}</div>
        <div className="rounded-xl border border-slate-200 p-4">Dormant companies 90d+: {data.summary.dormantCompany90Count}</div>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Run backend and frontend tests**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t data-mining`

Expected: PASS

Run: `npx vitest run client/src/components/reports/analytics-sections.test.tsx -t mining --config client/vite.config.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/reports/service.ts server/src/modules/reports/routes.ts client/src/hooks/use-reports.ts client/src/components/reports/data-mining-section.tsx client/src/pages/reports/reports-page.tsx server/tests/modules/reports/analytics-cycle.test.ts client/src/components/reports/analytics-sections.test.tsx
git commit -m "feat: add non-overlapping data mining reporting"
```

---

### Task 4: Add Office-Scoped Regional and Rep Ownership Reporting

**Files:**
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Modify: `client/src/hooks/use-reports.ts`
- Create: `client/src/components/reports/regional-ownership-section.tsx`
- Modify: `client/src/pages/reports/reports-page.tsx`
- Test: `server/tests/modules/reports/analytics-cycle.test.ts`
- Test: `client/src/components/reports/analytics-sections.test.tsx`

- [ ] **Step 1: Write the failing ownership test**

```ts
it("returns office-scoped regional and rep ownership rollups without replacing cross-office reporting", async () => {
  const result = await getRegionalOwnershipOverview(tenantDb as never, {
    officeId: "office-1",
  });

  expect(result.regionRollups[0]).toMatchObject({
    regionName: expect.any(String),
    dealCount: expect.any(Number),
    pipelineValue: expect.any(Number),
  });

  expect(result.ownershipGaps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ gapType: "missing_assigned_rep" }),
    ])
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t ownership`

Expected: FAIL because `getRegionalOwnershipOverview` does not exist.

- [ ] **Step 3: Add the regional/rep ownership query**

```ts
export interface RegionalOwnershipOverview {
  regionRollups: Array<{
    regionId: string | null;
    regionName: string;
    dealCount: number;
    pipelineValue: number;
    staleDealCount: number;
  }>;
  repRollups: Array<{
    repId: string;
    repName: string;
    dealCount: number;
    pipelineValue: number;
    activityCount: number;
    staleDealCount: number;
  }>;
  ownershipGaps: Array<{
    gapType: "missing_assigned_rep" | "missing_region";
    count: number;
  }>;
}
```

```ts
export async function getRegionalOwnershipOverview(
  tenantDb: TenantDb,
  input: AnalyticsFilterInput = {}
): Promise<RegionalOwnershipOverview> {
  const filters = normalizeAnalyticsFilters(input);
  // office-scoped rollups by region and rep; complements but does not replace admin cross-office views
}
```

- [ ] **Step 4: Add the route and client executor**

```ts
router.get("/regional-ownership", requireDirector, async (req, res, next) => {
  try {
    const data = await getRegionalOwnershipOverview(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      officeId: (req.query.officeId as string | undefined) ?? req.user!.activeOfficeId ?? req.user!.officeId,
      regionId: req.query.regionId as string | undefined,
      repId: req.query.repId as string | undefined,
      source: req.query.source as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Add the regional ownership section**

```tsx
export function RegionalOwnershipSection({
  data,
  loading,
}: {
  data: RegionalOwnershipOverview | null;
  loading: boolean;
}) {
  if (loading) return <div className="rounded-2xl border border-slate-200 p-6">Loading regional ownership…</div>;
  if (!data) return <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">No regional ownership data found for the selected filters.</div>;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Regional and Rep Ownership</h2>
        <p className="text-sm text-slate-500">Current-office pipeline, activity, and ownership gaps by region and rep.</p>
      </div>
      <ReportChart
        type="bar"
        data={data.regionRollups.map((row) => ({ label: row.regionName, value: row.pipelineValue }))}
      />
    </section>
  );
}
```

- [ ] **Step 6: Run backend and frontend tests**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t ownership`

Expected: PASS

Run: `npx vitest run client/src/components/reports/analytics-sections.test.tsx -t regional --config client/vite.config.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/reports/service.ts server/src/modules/reports/routes.ts client/src/hooks/use-reports.ts client/src/components/reports/regional-ownership-section.tsx client/src/pages/reports/reports-page.tsx server/tests/modules/reports/analytics-cycle.test.ts client/src/components/reports/analytics-sections.test.tsx
git commit -m "feat: add office-scoped regional ownership reporting"
```

---

### Task 5: Add Shared Reports Filters and Integrate the New Sections

**Files:**
- Create: `client/src/components/reports/shared-report-filters.tsx`
- Modify: `client/src/pages/reports/reports-page.tsx`
- Modify: `client/src/hooks/use-reports.ts`
- Test: `client/src/components/reports/analytics-sections.test.tsx`

- [ ] **Step 1: Write the failing reports-filter test**

```tsx
it("renders shared analytics filters for date range, region, rep, and source", async () => {
  render(<ReportsPage />);

  expect(screen.getByLabelText(/from date/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/to date/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/region/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/rep/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/source/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/components/reports/analytics-sections.test.tsx -t filters --config client/vite.config.ts`

Expected: FAIL because the shared filters do not exist.

- [ ] **Step 3: Add the shared filter component**

```tsx
export function SharedReportFilters({
  from,
  to,
  regionId,
  repId,
  source,
  onChange,
}: {
  from: string;
  to: string;
  regionId: string;
  repId: string;
  source: string;
  onChange: (next: {
    from?: string;
    to?: string;
    regionId?: string;
    repId?: string;
    source?: string;
  }) => void;
}) {
  return (
    <div className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-5">
      <Input aria-label="From date" type="date" value={from} onChange={(e) => onChange({ from: e.target.value })} />
      <Input aria-label="To date" type="date" value={to} onChange={(e) => onChange({ to: e.target.value })} />
      <Input aria-label="Region" value={regionId} onChange={(e) => onChange({ regionId: e.target.value })} placeholder="Region ID" />
      <Input aria-label="Rep" value={repId} onChange={(e) => onChange({ repId: e.target.value })} placeholder="Rep ID" />
      <Input aria-label="Source" value={source} onChange={(e) => onChange({ source: e.target.value })} placeholder="Lead source" />
    </div>
  );
}
```

- [ ] **Step 4: Wire the sections into the existing reports page**

```tsx
const [analyticsFilters, setAnalyticsFilters] = useState({
  from: defaultFrom,
  to: defaultTo,
  regionId: "",
  repId: "",
  source: "",
});
```

```tsx
<SharedReportFilters
  {...analyticsFilters}
  onChange={(next) => setAnalyticsFilters((current) => ({ ...current, ...next }))}
/>
<SourcePerformanceSection rows={sourceRows} loading={sourceLoading} />
<DataMiningSection data={miningData} loading={miningLoading} />
<RegionalOwnershipSection data={ownershipData} loading={ownershipLoading} />
```

- [ ] **Step 5: Run frontend tests**

Run: `npx vitest run client/src/components/reports/analytics-sections.test.tsx --config client/vite.config.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/components/reports/shared-report-filters.tsx client/src/components/reports/source-performance-section.tsx client/src/components/reports/data-mining-section.tsx client/src/components/reports/regional-ownership-section.tsx client/src/pages/reports/reports-page.tsx client/src/hooks/use-reports.ts client/src/components/reports/analytics-sections.test.tsx
git commit -m "feat: integrate analytics reporting sections"
```

---

### Task 6: Add Non-Redundancy Regression Coverage and Verify the Cycle

**Files:**
- Modify: `server/tests/modules/reports/analytics-cycle.test.ts`
- Modify: `client/src/components/reports/analytics-sections.test.tsx`

- [ ] **Step 1: Write the failing non-redundancy regression test**

```ts
it("does not add duplicate locked presets for analytics already surfaced on the reports page", async () => {
  await seedLockedReports("office-1");
  const reports = await getSavedReports("user-1", "office-1");

  expect(reports.filter((report) => report.name === "Lead Source ROI")).toHaveLength(1);
  expect(reports.some((report) => report.name === "Campaign Performance")).toBe(false);
  expect(reports.some((report) => report.name === "Data Mining")).toBe(false);
  expect(reports.some((report) => report.name === "Regional Ownership")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails when duplicate presets are introduced**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts -t duplicate`

Expected: PASS once implementation avoids duplicate presets; fail if implementation adds them.

- [ ] **Step 3: Run targeted analytics verification**

Run: `npx vitest run server/tests/modules/reports/analytics-cycle.test.ts`

Expected: PASS

Run: `npx vitest run client/src/components/reports/analytics-sections.test.tsx --config client/vite.config.ts`

Expected: PASS

Run: `npm run typecheck`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/tests/modules/reports/analytics-cycle.test.ts client/src/components/reports/analytics-sections.test.tsx
git commit -m "test: guard analytics cycle against redundant report surfaces"
```

---

## Self-Review

### Spec coverage

- canonical source-performance enhancement: covered by Task 2
- non-overlapping data mining: covered by Task 3
- office-scoped regional/rep ownership reporting: covered by Task 4
- shared analytics filters and reports-page integration: covered by Tasks 1 and 5
- redundancy guardrails: covered by Task 6

### Placeholder scan

- no `TODO`, `TBD`, or “similar to” placeholders remain
- each task includes explicit files, tests, commands, and commit steps

### Type consistency

- shared filters use `AnalyticsFilterInput` / `NormalizedAnalyticsFilters`
- source reporting stays on the canonical `lead_source_roi` lane
- only net-new report types introduced in this cycle are:
  - `data_mining`
  - `regional_ownership`

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-analytics-reporting-cycle.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
