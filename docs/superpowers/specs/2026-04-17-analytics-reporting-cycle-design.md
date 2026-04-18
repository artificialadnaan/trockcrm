# Analytics Reporting Cycle Design

## Goal

Build the next analytics/reporting cycle for T Rock around three connected capabilities:

1. enhanced source-performance reporting
2. data-mining visibility for untouched and dormant records
3. regional and rep ownership reporting within the existing office-scoped reports surface

The design should extend the existing reports infrastructure instead of creating a parallel analytics stack.

## Scope

This cycle includes:

- shared analytics filters and contracts across the reports backend and UI
- enhanced source-performance reporting that leadership can use to evaluate lead quality and close performance
- data-mining reporting that surfaces untouched records and reactivation opportunities without duplicating existing stale widgets
- regional and rep ownership reporting that aggregates pipeline, activity, and ownership gaps by geography and owner within the existing reports page

This cycle does not include:

- workflow timing and approval-gate logic
- closeout template work
- PM welcome email workflow
- CompanyCam requirements/replacement work
- Bid Board replacement work
- new workflow-stage definitions that depend on finalized T Rock process input

## Existing Foundation

The current codebase already provides usable building blocks:

- `server/src/modules/reports/routes.ts`
  - locked report endpoints already exist for activity summary, stale deals, lead source ROI, pipeline by rep, and related summaries
- `server/src/modules/reports/service.ts`
  - contains raw SQL + Drizzle-backed reporting functions with date-range and rep scoping patterns
- `client/src/pages/reports/reports-page.tsx`
  - contains the director-facing reporting surface and existing KPI/table/chart composition
- `server/src/modules/reports/saved-reports-service.ts`
  - already supports office-scoped saved reports
- schema exports already include public office/region constructs and tenant deal/source fields

The design therefore treats this work as an expansion and normalization of the existing reports module.

## Product Outcomes

### 1. Source Performance

Leadership needs to answer:

- which lead sources generate the most opportunities
- which sources convert into qualified pipeline
- which sources actually close
- which sources underperform despite volume

The first release will treat campaign as `lead/deal source` because that data already exists and is immediately usable. A richer campaign entity can be added later without changing the high-level report contract.

This cycle must not introduce a second canonical source report. It should extend the current `lead_source_roi` lane into a broader source-performance surface instead of creating a separate competing report family.

### 2. Data Mining

Leadership needs a dashboard that goes beyond reactive tasks and shows:

- records untouched for 30/60/90 days
- dormant companies/contacts worth reactivation

This complements the existing task engine instead of replacing it. The analytics surface is for oversight and prioritization; task generation remains the operational follow-through path.

This cycle must not duplicate the stale lead/deal counts that already ship in `workflow_overview` and related stale reports. Data Mining should either link to those existing stale surfaces or focus only on the untouched/dormant/reactivation layer.

### 3. Regional and Rep Ownership Reporting

Leadership needs to see the business by geography and owner:

- activity by rep
- pipeline by rep
- stale counts by rep
- totals by region/office
- ownership gaps where records are missing or inconsistently assigned

This cycle should make regional and rep reporting first-class filters and groupings across the office-scoped reports page.

This cycle does not replace the existing admin cross-office reports page. Cross-office remains the admin comparison surface; this work adds region/rep breakdowns inside the current office-aware reports experience.

## Recommended Architecture

Use a hybrid approach:

- keep one shared reporting foundation in the existing reports module
- implement the three report families in parallel on top of that foundation

This avoids three disconnected vertical slices while still allowing parallel implementation in separate worktrees.

### Shared Reporting Foundation

Add a normalized analytics filter layer used by reports endpoints and the reports UI. It should standardize:

- date range
- office
- region
- rep
- lead/deal source
- stale bucket / untouched bucket where relevant

The backend should not invent a new analytics service namespace. New report functions belong beside the existing reports functions in `server/src/modules/reports/service.ts` or small focused sibling files if the service becomes too large.

The frontend should keep the current reports page as the host surface, but the new sections may be broken into smaller presentational components if that reduces file bloat.

## Data Model Assumptions

This cycle is intentionally conservative about schema changes.

### Reuse Existing Fields

- `deals.source`
- `leads.source`
- ownership fields already used in rep/activity reporting
- office/region identifiers already present in the reporting field set
- stage and stale thresholds already used by the current stale reporting logic

### Optional Minimal Additions

Only introduce schema changes if a specific report cannot be implemented from current fields. In this cycle, avoid adding a new campaign entity or analytics warehouse table.

If a gap is discovered, prefer:

- a small additive column/index
- or a derived query/view

over a large new persistence model.

## Backend Design

### A. Shared Analytics Query Contract

Add a common TypeScript input shape for analytics report functions. It should support:

- `from?: string`
- `to?: string`
- `officeId?: string`
- `regionId?: string`
- `repId?: string`
- `source?: string`

Not every report will use every field, but all new report handlers should accept the shared contract and ignore irrelevant filters explicitly.

### B. Source Performance Reports

Extend the existing source reporting lane to provide:

- source summary
  - total leads
  - total deals
  - active pipeline value
  - closed won count
  - closed won value
  - win rate
- optional source trend
  - monthly or quarterly counts/value by source

Rules:

- extend the existing `lead_source_roi` contract rather than creating a parallel source report
- use existing `source` data first
- collapse null/blank values into `Unknown`
- allow filtering by office/region and date range

### C. Data-Mining Reports

Add a mining surface focused on:

- untouched contacts
- dormant companies

Definitions for this cycle:

- untouched contacts = no meaningful touchpoint or activity in the configured lookback window
- dormant companies = no recent activity and no currently active deal within the lookback window

The initial release may use fixed buckets:

- 30 days
- 60 days
- 90 days

### D. Regional / Rep Ownership Reports

Add report functions and endpoints for:

- pipeline by region with rep breakdown
- activity by region and rep
- ownership gaps by region and rep
  - records missing assigned rep
  - records missing region where region should be populated

The first release should prefer read-only diagnostic reporting over automatic backfill or mutation.

This reporting should be office-scoped and complementary to:

- existing rep-level reports in `reports`
- existing office-wide comparisons in the admin cross-office page

## Frontend Design

The reports page remains the primary surface.

### Reports Page Additions

Add or refine three sections in the reports page:

1. Source Performance
2. Data Mining
3. Regional and Rep Ownership

Each section should expose:

- compact KPIs
- at least one chart where the data benefits from visualization
- at least one actionable table
- export support via the existing report export helpers where practical

### Filters

The reports UI should gain shared controls for:

- date range
- region
- rep
- source

Do not build a heavy custom report builder for this cycle. Keep it opinionated and leadership-friendly.

### Visual Intent

The reports page already uses a KPI + chart + table language. Follow that pattern, but reduce the amount of overloaded single-file logic by extracting new sections into focused components if needed.

## Saved Reports

Saved reports should continue to work for existing report types.

For this cycle:

- keep office-scoped visibility rules intact
- do not redesign the saved-report model
- do not add duplicate locked presets for analytics that are already surfaced directly on the reports page

## Error Handling

The analytics endpoints should:

- validate filter combinations cleanly
- reject malformed IDs with controlled 400s
- default missing date ranges consistently
- return empty datasets, not errors, when no data matches

The UI should:

- render empty states clearly
- avoid blank panels when data is empty
- preserve the selected filters while retrying failed requests

## Testing Strategy

### Backend

Add targeted service and route tests for:

- source summary aggregation
- stale/data-mining bucket behavior
- region/rep grouping behavior
- null/unknown source normalization
- rep visibility restrictions where already enforced by route role logic

### Frontend

Add component/page tests for:

- new reports sections rendering with mock data
- filter state updates
- empty states
- export wiring where added

### Integration

Run the existing report test suite plus targeted new tests for the added endpoints and page sections.

## Parallel Implementation Boundaries

These slices are intentionally separable.

### Slice 1: Shared Foundation

Ownership:

- shared analytics filter types
- common query helpers
- locked report registration
- reports page shared filter controls

### Slice 2: Source Performance

Ownership:

- backend source summary/trend extensions on the existing source report lane
- frontend source-performance section

### Slice 3: Data Mining

Ownership:

- backend untouched/dormant/ownership-gap mining summary
- frontend mining section

### Slice 4: Regional / Rep Ownership

Ownership:

- backend region/rep rollups within the office-scoped reports surface
- frontend regional ownership section

Each slice may proceed in its own worktree once the shared foundation contract is stable.

## Rollout Plan

### Phase 1

- shared analytics filter contract
- source-performance reporting
- data-mining reporting
- regional/rep ownership reporting

### Phase 2

- richer campaign entity if T Rock wants true campaign-level attribution beyond source
- configurable mining buckets
- ownership remediation actions from the reporting surface

## Success Criteria

This cycle is successful when:

- directors can filter analytics by date range and region/rep/source from one reporting surface
- leadership can compare sources by pipeline and close performance from one canonical source-performance surface
- leadership can see untouched/dormant reactivation opportunities without duplicating the existing stale widgets
- leadership can view office-scoped pipeline/activity/ownership gaps by region and rep
- the implementation extends the current reports architecture instead of fragmenting it or duplicating the admin cross-office page

## Recommended Next Step

Write one implementation plan for this analytics cycle, then execute it via subagent-driven development using:

- one worktree for shared reporting foundation
- one worktree for campaign/source analytics
- one worktree for data-mining reporting
- one worktree for regional/rep reporting
