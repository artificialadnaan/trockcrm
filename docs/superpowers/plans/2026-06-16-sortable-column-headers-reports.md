# Sortable Column Headers (Pass 1: Reports) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one shared, reusable sortable-column-header pattern and apply it to the four real Reports column tables (Director Scorecard, Customer Concentration, At-Risk Watchlist, Platform Usage Leaderboard), each preserving its current default order.

**Architecture:** Three small, independently-testable units in `client/src/components/reports/sortable/`: pure comparators (`comparators.ts`), a headless `useTableSort` hook (`use-table-sort.ts`), and a container-agnostic `<SortHeaderButton>` (`sort-header-button.tsx`). Surfaces are wired additively — no `<table>`-coupled wrapper, no change to the shared `PipelineStageTable`. Correctness guarantees (numeric-not-lexical, dates chronological, nulls-last both directions, toggle/initial/stability) live in `*.runtime.test.*` so they execute in the premerge gate.

**Tech Stack:** React + TypeScript, Vitest 4 (jsdom via `// @vitest-environment jsdom` pragma, raw React DOM `createRoot`/`act`, no `@testing-library`), lucide-react icons, `cn` from `@/lib/utils`. Spec: `docs/superpowers/specs/2026-06-16-sortable-column-headers-design.md`.

---

## File Structure

- Create `client/src/components/reports/sortable/comparators.ts` — pure `compareText/compareNumber/compareDate` + shared types. One responsibility: ordering primitives.
- Create `client/src/components/reports/sortable/comparators.runtime.test.ts` — comparator guarantees (CI-executed).
- Create `client/src/components/reports/sortable/use-table-sort.ts` — headless sort-state hook.
- Create `client/src/components/reports/sortable/use-table-sort.runtime.test.ts` — hook semantics against real report types (CI-executed).
- Create `client/src/components/reports/sortable/sort-header-button.tsx` — presentational header button.
- Create `client/src/components/reports/sortable/sort-header-button.runtime.test.tsx` — icon/aria states (CI-executed).
- Create `client/src/components/reports/sortable/index.ts` — barrel export.
- Modify `client/src/pages/reports/director-scorecard-page.tsx` — wire both tables.
- Modify `client/src/pages/reports/customer-concentration-page.tsx` — wire both tables + pinned concentration highlight.
- Modify `client/src/pages/reports/at-risk-page.tsx` — wire via `PipelineStageTable` ReactNode headers.
- Modify `client/src/pages/reports/platform-usage-page.tsx` — wire grid leaderboard, `initialSort` actions-desc.

**Branch:** `feat/sortable-column-headers-reports` (already created; spec committed). Standard gate: `npm run check:premerge`. Adnaan merges — no self-merge.

---

## Task 1: Comparators (pure ordering primitives)

**Files:**
- Create: `client/src/components/reports/sortable/comparators.ts`
- Test: `client/src/components/reports/sortable/comparators.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// client/src/components/reports/sortable/comparators.runtime.test.ts
import { describe, it, expect } from "vitest";
import { compareText, compareNumber, compareDate } from "./comparators";

// Real report values: Platform Usage action counts and Director Scorecard dates.
describe("compareNumber", () => {
  it("sorts numerically, never lexically (9 < 10 < 100)", () => {
    const sortedAsc = [100, 9, 10].sort((a, b) => compareNumber(a, b, "asc"));
    expect(sortedAsc).toEqual([9, 10, 100]); // lexical would give [10, 100, 9]
    const sortedDesc = [9, 100, 10].sort((a, b) => compareNumber(a, b, "desc"));
    expect(sortedDesc).toEqual([100, 10, 9]);
  });

  it("puts nullish last in BOTH directions", () => {
    expect([5, null, 1].sort((a, b) => compareNumber(a, b, "asc"))).toEqual([1, 5, null]);
    expect([5, null, 1].sort((a, b) => compareNumber(a, b, "desc"))).toEqual([5, 1, null]);
    expect([undefined, 2].sort((a, b) => compareNumber(a, b, "asc"))).toEqual([2, undefined]);
  });
});

describe("compareText", () => {
  it("sorts alphabetically, case-insensitive", () => {
    expect(["beta", "Alpha", "gamma"].sort((a, b) => compareText(a, b, "asc"))).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
  });

  it("treats empty string / nullish as last in both directions", () => {
    expect(["b", "", "a"].sort((a, b) => compareText(a, b, "asc"))).toEqual(["a", "b", ""]);
    expect(["b", "", "a"].sort((a, b) => compareText(a, b, "desc"))).toEqual(["b", "a", ""]);
  });
});

describe("compareDate", () => {
  it("sorts chronologically, not by string surface form", () => {
    const dates = ["2026-01-09", "2026-01-10", "2025-12-31"];
    expect(dates.slice().sort((a, b) => compareDate(a, b, "asc"))).toEqual([
      "2025-12-31",
      "2026-01-09",
      "2026-01-10",
    ]);
    expect(dates.slice().sort((a, b) => compareDate(a, b, "desc"))).toEqual([
      "2026-01-10",
      "2026-01-09",
      "2025-12-31",
    ]);
  });

  it("puts null/unparseable dates last in both directions", () => {
    expect(["2026-01-01", null].sort((a, b) => compareDate(a, b, "asc"))).toEqual(["2026-01-01", null]);
    expect(["2026-01-01", null].sort((a, b) => compareDate(a, b, "desc"))).toEqual(["2026-01-01", null]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/components/reports/sortable/comparators.runtime.test.ts`
Expected: FAIL — cannot find module `./comparators`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/components/reports/sortable/comparators.ts
export type SortDirection = "asc" | "desc";
export type ColumnType = "text" | "number" | "date";

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

// Nullish (and "" for text) always sorts LAST, in both directions: the null check
// returns before the direction sign is applied, so a blank never floats to the top
// on ascending. Blanks are "unknown", never "0"/"zzz".
export function compareText(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDirection,
): number {
  const an = isNullish(a) || a === "";
  const bn = isNullish(b) || b === "";
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const cmp = String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

export function compareNumber(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: SortDirection,
): number {
  const an = isNullish(a);
  const bn = isNullish(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const cmp = (a as number) - (b as number);
  return dir === "asc" ? cmp : -cmp;
}

export function compareDate(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDirection,
): number {
  const at = isNullish(a) ? NaN : Date.parse(a as string);
  const bt = isNullish(b) ? NaN : Date.parse(b as string);
  const an = Number.isNaN(at);
  const bn = Number.isNaN(bt);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const cmp = at - bt;
  return dir === "asc" ? cmp : -cmp;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/components/reports/sortable/comparators.runtime.test.ts`
Expected: PASS (all comparator cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/reports/sortable/comparators.ts client/src/components/reports/sortable/comparators.runtime.test.ts
git commit -m "feat(reports): pure sort comparators (numeric/text/date, nulls-last)"
```

---

## Task 2: `useTableSort` headless hook

**Files:**
- Create: `client/src/components/reports/sortable/use-table-sort.ts`
- Test: `client/src/components/reports/sortable/use-table-sort.runtime.test.ts`

- [ ] **Step 1: Write the failing test** (uses real `DirectorScorecardReport` rep-performance rows + the repo's createRoot/act probe convention)

```ts
// @vitest-environment jsdom
// client/src/components/reports/sortable/use-table-sort.runtime.test.ts
import { describe, it, expect } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { DirectorScorecardReport } from "@/hooks/use-reports";
import { useTableSort, type SortColumn } from "./use-table-sort";

type RepRow = DirectorScorecardReport["repPerformance"][number];

const ROWS: RepRow[] = [
  { repName: "Colby", openDeals: 9, pipelineValue: 100, wonThisPeriod: 1, winRate: 0.5, activityScore: 2 },
  { repName: "ana", openDeals: 100, pipelineValue: 10, wonThisPeriod: 3, winRate: 0.1, activityScore: 9 },
  { repName: "Beth", openDeals: 10, pipelineValue: 50, wonThisPeriod: 2, winRate: 0.9, activityScore: 5 },
];

const COLUMNS: ReadonlyArray<SortColumn<RepRow>> = [
  { key: "repName", type: "text", accessor: (r) => r.repName },
  { key: "openDeals", type: "number", accessor: (r) => r.openDeals },
];

async function renderHook(initialSort: Parameters<typeof useTableSort>[2] = undefined) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let api: ReturnType<typeof useTableSort<RepRow>>;
  function Probe() {
    api = useTableSort(ROWS, COLUMNS, initialSort);
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    get current() {
      return api;
    },
    async act(fn: () => void) {
      await act(async () => {
        fn();
      });
    },
  };
}

describe("useTableSort", () => {
  it("with initialSort null, preserves input order (no reorder on load)", async () => {
    const hook = await renderHook();
    expect(hook.current.sortedRows.map((r) => r.repName)).toEqual(["Colby", "ana", "Beth"]);
    expect(hook.current.sortState).toBeNull();
  });

  it("first click on a numeric column sorts desc; on a text column sorts asc", async () => {
    const hook = await renderHook();
    await hook.act(() => hook.current.toggle("openDeals"));
    expect(hook.current.sortedRows.map((r) => r.openDeals)).toEqual([100, 10, 9]); // desc
    await hook.act(() => hook.current.toggle("repName"));
    expect(hook.current.sortedRows.map((r) => r.repName)).toEqual(["ana", "Beth", "Colby"]); // asc, case-insensitive
  });

  it("clicking the active column flips direction", async () => {
    const hook = await renderHook();
    await hook.act(() => hook.current.toggle("openDeals")); // desc
    await hook.act(() => hook.current.toggle("openDeals")); // asc
    expect(hook.current.sortedRows.map((r) => r.openDeals)).toEqual([9, 10, 100]);
    expect(hook.current.getHeaderProps("openDeals")).toEqual({ active: true, dir: "asc" });
    expect(hook.current.getHeaderProps("repName")).toEqual({ active: false, dir: null });
  });

  it("honors a provided initialSort on first render", async () => {
    const hook = await renderHook({ initialSort: { key: "openDeals", dir: "desc" } });
    expect(hook.current.sortedRows.map((r) => r.openDeals)).toEqual([100, 10, 9]);
  });

  it("is stable: equal keys keep incoming order", async () => {
    const hook = await renderHook();
    // winRate not in COLUMNS; use a custom-compare column inline to force ties
    expect(hook.current.sortedRows.map((r) => r.repName)).toEqual(["Colby", "ana", "Beth"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/components/reports/sortable/use-table-sort.runtime.test.ts`
Expected: FAIL — cannot find module `./use-table-sort`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/components/reports/sortable/use-table-sort.ts
import { useMemo, useState } from "react";
import {
  compareDate,
  compareNumber,
  compareText,
  type ColumnType,
  type SortDirection,
} from "./comparators";

export type { ColumnType, SortDirection } from "./comparators";

export interface SortColumn<Row> {
  key: string;
  type: ColumnType;
  accessor: (row: Row) => string | number | null | undefined;
  // Direction-agnostic base order (the hook negates it for "desc"). Use for columns
  // whose order isn't a plain field value (e.g. an enum sorted by an explicit rank).
  compare?: (a: Row, b: Row) => number;
}

export interface SortState {
  key: string;
  dir: SortDirection;
}

export interface UseTableSortOptions {
  initialSort?: SortState | null;
}

export interface UseTableSortResult<Row> {
  sortedRows: Row[];
  sortState: SortState | null;
  toggle: (key: string) => void;
  getHeaderProps: (key: string) => { active: boolean; dir: SortDirection | null };
}

function defaultDir(type: ColumnType): SortDirection {
  return type === "text" ? "asc" : "desc";
}

export function useTableSort<Row>(
  rows: Row[],
  columns: ReadonlyArray<SortColumn<Row>>,
  options: UseTableSortOptions = {},
): UseTableSortResult<Row> {
  const [sortState, setSortState] = useState<SortState | null>(options.initialSort ?? null);

  const columnMap = useMemo(() => {
    const m = new Map<string, SortColumn<Row>>();
    for (const c of columns) m.set(c.key, c);
    return m;
  }, [columns]);

  function toggle(key: string) {
    const col = columnMap.get(key);
    if (!col) return;
    setSortState((cur) =>
      cur && cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: defaultDir(col.type) },
    );
  }

  const sortedRows = useMemo(() => {
    if (!sortState) return rows;
    const col = columnMap.get(sortState.key);
    if (!col) return rows;
    const dir = sortState.dir;
    const indexed = rows.map((row, index) => ({ row, index }));
    indexed.sort((a, b) => {
      let cmp: number;
      if (col.compare) {
        cmp = col.compare(a.row, b.row);
        if (dir === "desc") cmp = -cmp;
      } else {
        const av = col.accessor(a.row);
        const bv = col.accessor(b.row);
        cmp =
          col.type === "number"
            ? compareNumber(av as number | null | undefined, bv as number | null | undefined, dir)
            : col.type === "date"
              ? compareDate(av as string | null | undefined, bv as string | null | undefined, dir)
              : compareText(av as string | null | undefined, bv as string | null | undefined, dir);
      }
      // Explicit stable tiebreak: equal keys (incl. nullish ties) keep server order.
      return cmp !== 0 ? cmp : a.index - b.index;
    });
    return indexed.map((entry) => entry.row);
  }, [rows, sortState, columnMap]);

  function getHeaderProps(key: string): { active: boolean; dir: SortDirection | null } {
    const active = sortState?.key === key;
    return { active, dir: active ? sortState!.dir : null };
  }

  return { sortedRows, sortState, toggle, getHeaderProps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/components/reports/sortable/use-table-sort.runtime.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/reports/sortable/use-table-sort.ts client/src/components/reports/sortable/use-table-sort.runtime.test.ts
git commit -m "feat(reports): headless useTableSort hook (toggle/initial/stable)"
```

---

## Task 3: `<SortHeaderButton>` presentational header

**Files:**
- Create: `client/src/components/reports/sortable/sort-header-button.tsx`
- Test: `client/src/components/reports/sortable/sort-header-button.runtime.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
// client/src/components/reports/sortable/sort-header-button.runtime.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SortHeaderButton } from "./sort-header-button";

describe("SortHeaderButton", () => {
  it("renders the neutral chevron + accessible label when not active", () => {
    const html = renderToStaticMarkup(
      <SortHeaderButton label="Value" active={false} dir={null} onClick={() => {}} />,
    );
    expect(html).toContain('aria-label="Sort by Value"');
    expect(html).toContain('data-sort="none"');
    expect(html).toContain("text-slate-300"); // muted neutral chevron
  });

  it("marks ascending state", () => {
    const html = renderToStaticMarkup(
      <SortHeaderButton label="Value" active dir="asc" onClick={() => {}} />,
    );
    expect(html).toContain('data-sort="ascending"');
  });

  it("marks descending state", () => {
    const html = renderToStaticMarkup(
      <SortHeaderButton label="Value" active dir="desc" onClick={() => {}} />,
    );
    expect(html).toContain('data-sort="descending"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/components/reports/sortable/sort-header-button.runtime.test.tsx`
Expected: FAIL — cannot find module `./sort-header-button`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// client/src/components/reports/sortable/sort-header-button.tsx
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortDirection } from "./comparators";

export interface SortHeaderButtonProps {
  label: ReactNode;
  active: boolean;
  dir: SortDirection | null;
  numeric?: boolean;
  onClick: () => void;
  className?: string;
}

// Container-agnostic: drop inside a <th>, a PipelineStageTable column `header`, or a grid <div>.
// `className` is passthrough so each report keeps its own header typography; this adds only the
// click + 3-state caret affordance.
export function SortHeaderButton({ label, active, dir, numeric, onClick, className }: SortHeaderButtonProps) {
  const sortAttr = !active ? "none" : dir === "asc" ? "ascending" : "descending";
  const labelText = typeof label === "string" ? label : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      data-sort={sortAttr}
      aria-label={labelText ? `Sort by ${labelText}` : "Sort column"}
      title={labelText ? `Sort by ${labelText}` : "Sort"}
      className={cn(
        "inline-flex items-center gap-1 transition hover:text-slate-800",
        numeric ? "flex-row-reverse" : "",
        className,
      )}
    >
      {label}
      {!active ? (
        <ChevronsUpDown className="h-3 w-3 text-slate-300" aria-hidden="true" />
      ) : dir === "asc" ? (
        <ArrowUp className="h-3 w-3 text-slate-600" aria-hidden="true" />
      ) : (
        <ArrowDown className="h-3 w-3 text-slate-600" aria-hidden="true" />
      )}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/components/reports/sortable/sort-header-button.runtime.test.tsx`
Expected: PASS (3 cases).

- [ ] **Step 5: Create the barrel + commit**

```ts
// client/src/components/reports/sortable/index.ts
export { useTableSort } from "./use-table-sort";
export type { SortColumn, SortState, SortDirection, ColumnType, UseTableSortResult } from "./use-table-sort";
export { SortHeaderButton } from "./sort-header-button";
export type { SortHeaderButtonProps } from "./sort-header-button";
export { compareText, compareNumber, compareDate } from "./comparators";
```

```bash
git add client/src/components/reports/sortable/sort-header-button.tsx client/src/components/reports/sortable/sort-header-button.runtime.test.tsx client/src/components/reports/sortable/index.ts
git commit -m "feat(reports): container-agnostic SortHeaderButton + barrel"
```

---

## Task 4: Apply to Director Scorecard (2 tables)

**Files:**
- Modify: `client/src/pages/reports/director-scorecard-page.tsx`

Both tables are plain `<table>` with hardcoded `<th>` text. Wire `useTableSort` per table and replace each `<th>` text with `<SortHeaderButton>`. The hook is per-table, so introduce two small inner components so each owns its own hook (hooks cannot be conditional inside the page's `data &&` branch — extract to components that are always rendered when `data` exists).

- [ ] **Step 1: Add imports** at the top of the file (after the existing imports):

```tsx
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
```

- [ ] **Step 2: Replace the inline Rep Performance table** (current lines ~57-79, the `<ReportPanel title="Rep Performance">` block body) with a dedicated component. Add this component above `DirectorScorecardPage`:

```tsx
type RepPerfRow = DirectorScorecardReport["repPerformance"][number];
type AtRiskDealRow = DirectorScorecardReport["topAtRiskDeals"][number];

const REP_PERF_COLUMNS: ReadonlyArray<SortColumn<RepPerfRow> & { header: string; numeric: boolean; cell: (r: RepPerfRow) => React.ReactNode }> = [
  { key: "repName", type: "text", accessor: (r) => r.repName, header: "Rep Name", numeric: false, cell: (r) => <span className="font-semibold text-slate-900">{r.repName}</span> },
  { key: "openDeals", type: "number", accessor: (r) => r.openDeals, header: "Open Deals", numeric: true, cell: (r) => formatNumber(r.openDeals) },
  { key: "pipelineValue", type: "number", accessor: (r) => r.pipelineValue, header: "Pipeline Value", numeric: true, cell: (r) => formatCurrency(r.pipelineValue) },
  { key: "wonThisPeriod", type: "number", accessor: (r) => r.wonThisPeriod, header: "Won This Period", numeric: true, cell: (r) => formatNumber(r.wonThisPeriod) },
  { key: "winRate", type: "number", accessor: (r) => r.winRate, header: "Win Rate", numeric: true, cell: (r) => formatPercent(r.winRate) },
  { key: "activityScore", type: "number", accessor: (r) => r.activityScore, header: "Activity Score", numeric: true, cell: (r) => formatNumber(r.activityScore) },
];

function RepPerformanceTable({ rows }: { rows: RepPerfRow[] }) {
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, REP_PERF_COLUMNS);
  if (rows.length === 0) return <EmptyState />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
          <tr>
            {REP_PERF_COLUMNS.map((col) => {
              const hp = getHeaderProps(col.key);
              return (
                <th key={col.key} className={col.numeric ? "py-2 text-right" : "py-2"}>
                  <SortHeaderButton
                    label={col.header}
                    numeric={col.numeric}
                    active={hp.active}
                    dir={hp.dir}
                    onClick={() => toggle(col.key)}
                    className="text-xs font-black uppercase tracking-[0.14em] text-slate-500"
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sortedRows.map((row) => (
            <tr key={row.repName}>
              {REP_PERF_COLUMNS.map((col) => (
                <td key={col.key} className={col.numeric ? "py-3 text-right tabular-nums" : "py-3"}>
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Note: `DirectorScorecardReport` is already imported indirectly via the hook; add an explicit type import if the typechecker requires it: `import type { DirectorScorecardReport } from "@/hooks/use-reports";`.

- [ ] **Step 3: Replace the Top-5 At-Risk table** with its component (above `DirectorScorecardPage`):

```tsx
const TOP_ATRISK_COLUMNS: ReadonlyArray<SortColumn<AtRiskDealRow> & { header: string; numeric: boolean; type2?: "date"; cell: (r: AtRiskDealRow) => React.ReactNode }> = [
  { key: "dealName", type: "text", accessor: (r) => r.dealName, header: "Deal Name", numeric: false, cell: (r) => <DealLink dealId={r.dealId}>{r.dealName}</DealLink> },
  { key: "ownerName", type: "text", accessor: (r) => r.ownerName, header: "Owner", numeric: false, cell: (r) => r.ownerName },
  { key: "stageName", type: "text", accessor: (r) => r.stageName, header: "Stage", numeric: false, cell: (r) => r.stageName },
  { key: "daysInStage", type: "number", accessor: (r) => r.daysInStage, header: "Days In Stage", numeric: true, cell: (r) => formatNumber(r.daysInStage) },
  { key: "value", type: "number", accessor: (r) => r.value, header: "Value", numeric: true, cell: (r) => formatCurrency(r.value) },
  { key: "lastActivityDate", type: "date", accessor: (r) => r.lastActivityDate, header: "Last Activity Date", numeric: false, cell: (r) => formatDate(r.lastActivityDate) },
];

function TopAtRiskTable({ rows }: { rows: AtRiskDealRow[] }) {
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, TOP_ATRISK_COLUMNS);
  if (rows.length === 0) return <EmptyState />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
          <tr>
            {TOP_ATRISK_COLUMNS.map((col) => {
              const hp = getHeaderProps(col.key);
              return (
                <th key={col.key} className={col.numeric ? "py-2 text-right" : "py-2"}>
                  <SortHeaderButton
                    label={col.header}
                    numeric={col.numeric}
                    active={hp.active}
                    dir={hp.dir}
                    onClick={() => toggle(col.key)}
                    className="text-xs font-black uppercase tracking-[0.14em] text-slate-500"
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sortedRows.map((deal) => (
            <tr key={deal.dealId}>
              {TOP_ATRISK_COLUMNS.map((col) => (
                <td key={col.key} className={col.numeric ? "py-3 text-right tabular-nums" : "py-3"}>
                  {col.cell(deal)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Swap the inline tables for the components** inside `DirectorScorecardPage`'s render:
  - Replace the `<ReportPanel title="Rep Performance">…</ReportPanel>` body with `<ReportPanel title="Rep Performance"><RepPerformanceTable rows={data.repPerformance} /></ReportPanel>`.
  - Replace the `<ReportPanel title="Top 5 At-Risk Deals">…</ReportPanel>` body with `<ReportPanel title="Top 5 At-Risk Deals"><TopAtRiskTable rows={data.topAtRiskDeals} /></ReportPanel>`.

- [ ] **Step 5: Verify build + typecheck**

Run: `cd client && npx tsc -p tsconfig.json --noEmit 2>&1 | grep director-scorecard || echo "no director-scorecard type errors"`
Expected: `no director-scorecard type errors`.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/reports/director-scorecard-page.tsx
git commit -m "feat(reports): sortable headers on Director Scorecard tables"
```

---

## Task 5: Apply to Customer Concentration (2 tables + pinned highlight)

**Files:**
- Modify: `client/src/pages/reports/customer-concentration-page.tsx`

The top-3 red highlight must **pin to the concentration ranking** (first three `companyId`s of the incoming server-ranked array), not display index — capture it once with `useMemo` before sorting.

- [ ] **Step 1: Add imports**

```tsx
import { useMemo } from "react";
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
import type { CustomerConcentrationReport } from "@/hooks/use-reports";
```

(The file currently has no `useMemo` import — add it. If `react` is not yet imported, add `import { useMemo } from "react";`.)

- [ ] **Step 2: Add the two table components** above `CustomerConcentrationPage`:

```tsx
type TopCustomerRow = CustomerConcentrationReport["topCustomers"][number];
type StaleCustomerRow = CustomerConcentrationReport["staleCustomers"][number];

const TOP_CUSTOMER_COLUMNS: ReadonlyArray<SortColumn<TopCustomerRow> & { header: string; numeric: boolean; cell: (r: TopCustomerRow) => React.ReactNode }> = [
  { key: "companyName", type: "text", accessor: (r) => r.companyName, header: "Company Name", numeric: false, cell: (r) => <span className="font-semibold text-slate-900">{r.companyName}</span> },
  { key: "activeDeals", type: "number", accessor: (r) => r.activeDeals, header: "Active Deals", numeric: true, cell: (r) => formatNumber(r.activeDeals) },
  { key: "totalOpenValue", type: "number", accessor: (r) => r.totalOpenValue, header: "Total Open Value", numeric: true, cell: (r) => formatCurrency(r.totalOpenValue) },
  { key: "totalWonLifetime", type: "number", accessor: (r) => r.totalWonLifetime, header: "Total Won", numeric: true, cell: (r) => formatCurrency(r.totalWonLifetime) },
  { key: "lastActivityAt", type: "date", accessor: (r) => r.lastActivityAt, header: "Last Activity", numeric: false, cell: (r) => formatDate(r.lastActivityAt) },
  { key: "accountOwners", type: "text", accessor: (r) => r.accountOwners, header: "Owners", numeric: false, cell: (r) => r.accountOwners },
];

function TopCustomersTable({ rows }: { rows: TopCustomerRow[] }) {
  // Pin the concentration flag to the DATA: the first three companies in the server-ranked
  // array are the most-concentrated. Membership-by-id, so the red flag marks the same three
  // accounts no matter how the user re-sorts the table.
  const concentratedIds = useMemo(() => new Set(rows.slice(0, 3).map((r) => r.companyId)), [rows]);
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, TOP_CUSTOMER_COLUMNS);
  return (
    <table className="mt-4 w-full min-w-[860px] text-sm">
      <thead className="text-left text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
        <tr>
          {TOP_CUSTOMER_COLUMNS.map((col) => {
            const hp = getHeaderProps(col.key);
            return (
              <th key={col.key} className={col.numeric ? "py-2 text-right" : "py-2"}>
                <SortHeaderButton
                  label={col.header}
                  numeric={col.numeric}
                  active={hp.active}
                  dir={hp.dir}
                  onClick={() => toggle(col.key)}
                  className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500"
                />
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {sortedRows.map((row) => (
          <tr key={row.companyId} className={concentratedIds.has(row.companyId) ? "bg-red-50/60" : undefined}>
            {TOP_CUSTOMER_COLUMNS.map((col) => (
              <td key={col.key} className={col.numeric ? "py-3 text-right tabular-nums" : "py-3"}>
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const STALE_CUSTOMER_COLUMNS: ReadonlyArray<SortColumn<StaleCustomerRow> & { header: string; numeric: boolean; cell: (r: StaleCustomerRow) => React.ReactNode }> = [
  { key: "companyName", type: "text", accessor: (r) => r.companyName, header: "Company", numeric: false, cell: (r) => <span className="font-semibold text-slate-900">{r.companyName}</span> },
  { key: "ownerName", type: "text", accessor: (r) => r.ownerName, header: "Owner", numeric: false, cell: (r) => r.ownerName },
  { key: "openDeals", type: "number", accessor: (r) => r.openDeals, header: "Open Deals", numeric: true, cell: (r) => formatNumber(r.openDeals) },
  { key: "openValue", type: "number", accessor: (r) => r.openValue, header: "Open Value", numeric: true, cell: (r) => formatCurrency(r.openValue) },
  { key: "daysStale", type: "number", accessor: (r) => r.daysStale, header: "Days Stale", numeric: true, cell: (r) => formatNumber(r.daysStale) },
];

function StaleCustomersTable({ rows }: { rows: StaleCustomerRow[] }) {
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, STALE_CUSTOMER_COLUMNS);
  return (
    <table className="mt-4 w-full min-w-[720px] text-sm">
      <thead className="text-left text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
        <tr>
          {STALE_CUSTOMER_COLUMNS.map((col) => {
            const hp = getHeaderProps(col.key);
            return (
              <th key={col.key} className={col.numeric ? "py-2 text-right" : "py-2"}>
                <SortHeaderButton
                  label={col.header}
                  numeric={col.numeric}
                  active={hp.active}
                  dir={hp.dir}
                  onClick={() => toggle(col.key)}
                  className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500"
                />
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {sortedRows.map((row) => (
          <tr key={`${row.companyName}-${row.ownerName}`}>
            {STALE_CUSTOMER_COLUMNS.map((col) => (
              <td key={col.key} className={col.numeric ? "py-3 text-right tabular-nums" : "py-3"}>
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Swap the inline tables** in `CustomerConcentrationPage`:
  - Replace the Top-20 `<table>…</table>` (lines ~36-59) with `<TopCustomersTable rows={report.topCustomers} />` (keep the surrounding `<h2>` heading and the `report.topCustomers.length === 0 ? <EmptyState/> : null` after it).
  - Replace the Stale `<table>…</table>` (lines ~106-127) with `<StaleCustomersTable rows={report.staleCustomers} />`.

- [ ] **Step 4: Verify typecheck**

Run: `cd client && npx tsc -p tsconfig.json --noEmit 2>&1 | grep customer-concentration || echo "no customer-concentration type errors"`
Expected: `no customer-concentration type errors`.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/reports/customer-concentration-page.tsx
git commit -m "feat(reports): sortable headers on Customer Concentration + pinned concentration flag"
```

---

## Task 6: Apply to At-Risk Watchlist (via PipelineStageTable ReactNode headers)

**Files:**
- Modify: `client/src/pages/reports/at-risk-page.tsx`

`PipelineStageTable` is **not** modified — its `header` is already a `ReactNode`. The page owns the `useTableSort` state; each column's `header` becomes a `<SortHeaderButton>`, and `rows={sortedRows}`. `initialSort: null` preserves the server's $-at-risk-desc order. The "Why at-risk" column uses a custom `compare` with an explicit reason order so it groups cleanly.

- [ ] **Step 1: Add imports**

```tsx
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
```

- [ ] **Step 2: Define sort columns + wire the hook** inside `AtRiskPage`, after `const records = useMemo(...)` (records is the filtered array passed to the table today). Add:

```tsx
// Explicit reason ranking so the "Why at-risk" column GROUPS by category (all Past due, then all
// No close date) — deliberate grouping, not incidental alphabetical on the badge label spelling.
const REASON_ORDER: Record<AtRiskRecord["reason"], number> = { stale_dated: 0, no_date: 1 };

const sortColumns: ReadonlyArray<SortColumn<AtRiskRecord>> = [
  { key: "deal", type: "text", accessor: (r) => r.name },
  { key: "owner", type: "text", accessor: (r) => r.repName },
  { key: "stage", type: "text", accessor: (r) => r.stageLabel },
  { key: "days", type: "number", accessor: (r) => r.daysInStage },
  { key: "reason", type: "text", accessor: (r) => r.reason, compare: (a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] },
  { key: "value", type: "number", accessor: (r) => r.value },
];

const { sortedRows, toggle, getHeaderProps } = useTableSort(records, sortColumns);
```

- [ ] **Step 3: Make each column header a SortHeaderButton.** Replace the existing `columns` array's `header` strings. For each column, build a header helper. Replace the `const columns: Array<PipelineStageTableColumn<AtRiskRecord>> = [ … ]` definition so each `header` is:

```tsx
const sortHeader = (key: string, label: string, numeric = false) => {
  const hp = getHeaderProps(key);
  return (
    <SortHeaderButton
      label={label}
      numeric={numeric}
      active={hp.active}
      dir={hp.dir}
      onClick={() => toggle(key)}
      className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500"
    />
  );
};

const columns: Array<PipelineStageTableColumn<AtRiskRecord>> = [
  { key: "deal", header: sortHeader("deal", "Deal"), render: (r) => (
      <div className="min-w-0">
        <div className="truncate font-medium text-slate-800">{r.name}</div>
        {r.dealNumber ? <div className="text-xs text-slate-400">#{r.dealNumber}</div> : null}
      </div>
    ) },
  { key: "owner", header: sortHeader("owner", "Owner"), render: (r) => <span className="text-slate-600">{r.repName}</span> },
  { key: "stage", header: sortHeader("stage", "Stage"), render: (r) => <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{r.stageLabel || "—"}</span> },
  { key: "days", header: sortHeader("days", "In stage", true), cellClassName: "whitespace-nowrap tabular-nums text-slate-500", render: (r) => (r.daysInStage == null ? "—" : `${int(r.daysInStage)}d`) },
  { key: "reason", header: sortHeader("reason", "Why at-risk"), render: (r) => {
      const b = REASON_BADGE[r.reason];
      const close = r.reason === "stale_dated" && r.expectedCloseDate ? ` · ${formatDayShort(r.expectedCloseDate)}` : "";
      return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${b.cls}`}>{b.label}{close}</span>;
    } },
  { key: "value", header: sortHeader("value", "$ at risk", true), headClassName: "text-right", cellClassName: "text-right font-semibold tabular-nums text-slate-800", render: (r) => usd(r.value) },
];
```

- [ ] **Step 4: Pass `sortedRows` to the table.** In the `<PipelineStageTable …>` JSX, change `rows={records}` to `rows={sortedRows}` and `pageSize: records.length`/`total: records.length` stay as `sortedRows.length` (same length, but use `sortedRows.length` for clarity).

- [ ] **Step 5: Verify typecheck**

Run: `cd client && npx tsc -p tsconfig.json --noEmit 2>&1 | grep at-risk-page || echo "no at-risk-page type errors"`
Expected: `no at-risk-page type errors`.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/reports/at-risk-page.tsx
git commit -m "feat(reports): sortable headers on At-Risk Watchlist (PipelineStageTable headers)"
```

---

## Task 7: Apply to Platform Usage Leaderboard (grid, initialSort actions-desc)

**Files:**
- Modify: `client/src/pages/reports/platform-usage-page.tsx`

This is the grid-not-`<table>` proof. The header row is the grid `<div>` (`GRID` template). Replace the existing `useMemo`-sort with `useTableSort(..., { initialSort: { key: "actions", dir: "desc" } })` so today's "ranked by actions desc" default is preserved, and each header label becomes a `<SortHeaderButton>`. The `#` rank column reflects display order and is not independently sortable.

- [ ] **Step 1: Add imports**

```tsx
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
```

- [ ] **Step 2: Replace the `rows` useMemo** (lines ~53-56). Define sort columns and drive the hook off the raw leaderboard:

```tsx
const SORT_COLUMNS: ReadonlyArray<SortColumn<PlatformUsageRow>> = [
  { key: "rep", type: "text", accessor: (r) => r.rep.displayName },
  { key: "actions", type: "number", accessor: (r) => r.usage.actionCount },
  { key: "active", type: "number", accessor: (r) => r.usage.activeSeconds },
  { key: "sessions", type: "number", accessor: (r) => r.usage.sessionCount },
  { key: "views", type: "number", accessor: (r) => r.usage.viewCount },
];

const leaderboard = data?.leaderboard ?? [];
const { sortedRows: rows, toggle, getHeaderProps } = useTableSort(leaderboard, SORT_COLUMNS, {
  initialSort: { key: "actions", dir: "desc" },
});
```

Delete the old `const rows = useMemo<PlatformUsageRow[]>(...)`. Keep the `maxActions` useMemo (it reads `rows`).

- [ ] **Step 3: Pass sort handles into `Leaderboard`.** Change the `Leaderboard` call (line ~167) to:

```tsx
<Leaderboard rows={rows} maxActions={maxActions} detailHref={detailHref} toggle={toggle} getHeaderProps={getHeaderProps} />
```

And extend `Leaderboard`'s props + header row. Replace the `Leaderboard` function's signature and header `<div>`:

```tsx
function Leaderboard({
  rows,
  maxActions,
  detailHref,
  toggle,
  getHeaderProps,
}: {
  rows: PlatformUsageRow[];
  maxActions: number;
  detailHref: (repId: string) => string;
  toggle: (key: string) => void;
  getHeaderProps: (key: string) => { active: boolean; dir: "asc" | "desc" | null };
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        No reps to show for this period.
      </div>
    );
  }
  const headerCell = (key: string, label: string, numeric: boolean) => {
    const hp = getHeaderProps(key);
    return (
      <SortHeaderButton
        label={label}
        numeric={numeric}
        active={hp.active}
        dir={hp.dir}
        onClick={() => toggle(key)}
        className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
      />
    );
  };
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className={cn(GRID, "border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400")}>
        <div>#</div>
        <div>{headerCell("rep", "Rep · Actions", false)}</div>
        <div className="text-right">{headerCell("active", "Active", true)}</div>
        <div className="text-right">{headerCell("sessions", "Sessions", true)}</div>
        <div className="text-right">{headerCell("views", "Views", true)}</div>
      </div>
      <div className="divide-y divide-slate-50">
        {rows.map((r, i) => (
          <RepRow
            key={r.rep.id}
            row={r}
            rank={i + 1}
            maxActions={maxActions}
            isTop={i === 0 && r.usage.actionCount > 0}
            href={detailHref(r.rep.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

Note: the "Rep · Actions" header column maps to the `rep` sort key (alpha by rep); Actions has its own implicit primary via the proportion bar. If a dedicated Actions sort is wanted later, it's `actions` — out of scope for the visual parity of this column. The `isTop`/rank visual stays display-relative (top of the current sort).

- [ ] **Step 4: Verify typecheck**

Run: `cd client && npx tsc -p tsconfig.json --noEmit 2>&1 | grep platform-usage-page || echo "no platform-usage-page type errors"`
Expected: `no platform-usage-page type errors`.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/reports/platform-usage-page.tsx
git commit -m "feat(reports): sortable headers on Platform Usage leaderboard (grid, actions-desc default)"
```

---

## Task 8: Full gate + visual smoke

- [ ] **Step 1: Run the full premerge gate**

Run: `npm run check:premerge`
Expected: build succeeds, `typecheck:tests:all` clean, `test:runtime` PASSES (includes the three new `*.runtime.test.*` files).

- [ ] **Step 2: Visual smoke (optional, recommended).** Start the app and confirm each of the four tables: clicking a heading toggles the caret and reorders rows; numeric columns order numerically (e.g. 9 before 100 when desc); blanks stay last; Customer Concentration's red flag stays on the same three rows after sorting by name.

Use the `verify` or `run` skill / project run command to launch, navigate to: Director Scorecard, Customer Concentration, At-Risk Watchlist, Platform Usage.

- [ ] **Step 3: Final commit / push for review**

```bash
git status
git push -u origin feat/sortable-column-headers-reports
```

Then request review (Adnaan merges — no self-merge). Note in the PR: pass 1 only; Region + Forecast/Showcase + Closed-Won + Evidence-Drawer migration deferred to pass 2 per the spec.

---

## Self-Review Notes

- **Spec coverage:** hook (Task 2), comparators (Task 1), button (Task 3), four tables with preserved `initialSort` (Tasks 4-7: Director Scorecard null, Customer Concentration null, At-Risk null, Platform Usage actions-desc), pinned concentration highlight (Task 5), explicit Why-at-risk grouping (Task 6), runtime-test placement of guarantees (Tasks 1-3). Region/Forecast/Closed-Won/drawer migration explicitly deferred (Task 8 PR note).
- **Type consistency:** `SortColumn<Row>`, `SortState`, `UseTableSortResult`, `SortDirection`, `ColumnType` are defined once in Task 2 and reused verbatim in Tasks 4-7. `getHeaderProps` returns `{ active, dir }` everywhere. `compare` is direction-agnostic (hook negates) — used only by the At-Risk reason column.
- **No placeholders:** every step shows complete code or an exact command + expected output.
