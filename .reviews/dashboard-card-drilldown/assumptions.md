# Dashboard Card Drilldown Assumptions

- Branch: `feat/dashboard-card-drilldown`
- Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/feat-dashboard-card-drilldown`
- Base: `origin/main` at `37e93a4d6e3ee20d376a01be90744bb20c3a08fe`
- Production smoke is banned for this task. Verification will be local tests, typecheck, PR review, Codex review, Railway deploy status, and a user smoke checklist only.
- `server/src/modules/deals/service.ts` is off-limits and will not be edited.
- The prompt referenced `sales-rep-dashboard.tsx`, `director-dashboard.tsx`, and `deals-list-page.tsx`; current filenames are `client/src/pages/dashboard/rep-dashboard-page.tsx`, `client/src/pages/director/director-dashboard-page.tsx`, and `client/src/pages/deals/deal-list-page.tsx`.

## Card Inventory

### Rep Dashboard

- Active deals: `data.activeDeals.count` and `data.activeDeals.totalValue`; target `/deals?filter=active_pipeline&scope=mine`.
- Active leads: `data.activeLeads.count`; target `/leads?scope=mine`.
- Commission period: `data.commissionSummary.totalEarnedCommission`; target `/commissions`.
- Top deals rows: `buildTopDeals(data, displayName)` from downstream bottlenecks plus deal snapshot; target `/deals/:id`.
- AI blind spots: stale downstream deals plus stale leads; deal targets `/deals/:id`, lead targets `/leads/:id`.
- Funnel tiles:
  - Leads: `data.activeLeads.count`; target `/leads?scope=mine`.
  - Qualified: `qualified_lead` funnel bucket count; target `/leads?stage=qualified_lead&scope=mine`.
  - Opportunities: `opportunity` funnel bucket count/value; target `/deals?filter=active_pipeline&scope=mine`.
  - Bid Board: `estimating` funnel bucket count/value; target `/deals?filter=active_pipeline&scope=mine`.
- My Numbers:
  - Cleanup: `data.myCleanup.total`; target `/pipeline/my-cleanup`.
  - Stale leads: `data.staleLeads.count`; target `/leads?stale=true`.
  - Follow-up: `data.followUpCompliance`; target `/tasks`.
  - Overdue: max dashboard/task overdue count; target `/tasks?filter=overdue`.
  - Activity cells are informational counts and target `/reports/performance`.

### Director Dashboard

- Active pipeline: `opportunityVsPipeline.pipelineValue` and `pipelineCount`; target `/deals?filter=active_pipeline&period=<preset>&scope=team`.
- Closed period: rep-performance `current.totalWonValue` / `dealsWon`; target `/deals?filter=won&period=<preset>&scope=team`.
- At risk: stale deal rows when available, otherwise `atRiskDeals`; target `/deals?filter=stale&period=<preset>&scope=team` for stale-source rows and `/deals?filter=at_risk&period=<preset>&scope=team` for fallback risk rows.
- Forecast/pace/activity cards keep their report drilldowns because they are report metrics, not deal-list counts.
- Rep rows target `/director/rep/:repId?preset=<preset>`.
- At-risk deal rows and recent-close rows target `/deals/:id`.

## Filter Parity Note

`/deals` currently supports dashboard filters for active, won, and closing-soon via query params. Exact server-side stale/at-risk list parity is not expressible without changing `server/src/modules/deals/service.ts`; this branch adds client-side query recognition and routes stale/at-risk dashboard cards into `/deals` with scoped filters, while leaving the server service untouched.
