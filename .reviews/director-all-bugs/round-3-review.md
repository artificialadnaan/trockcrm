# Round 3 Review

## Findings

Clean. I found no remaining blocking issues.

## Confirmation

All 12 director dashboard bugs are addressed:

1. Historical period kinds now flow through without being collapsed to current-period aliases: the page passes the selected preset as `repPerformancePeriod` to both hooks at `client/src/pages/director/director-dashboard-page.tsx:287-295`, `useDirectorDashboard` sends it as `periodKind` at `client/src/hooks/use-director-dashboard.ts:312-337`, the director route validates/passes it at `server/src/modules/dashboard/routes.ts:51-66`, and rep-performance fetch preserves `last_month`/`last_quarter`/`last_year` at `client/src/hooks/use-rep-performance.ts:107-114` and `client/src/hooks/use-rep-performance.ts:201-207`.
2. Forecast vs goal is no longer using a fixed MTD dashboard source: the page derives `forecastVsGoal` only from usable rep-performance data at `client/src/pages/director/director-dashboard-page.tsx:333-355`, and the director service populates dashboard forecast/activity from the selected snapshot period at `server/src/modules/dashboard/service.ts:1961-1963` and `server/src/modules/dashboard/service.ts:2005-2014`.
3. At-risk fallback rows carry rep attribution: downstream bottlenecks select/map `repId` and `repName` at `server/src/modules/dashboard/service.ts:459-505`, the client `atRiskDeals` contract includes those fields at `client/src/hooks/use-director-dashboard.ts:97-109`, and the dashboard count uses deal `repName` values at `client/src/pages/director/director-dashboard-page.tsx:341-345`.
4. Refresh now refetches both data sources: the button invokes `refetch()` and `refetchPerformance()` at `client/src/pages/director/director-dashboard-page.tsx:426-433`.
5. Weeks remaining uses the actual period end for current-period presets: `periodEndForPreset` maps MTD/QTD/YTD to calendar period ends at `client/src/pages/director/director-dashboard-page.tsx:145-160`, and the forecast panel uses that result at `client/src/pages/director/director-dashboard-page.tsx:353-354`.
6. The at-risk drilldown destination follows the rendered dataset: the page selects stale deals vs fallback at-risk deals and derives the matching route at `client/src/pages/director/director-dashboard-page.tsx:341-343`, then renders that link at `client/src/pages/director/director-dashboard-page.tsx:696-704`.
7. Distribution widths are exact now: zero buckets are filtered, all-zero rows render an empty bar, and positive buckets use their true percentage with no 4% floor at `client/src/pages/director/director-dashboard-page.tsx:207-231`.
8. Closing labels are dynamic: the mini metric uses `activityPeriodLabel` at `client/src/pages/director/director-dashboard-page.tsx:511-515`.
9. Activity pulse labels are dynamic: heading and empty state use the selected period label at `client/src/pages/director/director-dashboard-page.tsx:787-829`.
10. Rep-performance loading/error no longer leaks zeroed or stale snapshot data into KPI, forecast, table, sparkline, or CSV paths: `usablePerfData` is nulled while loading or errored at `client/src/pages/director/director-dashboard-page.tsx:333-338`; KPI/forecast/progress values are gated at `client/src/pages/director/director-dashboard-page.tsx:346-355` and `client/src/pages/director/director-dashboard-page.tsx:467-501`; table closed/win/region/sparkline paths use the guarded maps/flags at `client/src/pages/director/director-dashboard-page.tsx:582-647`; CSV export also reads from those guarded maps at `client/src/pages/director/director-dashboard-page.tsx:367-388`.
11. CSV export is wired and basically correct: the export button calls `exportSalesForceCsv` at `client/src/pages/director/director-dashboard-page.tsx:549-553`, cells escape commas/quotes/newlines at `client/src/pages/director/director-dashboard-page.tsx:279-282`, and the generated file uses the rendered rep rows at `client/src/pages/director/director-dashboard-page.tsx:367-395`.
12. Freshness is dynamic: the hook records `lastFetchedAt` after successful fetches at `client/src/hooks/use-director-dashboard.ts:318-343`, and the page renders the relative freshness label at `client/src/pages/director/director-dashboard-page.tsx:163-173` and `client/src/pages/director/director-dashboard-page.tsx:405-407`.

## Verification

Ran focused regression coverage:

```text
npx vitest run client/src/pages/director/director-dashboard-page.test.tsx client/src/hooks/use-rep-performance.test.ts server/tests/modules/dashboard/service.test.ts server/tests/modules/dashboard/routes.test.ts

Test Files  4 passed (4)
Tests       37 passed (37)
```
