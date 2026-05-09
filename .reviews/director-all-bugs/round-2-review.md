# Round 2 Review

## Findings

### 1. Bug 10 still leaks stale rep-performance data during refetch/error

**Severity:** P2

The round-2 patch gates the main forecast and most table cells with `hasPerformanceData`, but the page still builds `perfRowsByRep` and `perfRepsByRep` directly from `perfData` before considering `perfLoading`/`perfError` at `client/src/pages/director/director-dashboard-page.tsx:333-344`. `useRepPerformance` does not clear existing `data` when a refetch starts or fails; it only flips `loading`/`error` around the previous state at `client/src/hooks/use-rep-performance.ts:238-246`. That means a period change or manual refresh can render the new loading/error banner while old-period snapshot rows are still present in memory.

Several rendered/exported fields still consume those stale snapshot rows without the `hasPerformanceData` guard: table at-risk uses `snapshot?.atRiskCount` at `client/src/pages/director/director-dashboard-page.tsx:590-592`, the trend sparkline uses `snapshot?.sparkline8w` at `client/src/pages/director/director-dashboard-page.tsx:644-647`, and the CSV export uses `snapshot`/`perfRep` values directly at `client/src/pages/director/director-dashboard-page.tsx:366-383`. In that state the screen can say "Loading performance metrics" or show an error while still showing/exporting stale performance-derived risk/trend/closed/win-rate values from the previous successful period. This is the same class of Bug 10 leakage, just stale-data leakage rather than the round-1 zero-derived leakage.

**Suggested fix:** derive the snapshot maps from performance data only when it is usable, for example `const usablePerfData = hasPerformanceData ? perfData : null`, and use that for `perfRowsByRep`, `perfRepsByRep`, table at-risk, sparklines, and CSV export. Alternatively clear `data` in `useRepPerformance` at fetch start/error, but the page should still avoid exporting perf-derived values while `perfLoading || perfError` is true.

**Test gap:** The new loading/error test at `client/src/pages/director/director-dashboard-page.test.tsx:673-701` only covers `data: null`. Add cases with `data` populated and `loading: true`, and with `data` populated and `error` set, then assert stale region/closed/win/risk/sparkline/export values are not rendered or exported while performance is unavailable.

## Round-1 Blockers

### Bug 7 exact distribution widths

**Verdict:** Fixed.

`DistributionBar` now filters zero buckets and uses the true proportional width with no 4% floor at `client/src/pages/director/director-dashboard-page.tsx:207-231`. The added test includes a 1/99 positive split and asserts `width:1%` while rejecting `width:4%` at `client/src/pages/director/director-dashboard-page.test.tsx:652-670`, which covers the exact round-1 blocker.

### Bug 10 loading/error zero leakage

**Verdict:** Partially fixed, but not complete.

The explicit zero-derived forecast leak from round 1 is fixed for the main KPI/forecast/table closed and win-rate cells: `closedValue`, `closedCount`, goal percent, pipe percent, and pace are nullable/gated at `client/src/pages/director/director-dashboard-page.tsx:344-354`, and the visible forecast panel shows pending text instead of `$0 / $500,000` or `$500,000 behind goal` at `client/src/pages/director/director-dashboard-page.tsx:487-500`. However, Finding 1 remains because stale perf rows are still consumed in other visible/export paths during loading/error.

## Bug-by-Bug Verdict

1. **P1 historical preset mapping:** Fixed. The selected preset is passed as the rep-performance period to both hooks at `client/src/pages/director/director-dashboard-page.tsx:286-295`; the director route validates/passes it through at `server/src/modules/dashboard/routes.ts:56-66`; the service uses it for snapshots at `server/src/modules/dashboard/service.ts:1959-1963`.
2. **P1 forecast vs goal period-aware source:** Fixed for the frontend source selection. The page now uses `perfData.forecastVsGoal` only when performance data is usable at `client/src/pages/director/director-dashboard-page.tsx:344-351`, and the backend director payload also uses the selected period at `server/src/modules/dashboard/service.ts:2005-2014`.
3. **P1 at-risk fallback rep attribution:** Fixed. Backend rows now include `repId`/`repName` at `server/src/modules/dashboard/service.ts:459-496`, and the rendered count uses deal rep names at `client/src/pages/director/director-dashboard-page.tsx:339-343`.
4. **P1 refresh refetches both sources:** Fixed. The refresh handler invokes both refetch functions at `client/src/pages/director/director-dashboard-page.tsx:425-431`.
5. **P2 weeks remaining uses period end:** Fixed for current-period presets. `periodEndForPreset` maps MTD/QTD/YTD to the calendar period end at `client/src/pages/director/director-dashboard-page.tsx:145-160`, and the forecast panel uses it at `client/src/pages/director/director-dashboard-page.tsx:353`.
6. **P2 Open all link uses rendered at-risk dataset:** Fixed. The page derives the destination from the selected rendered dataset at `client/src/pages/director/director-dashboard-page.tsx:339-341` and renders it at `client/src/pages/director/director-dashboard-page.tsx:701`.
7. **P2 distribution bars:** Fixed. See round-1 blocker verdict above.
8. **P2 Closing label period-aware:** Fixed. The mini metric uses `activityPeriodLabel` at `client/src/pages/director/director-dashboard-page.tsx:510-518`.
9. **P2 Activity pulse heading period-aware:** Fixed. The heading and empty state use the selected period label at `client/src/pages/director/director-dashboard-page.tsx:786-827`.
10. **P2 rep performance loading/error:** Not fully fixed. Main zero-derived leaks are addressed, but stale perf data can still leak through table risk/trend and CSV during loading/error. See Finding 1.
11. **P2 CSV export:** Mostly fixed when performance data is available, including escaping via `csvCell` at `client/src/pages/director/director-dashboard-page.tsx:279-282` and export wiring at `client/src/pages/director/director-dashboard-page.tsx:548-556`. It shares the stale-data problem in Finding 1 when performance is loading or errored.
12. **P3 synced freshness:** Fixed. The hook records a successful fetch timestamp at `client/src/hooks/use-director-dashboard.ts:318-343`, and the page renders the relative label at `client/src/pages/director/director-dashboard-page.tsx:163-173` and `client/src/pages/director/director-dashboard-page.tsx:404-405`.

## Overall Assessment

Do not approve yet. The Bug 7 blocker is resolved, and the round-1 zero-derived Bug 10 path is largely fixed, but Bug 10 still has a real stale-data loading/error edge case because preserved `perfData` is still used outside the new guard. The tests need to cover `loading/error + previous data present`, which is the normal hook behavior during refetch and failed refresh.
