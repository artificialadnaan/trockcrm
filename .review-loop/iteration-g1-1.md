# Track G1 Internal Review Request - Iteration 1

## Scope

Frontend-only director dashboard polish in `client/src/pages/director/director-dashboard-page.tsx`, updated to the user-provided screenshot spec.

## Section-by-Section Spec Mapping

1. Header: implemented title, freshness eyebrow, MTD/QTD/YTD/last-period tabs, real `refetch()` refresh button, shell action icons, and avatar.
2. KPI strip: implemented exactly three cards for Active pipeline, Closed period, and At risk.
3. Forecast vs goal: implemented actual/target headline, gap caption, Pace/Closing/Activity mini cards, and WON/PIPE progress bars.
4. Sales force performance: implemented table with rep, closed, pipeline, distribution, win rate, at risk, activity, trend, export button, and semantic rep links.
5. Strategic alerts: implemented dark right panel using `data.strategicAlerts`.
6. At-risk deals: implemented left table using `data.staleDeals` first because those rows include rep attribution. Falls back to `data.atRiskDeals` if stale deals are absent.
7. AI coaching: implemented right panel using `data.aiCoachingPrompts`.
8. Activity pulse: implemented left panel using `data.activityPulse` with stacked activity bars.
9. Recent closes: implemented right panel using `data.recentCloses`.

## Data Sources

- Existing hook only: `useDirectorDashboard(dateRange)` and `useRepPerformance(...)`.
- No backend changes and no aggregation changes.
- Existing director dashboard payload already includes strategic alerts, AI coaching prompts, activity pulse, recent closes, at-risk deals, stale deals, rep funnel rows, and forecast-vs-goal.

## Known Compromises

- At-risk deal rows do not include company name in the current hook shape. The UI renders rep and region context instead of fabricating a company.
- Rep region comes from rep performance snapshots. If region is null, the UI renders "Region unavailable".
- Distribution bars use existing `repFunnelRows` counts by lead/qualified/opportunity/estimating, not stage-by-stage deal distribution.
- Recent close sub-context such as repeat customer or lost reason is not available in the current hook shape, so the row shows rep context only.

## Verification

- `npm run typecheck`: passed after screenshot-spec rewrite.
- `npx vitest run client/src/pages/director/director-dashboard-page.test.tsx`: 9 tests passed.
- `find client/src/pages/director client/src/components/director -name '*.test.tsx' -print 2>/dev/null | xargs -r npx vitest run`: 1 file, 9 tests passed.

## Review Focus

- Check visual and structural fidelity against the screenshot order.
- Confirm no fake director metrics were introduced.
- Confirm no backend, aggregation, or shared component files changed.
- Confirm refresh uses the real hook refetch instead of a decorative button.
