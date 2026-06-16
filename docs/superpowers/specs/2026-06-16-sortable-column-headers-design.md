# Reusable Sortable Column Headers — Design (Pass 1: Reports)

**Date:** 2026-06-16
**Owner:** Adnaan's lane (sort interaction). **Coordination:** Lane 3 owns report structure/consolidation — this work is purely additive and touches no report structure.
**Status:** Approved for spec review → implementation.

## Goal

One shared, reusable sortable-column-header pattern, applied to Reports first. Click a column heading → sort the table by that column; click again → toggle asc/desc; a clear indicator marks the active column and direction. Numeric columns sort **numerically** (not lexically), text **alphabetically**, dates **chronologically**. Built **once** as a shared hook + presentational header, not re-implemented per table.

This document specifies the shared abstraction and the four pass-1 tables it is applied to. Properties and Companies are a later pass and out of scope here.

## Background / why this shape

The codebase already contains the gold-standard version of this pattern, hand-rolled inside `client/src/pages/reports/monday-showcase/evidence-drawer.tsx`: client-side `{ key, dir }` sort state, per-type accessors, an asc/desc toggle with a sensible default direction per column type, and a three-state header icon (`ChevronsUpDown` neutral → `ArrowUp` → `ArrowDown`). It is not reused anywhere else; every other table is unsorted or has a bespoke mini-sort (e.g. the B2 leaderboard).

The pass-1 target tables come in **three different markup shapes**:

| Surface | Markup shape |
| --- | --- |
| Director Scorecard, Customer Concentration tables | plain `<table>` / `<thead>` / `<th>` |
| At-Risk Watchlist | `PipelineStageTable<T>` (generic column-config component; `header` is a `ReactNode`) |
| Platform Usage Leaderboard | **CSS-grid `<div>`s — not a `<table>` at all** |

Because the surfaces are not all `<table>`s, the shared unit **cannot be a `<table>`-coupled `<SortableTable>` component** without rewriting `PipelineStageTable` (shared with deals/pipeline — out of scope) and the grid leaderboard. The chosen design is therefore a **headless hook + a container-agnostic header button**, which applies additively to all three shapes.

## Architecture — three small, independently-testable units

Location: `client/src/components/reports/sortable/` (component) and the hook colocated there (e.g. `use-table-sort.ts`, `comparators.ts`, `sort-header-button.tsx`, `index.ts`). Reports-scoped now; promotable to a more general path when Properties/Companies adopt it in a later pass.

### 1. `useTableSort<Row>` — headless hook

Holds sort state, returns sorted rows + the props each header needs. Knows nothing about markup.

```ts
type SortDirection = "asc" | "desc";

type ColumnType = "text" | "number" | "date";

interface SortColumn<Row> {
  key: string;                      // stable column id; what toggle()/active compare against
  type: ColumnType;                 // drives default direction + which comparator is used
  accessor: (row: Row) => string | number | null | undefined;
  // Optional escape hatch for a column whose ordering isn't a plain field
  // (e.g. an enum sorted by label). When present it wins over type/accessor.
  compare?: (a: Row, b: Row) => number;
}

interface SortState {
  key: string;
  dir: SortDirection;
}

interface UseTableSortOptions {
  // Preserve each table's current default order. null => no reorder on load
  // (sortedRows is the input order, stable) until the user clicks a header.
  initialSort?: SortState | null;
}

interface UseTableSortResult<Row> {
  sortedRows: Row[];
  sortState: SortState | null;
  toggle: (key: string) => void;
  // Convenience for header rendering — derive active/dir for a given column.
  getHeaderProps: (key: string) => { active: boolean; dir: SortDirection | null };
}

function useTableSort<Row>(
  rows: Row[],
  columns: ReadonlyArray<SortColumn<Row>>,
  options?: UseTableSortOptions,
): UseTableSortResult<Row>;
```

Behavior:

- **Default direction on first click** (matches the drawer convention): `number` and `date` columns → first click is **desc** (biggest/most-recent first — the common intent); `text` columns → first click is **asc** (A→Z).
- **Toggle:** clicking the already-active column flips `dir`; clicking a different column switches to it at that column's default direction.
- **`initialSort`:** when `null`, `sortedRows` is referentially the input order (no sort applied, stable) — this is how each table "honors its existing default order, no reorder on load." When set, that column/direction is applied on first render.
- **Stability:** sort is stable (ES2019 `Array.prototype.sort`), so equal keys keep their incoming (server) order — the secondary ordering stays whatever the server returned.
- Sorting is **client-side over the full row set** already in memory; it never drops or paginates rows.

### 2. Comparators — pure functions

```ts
// nullish (null/undefined/"" for text, null/undefined for number/date) ALWAYS sorts last,
// in BOTH directions. See "Known behavior note" below.
function compareText(a, b, dir): number;    // localeCompare, case-insensitive
function compareNumber(a, b, dir): number;  // numeric subtraction — never string compare
function compareDate(a, b, dir): number;    // ISO/Date chronological
```

- **Numeric** uses numeric comparison, so `9 < 10 < 100` (not lexical `"10" < "100" < "9"`). This is the headline correctness requirement and gets a direct test.
- **Date** compares chronologically on the ISO date string / timestamp, nulls last.
- **Text** uses case-insensitive `localeCompare`.
- **Nullish always last (both directions).** A blank/`null`/`undefined` value sorts to the bottom whether ascending or descending — blanks are "unknown," never "0" or "zzz".

**Known behavior note (for pass 2):** this nulls-last-both-ways rule is intentionally *better* than the Evidence Drawer's current behavior, which coerces blanks to `NEGATIVE_INFINITY` (blanks sink only on desc, float to top on asc). When the drawer migrates onto this shared hook in **pass 2**, its null ordering changes slightly. This is a deliberate, documented behavior change to apply at migration — not a regression.

### 3. `<SortHeaderButton>` — presentational, container-agnostic

The Evidence Drawer's exact button + 3-state icon affordance, extracted so it drops into a `<th>`, a `PipelineStageTable` column `header` ReactNode, or a grid `<div>` alike.

```tsx
interface SortHeaderButtonProps {
  label: ReactNode;
  active: boolean;
  dir: SortDirection | null;   // null when not the active column
  numeric?: boolean;           // right-align + reverse caret so it hugs the number edge
  onClick: () => void;
  className?: string;          // passthrough so each report keeps its own header typography
}
```

- Icon states: not active → `ChevronsUpDown` (muted); active asc → `ArrowUp`; active desc → `ArrowDown`.
- Renders a real `<button type="button">` with an accessible `title`/`aria-label` ("Sort by {label}") and `aria-sort` is set on the host header where the markup allows (`<th>`); for the grid leaderboard the button alone carries the affordance.
- `numeric` mirrors the drawer: `flex-row-reverse` so the caret sits on the edge the numbers align to.
- Visual styling is inherited via `className` so we do **not** restyle any existing report header — we only add the icon + click affordance.

## Pass-1 tables and their preserved default sort

Each table keeps the order it shows today (`initialSort`), and gains clickable, type-correct sorting on every column. Row types are the real production types (named for the tests).

### A. Director Scorecard — `director-scorecard-page.tsx`

Row type: `DirectorScorecardReport.repPerformance[]` / `.topAtRiskDeals[]` (`hooks/use-reports.ts`).

**Rep Performance** — `initialSort: null` (server order).
| Column | type | accessor |
| --- | --- | --- |
| Rep Name | text | `repName` |
| Open Deals | number | `openDeals` |
| Pipeline Value | number | `pipelineValue` |
| Won This Period | number | `wonThisPeriod` |
| Win Rate | number | `winRate` |
| Activity Score | number | `activityScore` |

**Top 5 At-Risk Deals** — `initialSort: null` (server order).
| Column | type | accessor |
| --- | --- | --- |
| Deal Name | text | `dealName` |
| Owner | text | `ownerName` |
| Stage | text | `stageName` |
| Days In Stage | number | `daysInStage` |
| Value | number | `value` |
| Last Activity Date | date | `lastActivityDate` (nullable) |

*(Office Comparison is a card grid — not sorted, out of scope, same rationale as Region.)*

### B. Customer Concentration — `customer-concentration-page.tsx`

Row type: `CustomerConcentrationReport.topCustomers[]` / `.staleCustomers[]`.

**Top 20 Customers** — `initialSort: null` (server order; top-3 red highlight rows stay highlighted regardless of sort since the highlight is index-based today — **note:** highlight will follow re-sort, i.e. it marks the top 3 *as displayed*; confirm acceptable, else key the highlight off rank. Default: keep index-based = "top 3 shown").
| Column | type | accessor |
| --- | --- | --- |
| Company Name | text | `companyName` |
| Active Deals | number | `activeDeals` |
| Total Open Value | number | `totalOpenValue` |
| Total Won | number | `totalWonLifetime` |
| Last Activity | date | `lastActivityAt` (nullable) |
| Owners | text | `accountOwners` |

**Stale Customers** — `initialSort: null` (server order).
| Column | type | accessor |
| --- | --- | --- |
| Company | text | `companyName` |
| Owner | text | `ownerName` |
| Open Deals | number | `openDeals` |
| Open Value | number | `openValue` |
| Days Stale | number | `daysStale` |

### C. At-Risk Watchlist — `at-risk-page.tsx` (via `PipelineStageTable`)

Row type: `AtRiskRecord` (`pages/reports/part4-types.ts`). `initialSort: null` (server order = $ at risk desc).

`PipelineStageTable` is **not** modified. Its `PipelineStageTableColumn.header` is already a `ReactNode`, so each column's `header` becomes a `<SortHeaderButton>` and the page owns the `useTableSort` state, passing `sortedRows` as `rows`.

| Column | type | accessor |
| --- | --- | --- |
| Deal | text | `name` |
| Owner | text | `repName` |
| Stage | text | `stageLabel` |
| In stage | number | `daysInStage` (nullable) |
| Why at-risk | text | `reason` (custom `compare` on the badge label "No close date" / "Past due", so it sorts by what's shown) |
| $ at risk | number | `value` |

### D. Platform Usage — Leaderboard — `platform-usage-page.tsx`

Row type: `PlatformUsageRow` (`hooks/use-platform-usage-report.ts`). **This is the grid-not-table proof.** `initialSort: { key: "actions", dir: "desc" }` to preserve today's "ranked by actions desc" default (the existing `useMemo`-sort is removed and replaced by the hook with this initial state).

The header row is the grid `<div>`; each header cell wraps its label in `<SortHeaderButton>`.

| Column | type | accessor |
| --- | --- | --- |
| Rep | text | `rep.displayName` |
| Actions | number | `usage.actionCount` |
| Active | number | `usage.activeSeconds` |
| Sessions | number | `usage.sessionCount` |
| Views | number | `usage.viewCount` (nullable/undefined → last) |

*(Rank `#` column is derived from display order and is not independently sortable; it reflects current position.)*

## Explicitly out of scope (pass 1)

- **Region Report** — deferred. No conventional column-header row-table (cards + heatmap pivot). Revisit if it grows a real table.
- **Forecast/Showcase (Monday Showcase variants, Forecast Confidence, the Ladder) and Closed Won Revenue** — Lane 3 is consolidating these. Pass 2 adds the sort layer to the consolidated result, including the specifically-requested **Forecast Ladder drill-down sorted by %**.
- **Evidence Drawer refactor** — it already sorts and is shared with Lane-3 surfaces. Extract the pattern from it; leave it untouched in pass 1; migrate it onto the shared hook in pass 2 (applying the documented nulls-last behavior change).
- **Persisting sort** across navigation / URL state — not requested; sort is local component state.
- **Server-side sort / pagination interplay** — all pass-1 tables sort the full in-memory set.

## Testing

Real production types, no inline redefinitions. Repo convention: colocated `*.test.ts(x)`, jsdom via `// @vitest-environment jsdom` pragma, raw React DOM (`createRoot`/`act`), no `@testing-library`. CI runs only `*.runtime.test.*` — the **core guarantees go in a `*.runtime.test.ts` file so they execute in the premerge gate**.

Comparator/hook unit tests (against real types — `DirectorScorecardReport["repPerformance"][number]`, `AtRiskRecord`, `PlatformUsageRow`, etc.):

1. **Numeric sorts numerically, not lexically:** `[9, 10, 100]` asc/desc order is correct, and a column with values `9, 10, 100` does **not** order as `10, 100, 9`.
2. **Text sorts alphabetically**, case-insensitive.
3. **Dates sort chronologically** (e.g. `lastActivityDate` ascending/descending), not by string surface form where they'd diverge.
4. **Nullish last in both directions** — a null `lastActivityDate` / undefined `viewCount` is last on asc **and** desc.
5. **Toggle semantics:** first click on a numeric column → desc; on a text column → asc; second click flips; switching columns resets to the new column's default direction.
6. **`initialSort: null` preserves input order** (no reorder before first click); **`initialSort` set** applies on first render (Platform Usage actions-desc).
7. **Stability:** equal-keyed rows preserve incoming order.

A small `*.runtime.test.tsx` renders one header (e.g. via `<SortHeaderButton>`) to assert the 3-state icon + `aria` affordance in CI.

## Process / gates

- Branch off `main`; standard premerge gate (`npm run check:premerge`). **Adnaan merges; no self-merge.**
- Purely additive on collision-free surfaces; no report structure renamed, consolidated, or restructured.
- If any pass-1 table turns out to be mid-restructure by Lane 3 at build time, skip it and report — do not edit structure they own.
