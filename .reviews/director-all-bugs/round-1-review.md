# Round 1 Review

## Findings

### 1. Bug 7 is only partially fixed: positive buckets still get a fabricated 4% width

**Severity:** P2

The zero-bucket filtering was added, but the rendered segment width still uses `Math.max((part.value / total) * 100, 4)` in `client/src/pages/director/director-dashboard-page.tsx:225-230`. That preserves the same fabricated minimum-width behavior for any non-zero bucket below 4%. The requested fix was "Filter zero-value buckets only; total zero empty bar." After this change, a bucket that is 1% of the total still renders as 4%, so the distribution can still misrepresent the data.

**Suggested fix:** remove the `Math.max(..., 4)` floor and render `width: ${(part.value / total) * 100}%` after filtering zero-value buckets. Keep the `total === 0` empty-bar branch at `client/src/pages/director/director-dashboard-page.tsx:218-220`.

**Test gap:** `client/src/pages/director/director-dashboard-page.test.tsx:652-669` only proves zero buckets are omitted and `width:4%` is absent for zero values. Add a small-positive-bucket case, for example 1/100, and assert it does not render as `4%`.

### 2. Bug 10 still shows derived zeroed metrics during rep-performance loading/error

**Severity:** P2

The page now displays a loading/error banner, but several derived values are still computed from `perfData ?? 0` before the loading/error guard: `closedValue`, `closedCount`, goal gap, pace, and remaining-weeks messaging are computed at `client/src/pages/director/director-dashboard-page.tsx:344-353`. During loading, the main value hides `closedValue` as `--`, but the detail line can still show a synthetic gap such as `$500,000 behind goal · 8 weeks remaining` because `goalGap` is based on `closedValue = 0` at `client/src/pages/director/director-dashboard-page.tsx:491-497`. During an error, the main line renders `formatCurrency(closedValue)` instead of suppressing the stale/zeroed metric, because only `perfLoading` is checked at `client/src/pages/director/director-dashboard-page.tsx:491-492`.

This does not fully satisfy "Show skeleton/loading and error banner, not zeroed metrics." The banner is present, but zero-derived metrics can still leak into the forecast panel and KPI state.

**Suggested fix:** gate all perf-derived values behind a usable-performance-data boolean such as `Boolean(perfData) && !perfLoading && !perfError`. For loading/error, show a skeleton/placeholder for the main value and suppress or replace the gap/pace text with the loading/error state.

**Test gap:** `client/src/pages/director/director-dashboard-page.test.tsx:671-689` only asserts that the loading/error text appears. It should also assert that zero-derived values and "behind goal" calculations are not rendered while performance data is loading or errored.

## Bug-by-Bug Verdict

### Bug 1 (P1) - Period preset mapping broken for historical periods

**Verdict:** Mostly fixed for the dashboard read path.

The frontend now passes the specific period kinds instead of legacy `"month" | "quarter" | "year"` mappings. `RepPerformancePeriodKind` includes `last_month`, `last_quarter`, and `last_year` at `client/src/hooks/use-rep-performance.ts:4-11`; legacy normalization only maps the old current-period names at `client/src/hooks/use-rep-performance.ts:107-112`; `fetchRepPerformance` sends `periodKind` directly at `client/src/hooks/use-rep-performance.ts:201-207`. The director page passes the selected preset to both hooks at `client/src/pages/director/director-dashboard-page.tsx:276-287`.

The director dashboard route validates and passes `periodKind` through at `server/src/modules/dashboard/routes.ts:56-66`, and the service uses it when reading snapshots at `server/src/modules/dashboard/service.ts:1961-1963`. The rep-performance route already validates and passes the same contract at `server/src/modules/dashboard/routes.ts:97-105`.

Period boundaries are computed in the worker snapshot generator with UTC date helpers at `worker/src/jobs/rep-performance-rollup.ts:35-63`, including correct previous month, previous quarter, and previous year ranges. The page's date preset helper still uses local-time calendar values at `client/src/hooks/use-director-dashboard.ts:269-308`, while the worker uses UTC. That can create edge-case mismatches near local/UTC midnight, but the historical rep-performance snapshot selection itself is now period-kind based.

**Tests:** Good client and route coverage for passing historical period kinds. There is no new end-to-end assertion that `last_quarter` renders data from a snapshot with the expected `period_start`/`period_end`.

### Bug 2 (P1) - Forecast vs goal uses fixed MTD source

**Verdict:** Fixed for source selection, with backend goal limitations unchanged.

The page now prefers period-aware rep-performance data over dashboard fallback at `client/src/pages/director/director-dashboard-page.tsx:344-348`, and the dashboard endpoint also receives `periodKind` at `client/src/hooks/use-director-dashboard.ts:322-329` / `server/src/modules/dashboard/routes.ts:61-66`.

The backend `getRepPerformanceSnapshots` still builds `forecastVsGoal` with `goal: null` from snapshot pipeline total at `server/src/modules/dashboard/service.ts:1755-1759`, so the implementation avoids showing MTD goal data but does not add period-aware configured goal support. If configured goals are expected per period, that remains a product/data gap.

**Tests:** The page test at `client/src/pages/director/director-dashboard-page.test.tsx:586-590` verifies that the page prefers mocked `perfData`. It does not verify real backend goal behavior.

### Bug 3 (P1) - At-risk rep count collapses to "Unassigned"

**Verdict:** Fixed for the fallback `atRiskDeals` payload.

The backend adds `repId` and `repName` to `DashboardDownstreamBottleneckRow` at `server/src/modules/dashboard/service.ts:306-319`, selects them in `getDownstreamBottlenecks` at `server/src/modules/dashboard/service.ts:459-472`, maps them at `server/src/modules/dashboard/service.ts:492-495`, and returns those rows as `atRiskDeals` at `server/src/modules/dashboard/service.ts:2003-2004`. The page counts distinct `deal.repName` values at `client/src/pages/director/director-dashboard-page.tsx:339-343`.

One contract cleanup remains: the client `downstreamBottlenecks` type still omits `repId`/`repName` at `client/src/hooks/use-director-dashboard.ts:86-96`, even though the backend row now includes them. The `atRiskDeals` client type was updated at `client/src/hooks/use-director-dashboard.ts:97-109`, so the director page path is covered.

**Tests:** Good focused coverage at `server/tests/modules/dashboard/service.test.ts:439-489` and `client/src/pages/director/director-dashboard-page.test.tsx:593-634`.

### Bug 4 (P1) - Refresh only refetches dashboard, not rep performance

**Verdict:** Fixed.

The refresh button invokes both `refetch()` and `refetchPerformance()` at `client/src/pages/director/director-dashboard-page.tsx:424-431`.

**Tests:** Covered by `client/src/pages/director/director-dashboard-page.test.tsx:637-650`.

### Bug 5 (P2) - Weeks remaining shows 0 throughout period

**Verdict:** Fixed for normal current-period presets, with timezone edge cases.

`periodEndForPreset` now maps MTD/QTD/YTD to the end of the current month/quarter/year instead of using the selected date range's `to` value, and the forecast panel calls it at `client/src/pages/director/director-dashboard-page.tsx:145-160` and `client/src/pages/director/director-dashboard-page.tsx:351-352`. This should stop QTD from showing 0 simply because the fetch range ends today.

Timezone note: `periodEndForPreset` uses local `getFullYear()`/`getMonth()`, while `weeksRemaining` compares against a UTC end-of-day timestamp at `client/src/pages/director/director-dashboard-page.tsx:135-142`. Around local/UTC day boundaries, the count can move a few hours early or late. The worker snapshot ranges use UTC (`worker/src/jobs/rep-performance-rollup.ts:35-63`), so the frontend and backend are not using one shared period-boundary helper.

**Tests:** The static page test checks the happy path displays `8 weeks remaining` at `client/src/pages/director/director-dashboard-page.test.tsx:489-490`. There are no boundary tests for quarter end, year end, or timezone-adjacent times.

### Bug 6 (P2) - At-risk drilldown link wrong destination

**Verdict:** Fixed.

The page chooses the rendered dataset first (`staleDeals` if present, fallback `atRiskDeals` otherwise) and derives the link from that choice at `client/src/pages/director/director-dashboard-page.tsx:339-341`, then renders it at `client/src/pages/director/director-dashboard-page.tsx:690-697`.

**Tests:** Covered for the fallback dataset at `client/src/pages/director/director-dashboard-page.test.tsx:593-634`. There is no explicit assertion that the stale-deals dataset still routes to `/reports#stale-deals`.

### Bug 7 (P2) - Distribution segments fabricated 4% min width

**Verdict:** Not fully fixed.

Zero buckets are now filtered and total-zero rows render an empty bar at `client/src/pages/director/director-dashboard-page.tsx:218-230`, but the remaining positive buckets still use a 4% minimum width. See Finding 1.

**Tests:** Inadequate for small positive buckets.

### Bug 8 (P2) - Closing this week label hard-coded

**Verdict:** Fixed.

The closing metric now uses `activityPeriodLabel` instead of the hard-coded "this week" text at `client/src/pages/director/director-dashboard-page.tsx:507-510`. The label map covers all presets at `client/src/pages/director/director-dashboard-page.tsx:53-61`.

**Tests:** Covered indirectly by the QTD assertion at `client/src/pages/director/director-dashboard-page.test.tsx:489-492`.

### Bug 9 (P2) - Activity pulse this week mislabeled

**Verdict:** Fixed.

The heading now uses `periodLabel` at `client/src/pages/director/director-dashboard-page.tsx:781-785`, and the empty state uses the same selected period at `client/src/pages/director/director-dashboard-page.tsx:821-822`. The underlying dashboard activity pulse is populated from the selected rep-performance snapshot period at `server/src/modules/dashboard/service.ts:2005-2014`.

**Tests:** Covered for QTD by `client/src/pages/director/director-dashboard-page.test.tsx:557-565`.

### Bug 10 (P2) - Rep performance loading/error state ignored

**Verdict:** Partially fixed.

The hook exposes `loading`, `error`, and `refetch` at `client/src/hooks/use-rep-performance.ts:233-252`, and the page renders a loading/error banner at `client/src/pages/director/director-dashboard-page.tsx:482-490`. However, zero-derived metrics still leak through during loading/error. See Finding 2.

**Tests:** Inadequate because they only check the banner text.

### Bug 11 (P2) - Export button no handler

**Verdict:** Fixed.

The export button is wired at `client/src/pages/director/director-dashboard-page.tsx:545-553`. CSV cells are quote-escaped at `client/src/pages/director/director-dashboard-page.tsx:238-242`, and the generated CSV uses the rendered rep rows plus period-aware snapshot data where available at `client/src/pages/director/director-dashboard-page.tsx:365-391`.

Edge case: if rep-performance data is loading or errored, the export still succeeds but may mix dashboard card values with missing snapshot fields. That is acceptable if the export is intended to mirror the currently available table, but not if the button is expected to export only validated period-aware performance data.

**Tests:** Good basic coverage at `client/src/pages/director/director-dashboard-page.test.tsx:691-733`, including object URL creation, click, revoke, header, and a sample row. There is no escaping test for commas/quotes/newlines in rep names or regions.

### Bug 12 (P3) - Synced just now hard-coded

**Verdict:** Fixed.

`useDirectorDashboard` tracks `lastFetchedAt` after a successful fetch at `client/src/hooks/use-director-dashboard.ts:312-343`, and the page renders `formatFreshness(lastFetchedAt)` at `client/src/pages/director/director-dashboard-page.tsx:163-173` and `client/src/pages/director/director-dashboard-page.tsx:400-405`.

**Tests:** Covered for a 3-minute-old fetch timestamp at `client/src/pages/director/director-dashboard-page.test.tsx:450-457`.

## Overall Assessment

The P1 data-path fixes are largely in place: historical period kinds now flow from the preset controls to both dashboard endpoints, fallback at-risk rows carry rep attribution, refresh hits both hooks, and forecast source selection is no longer hard-coded to MTD.

I would not approve yet because Bug 7 is still behaviorally wrong for small positive distribution buckets, and Bug 10 still renders zero-derived performance metrics during loading/error states. I would also add boundary coverage for period-end/week calculations and a CSV escaping test before considering this complete.
