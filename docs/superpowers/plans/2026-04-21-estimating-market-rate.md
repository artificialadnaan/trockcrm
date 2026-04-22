# Estimating Market-Rate Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal market-rate pricing enrichment to estimate recommendations, including ZIP-to-market resolution, fallback geography rules, labor/material/equipment adjustment logic, workbench evidence, and estimator market overrides.

**Architecture:** Extend the existing estimating pricing pipeline instead of creating a separate pricing subsystem. The backend adds normalized market tables, deal-level market override state, market resolution and adjustment services, and pricing rationale enrichment. The client surfaces resolved market context and deal-level override controls inside the estimating workbench while keeping a single recommended price per row.

**Tech Stack:** Express, Drizzle, PostgreSQL, React, TypeScript, Vitest

---

## File Structure

- Create: `shared/src/schema/tenant/estimate-markets.ts`
  Responsibility: define market, ZIP mapping, fallback geography, adjustment rule, and deal override tables.
- Modify: `shared/src/schema/index.ts`
  Responsibility: export the new market-rate schema tables.
- Create: `migrations/0033_estimating_market_rate.sql`
  Responsibility: add market-rate tables and indexes.
- Create: `server/src/modules/estimating/market-resolution-service.ts`
  Responsibility: resolve effective deal market from ZIP, fallback geography, and override state.
- Create: `server/src/modules/estimating/market-rate-service.ts`
  Responsibility: load active adjustment rules, apply labor/material/equipment adjustments, and emit rationale payloads.
- Create: `server/src/modules/estimating/market-rate-provider.ts`
  Responsibility: define the provider/resolver abstraction and the internal table-backed implementation used in this slice.
- Modify: `server/src/modules/estimating/historical-pricing-service.ts`
  Responsibility: expose deal geography inputs required by the live recommendation generation path.
- Create: `server/src/modules/estimating/deal-market-override-service.ts`
  Responsibility: set, clear, and audit estimator market overrides.
- Modify: `server/src/modules/estimating/pricing-service.ts`
  Responsibility: apply market-rate adjustment helpers and shared pricing math.
- Create: `server/src/modules/estimating/recommendation-persistence-service.ts`
  Responsibility: provide a shared persistence helper for market-rate-enriched recommendation writes used by the worker generation path.
- Modify: `worker/src/jobs/estimate-generation.ts`
  Responsibility: wire market resolution and market-rate enrichment into the production estimate-generation job.
- Modify: `server/src/modules/estimating/workbench-service.ts`
  Responsibility: expose resolved market context, active-generation filtering, queued/running rerun status, and market-rate rationale in workbench pricing rows.
- Modify: `server/src/modules/estimating/copilot-service.ts`
  Responsibility: thread office context into workbench-state requests used by deal estimating routes.
- Modify: `server/src/modules/deals/routes.ts`
  Responsibility: add deal-level market context, market listing, and override endpoints for estimating.
- Create: `server/tests/modules/estimating/market-resolution-service.test.ts`
  Responsibility: verify ZIP resolution, fallback behavior, and override precedence.
- Create: `server/tests/modules/estimating/market-rate-service.test.ts`
  Responsibility: verify rule selection, component adjustments, and rationale output.
- Modify: `server/tests/modules/estimating/historical-pricing-service.test.ts`
  Responsibility: verify deal-to-property geography fallback used by market-rate generation inputs.
- Modify: `server/tests/modules/estimating/pricing-service.test.ts`
  Responsibility: verify market-rate helper math and fallback behavior.
- Create: `server/tests/modules/estimating/recommendation-persistence-service.test.ts`
  Responsibility: verify persisted recommendation rows carry market-rate-enriched values and rationale.
- Modify: `server/tests/modules/estimating/workbench-service.test.ts`
  Responsibility: verify workbench state exposes market context and evidence.
- Modify: `server/tests/modules/estimating/copilot-service.test.ts`
  Responsibility: verify office-context threading for workflow-state callers.
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`
  Responsibility: verify market override routes and review-event behavior.
- Create: `server/tests/modules/estimating/market-rate-integration.test.ts`
  Responsibility: verify end-to-end generation enrichment and override-triggered refresh behavior.
- Modify: `worker/tests/jobs/estimate-generation.test.ts`
  Responsibility: verify the real generation worker persists market-rate-enriched recommendations.
- Modify: `client/src/components/estimating/estimate-recommendation-options-panel.tsx`
  Responsibility: render market-rate evidence for the selected pricing row.
- Modify: `client/src/components/estimating/estimate-pricing-review-table.tsx`
  Responsibility: render structured market-rate rationale in the pricing review evidence footer instead of raw JSON.
- Modify: `client/src/components/estimating/estimating-workflow-shell.tsx`
  Responsibility: render deal-level market override controls and refresh behavior.
- Modify: `client/src/components/estimating/estimate-workbench-summary-strip.tsx`
  Responsibility: surface queued/running/failed rerun status in the workbench summary strip.
- Modify: `client/src/components/estimating/estimate-workbench-detail-pane.tsx`
  Responsibility: surface queued/running/failed rerun status in the workbench detail pane.
- Create: `client/src/components/estimating/estimate-market-override-panel.tsx`
  Responsibility: provide estimator controls to inspect, set, and clear the effective market, plus visible rerun status after override actions.
- Modify: `client/src/components/estimating/estimate-recommendation-options-panel.test.tsx`
  Responsibility: verify market-rate evidence rendering.
- Modify: `client/src/components/estimating/estimate-pricing-review-table.test.tsx`
  Responsibility: verify structured market-rate evidence rendering in the pricing review footer.
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`
  Responsibility: verify market override controls and refresh behavior.
- Create: `client/src/components/estimating/estimate-workbench-summary-strip.test.tsx`
  Responsibility: verify rerun status rendering in the summary strip.
- Create: `client/src/components/estimating/estimate-workbench-detail-pane.test.tsx`
  Responsibility: verify rerun status rendering in the detail pane.
- Create: `client/src/components/estimating/estimate-market-override-panel.test.tsx`
  Responsibility: verify override UI states and actions.

---

## Task 1: Add Market-Rate Storage and Schema Exports

**Files:**
- Create: `shared/src/schema/tenant/estimate-markets.ts`
- Modify: `shared/src/schema/index.ts`
- Create: `migrations/0033_estimating_market_rate.sql`
- Modify: `server/tests/modules/estimating/schema-exports.test.ts`

- [ ] **Step 1: Write failing schema-export coverage for market-rate tables**
  Add expectations for:
  - `estimateMarkets`
  - `estimateMarketZipMappings`
  - `estimateMarketFallbackGeographies`
  - `estimateMarketAdjustmentRules`
  - `estimateDealMarketOverrides`

- [ ] **Step 2: Run the focused schema test and verify it fails**
  Run in `server/`: `npx vitest run tests/modules/estimating/schema-exports.test.ts`
  Expected: FAIL because the new tables are not exported yet.

- [ ] **Step 3: Add market-rate tables and migration**
  Requirements:
  - canonical market records with active flag
  - ZIP-to-market mapping rows
  - explicit fallback geography storage for metro, state, region, and global/default resolution layers
  - market adjustment rules with fallback fields, component percentages, default labor/material/equipment split weights, and effective dates
  - deal-level market override rows with user attribution and reason
  - enforce one active ZIP mapping per ZIP and one current override row per deal through unique constraints or equivalent upsert-safe semantics
  - seed or backfill an initial active default market, default/global fallback geography rows, and a default/global adjustment rule so fresh tenants can resolve and price without manual setup
  - indexes for ZIP lookup, rule selection, and deal override reads
  - follow the tenant-schema replay migration pattern already used by recent tenant migrations, including the `DO $$ ... FOR schema_name ...` block and `TENANT_SCHEMA_START/END` replay section

- [ ] **Step 4: Re-run the schema test and verify it passes**
  Run in `server/`: `npx vitest run tests/modules/estimating/schema-exports.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "feat: add estimating market-rate storage"`

## Task 2: Implement Market Resolution and Adjustment Services

**Files:**
- Create: `server/src/modules/estimating/market-resolution-service.ts`
- Create: `server/src/modules/estimating/market-rate-service.ts`
- Create: `server/src/modules/estimating/market-rate-provider.ts`
- Create: `server/tests/modules/estimating/market-resolution-service.test.ts`
- Create: `server/tests/modules/estimating/market-rate-service.test.ts`
- Modify: `server/tests/modules/estimating/historical-pricing-service.test.ts`

- [ ] **Step 1: Write failing tests for market resolution**
  Cover:
  - ZIP resolves directly to a market
  - ZIP resolves to metro context before broader fallback
  - ZIP falls back to region/state rule when no market mapping exists
  - global default is used when no geographic rule matches
  - deal-level override wins over auto-resolution
  - deal context falls back from deal ZIP/state fields to related property ZIP/state fields when deal geography is blank

- [ ] **Step 2: Write failing tests for adjustment rule selection and math**
  Cover:
  - exact market + scope match outranks broader fallback
  - effective-date filtering excludes expired rules
  - labor/material/equipment deltas are applied separately
  - default split weights are available for weighted pricing math when a row has no explicit component breakdown
  - rationale payload includes resolved market, resolution level, baseline, and component adjustments

- [ ] **Step 3: Run the focused service tests and verify they fail**
  Run in `server/`: `npx vitest run tests/modules/estimating/market-resolution-service.test.ts tests/modules/estimating/market-rate-service.test.ts tests/modules/estimating/historical-pricing-service.test.ts`
  Expected: FAIL because the services do not exist yet.

- [ ] **Step 4: Implement market resolution service**
  Requirements:
  - accept deal/project location inputs
  - resolve effective market by override, ZIP mapping, explicit metro/state/region fallback geography storage, then default
  - return both market identity and resolution source

- [ ] **Step 5: Implement market-rate adjustment service**
  Requirements:
  - keep `pricing-service.ts` as the baseline recommendation builder and shared baseline math layer
  - keep `market-rate-service.ts` as the pure market adjustment math layer with no dependency back into `pricing-service.ts`
  - resolve the best matching active rule for a pricing scope
  - compute labor/material/equipment deltas from baseline price using persisted default split weights
  - emit a normalized rationale payload with all applied components
  - expose the internal table-backed implementation through a `MarketRateProvider` or equivalent interface so worker, routes, and pricing logic depend on the abstraction instead of concrete services

- [ ] **Step 6: Re-run the focused service tests and verify they pass**
  Run in `server/`: `npx vitest run tests/modules/estimating/market-resolution-service.test.ts tests/modules/estimating/market-rate-service.test.ts tests/modules/estimating/historical-pricing-service.test.ts`
  Expected: PASS

- [ ] **Step 7: Commit**
  `git commit -m "feat: add estimating market resolution services"`

## Task 3: Apply Market-Rate Adjustments During Pricing Generation

**Files:**
- Modify: `server/src/modules/estimating/historical-pricing-service.ts`
- Modify: `server/src/modules/estimating/pricing-service.ts`
- Create: `server/src/modules/estimating/recommendation-persistence-service.ts`
- Modify: `worker/src/jobs/estimate-generation.ts`
- Modify: `server/tests/modules/estimating/pricing-service.test.ts`
- Create: `server/tests/modules/estimating/recommendation-persistence-service.test.ts`
- Modify: `worker/tests/jobs/estimate-generation.test.ts`

- [ ] **Step 1: Write failing pricing-service tests for market-rate enrichment**
  Cover:
  - historical/catalog baseline is preserved before adjustment
  - component adjustments change the recommended unit price
  - rationale includes market-rate context when helper math is applied
  - fallback geography still produces an adjusted recommendation
  - the old hardcoded regional adjustment path is replaced so geography is applied from one source only

- [ ] **Step 2: Write failing recommendation-persistence tests for stored market-rate recommendations**
  Cover:
  - stored recommendation rows persist adjusted unit price and total
  - evidence/assumptions fields capture resolved market and component adjustments
  - persisted recommendations still emit one final unit price and total

- [ ] **Step 3: Write failing worker tests for the production generation job**
  Cover:
  - `estimate_generation` receives ZIP/state geography inputs needed for ZIP-first market resolution, falling back from deal fields to related property fields when needed
  - `estimate_generation` uses resolved market context during recommendation generation
  - worker-generated pricing rows persist market-rate-enriched values
  - worker generation uses override market context when one exists
  - worker-created generation runs persist `rerunRequestId` in `inputSnapshotJson` when processing override-triggered reruns

- [ ] **Step 4: Run the focused generation tests and verify they fail**
  Run in `server/`: `npx vitest run tests/modules/estimating/pricing-service.test.ts tests/modules/estimating/recommendation-persistence-service.test.ts`
  Run in `worker/`: `npx vitest run tests/jobs/estimate-generation.test.ts`
  Expected: FAIL because market-rate enrichment is not wired into the stored recommendation generation path yet.

- [ ] **Step 5: Integrate market-rate service into the actual recommendation generation path**
  Requirements:
  - keep historical/catalog price as the baseline built by `pricing-service.ts`
  - expand the current deal lookup or add an equivalent deal-context query so the live generation path resolves ZIP and state from deal fields first and related property fields second, not only project type and region
  - replace the old hardcoded regional adjustment path with provider-driven market enrichment after the baseline recommendation is built
  - apply component adjustments through the provider/resolver path without introducing a reverse dependency from `market-rate-service.ts` into `pricing-service.ts`
  - persist adjusted recommendations through a shared helper that `worker/src/jobs/estimate-generation.ts` actually calls
  - wire the same ZIP-first market-resolution inputs through `worker/src/jobs/estimate-generation.ts`
  - persist `rerunRequestId` from the queue payload into `estimate_generation_runs.inputSnapshotJson` so queued reruns can be correlated to started/completed runs
  - persist market-rate rationale into evidence/assumptions fields

- [ ] **Step 6: Re-run the focused generation tests and verify they pass**
  Run in `server/`: `npx vitest run tests/modules/estimating/pricing-service.test.ts tests/modules/estimating/recommendation-persistence-service.test.ts`
  Run in `worker/`: `npx vitest run tests/jobs/estimate-generation.test.ts`
  Expected: PASS

- [ ] **Step 7: Commit**
  `git commit -m "feat: enrich estimate pricing with market rates"`

## Task 4: Add Deal-Level Market Override Routes and Audit Flow

**Files:**
- Create: `server/src/modules/estimating/deal-market-override-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`

- [ ] **Step 1: Write failing route tests for market override reads and writes**
  Cover:
  - fetching effective market context for a deal
  - listing active market choices for override selection without hardcoded client ids
  - setting an override with market id and optional reason
  - clearing an override
  - review-event creation for set/clear operations
  - enqueue or rerun side effects for `estimate_generation` after override set/clear, including `dealId`, `rerunRequestId`, and `officeId` in the queued payload

- [ ] **Step 2: Run the focused route tests and verify they fail**
  Run in `server/`: `npx vitest run tests/modules/estimating/workflow-state-routes.test.ts`
  Expected: FAIL because the endpoints and override service are missing.

- [ ] **Step 3: Implement deal market override service and routes**
  Requirements:
  - add a canonical active-market list or search route for the override UI
  - create or replace the single current override row for the deal
  - clear the override row cleanly
  - write estimating review events with before/after market context
  - enqueue or rerun `estimate_generation` by inserting the required `public.job_queue` row with `job_type = 'estimate_generation'`, `payload.dealId`, a unique `payload.rerunRequestId`, and the required `officeId`
  - return the refreshed effective market payload

- [ ] **Step 4: Re-run the focused route tests and verify they pass**
  Run in `server/`: `npx vitest run tests/modules/estimating/workflow-state-routes.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "feat: add estimating market override routes"`

## Task 5: Expose Market Context in Workbench State

**Files:**
- Modify: `server/src/modules/estimating/workbench-service.ts`
- Modify: `server/src/modules/estimating/copilot-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/tests/modules/estimating/workbench-service.test.ts`
- Modify: `server/tests/modules/estimating/copilot-service.test.ts`

- [ ] **Step 1: Write failing workbench-state tests for market context**
  Cover:
  - workbench payload includes effective market info
  - pricing rows include market-rate rationale
  - overridden deals surface override metadata distinctly from auto-detected markets
  - fallback-resolution rows disclose the fallback source
  - only pricing rows from the active or refreshed generation run are returned after a market override rerun
  - while an override-triggered rerun is pending, the workbench keeps showing the newest completed run instead of partial rerun rows
  - workbench payload includes explicit rerun status metadata when override-triggered refresh is queued, running, or failed
  - manual add context keeps using the active completed generation run while an override-triggered rerun is pending

- [ ] **Step 2: Run the focused workbench tests and verify they fail**
  Run in `server/`: `npx vitest run tests/modules/estimating/workbench-service.test.ts tests/modules/estimating/copilot-service.test.ts`
  Expected: FAIL because workbench state does not include market context yet.

- [ ] **Step 3: Extend workbench state assembly**
  Requirements:
  - extend `buildEstimatingWorkbenchState` and `getEstimatingWorkflowState` to accept the caller office id needed for public queue lookups
  - update the deal estimating workflow route and its tests to pass that office context through the existing caller chain
  - include deal-level effective market summary
  - include override state and fallback source
  - define the active pricing run as the newest completed generation run for the deal, falling back to the newest started run only when no completed run exists yet
  - keep the previous completed run active while an override-triggered rerun is queued, pending, running, or failed, and surface rerun status separately
  - derive queued rerun status from the newest matching `public.job_queue` entry for `estimate_generation` plus `dealId`/`officeId` until a worker-created generation run with the same `rerunRequestId` is created in `inputSnapshotJson`
  - expose explicit rerun status fields the client can render without inferring from raw generation rows
  - filter pricing rows so stale pre-override generation results do not mix with refreshed rows
  - bind `manualAddContext.generationRunId` to that same active pricing run instead of the newest started rerun
  - attach market-rate rationale to each pricing row without breaking existing row fields

- [ ] **Step 4: Re-run the focused workbench tests and verify they pass**
  Run in `server/`: `npx vitest run tests/modules/estimating/workbench-service.test.ts tests/modules/estimating/copilot-service.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "feat: expose market context in the estimating workbench"`

## Task 6: Add Workbench Market Override UI and Evidence Display

**Files:**
- Create: `client/src/components/estimating/estimate-market-override-panel.tsx`
- Modify: `client/src/components/estimating/estimate-recommendation-options-panel.tsx`
- Modify: `client/src/components/estimating/estimate-pricing-review-table.tsx`
- Modify: `client/src/components/estimating/estimating-workflow-shell.tsx`
- Modify: `client/src/components/estimating/estimate-workbench-summary-strip.tsx`
- Modify: `client/src/components/estimating/estimate-workbench-detail-pane.tsx`
- Create: `client/src/components/estimating/estimate-market-override-panel.test.tsx`
- Modify: `client/src/components/estimating/estimate-recommendation-options-panel.test.tsx`
- Modify: `client/src/components/estimating/estimate-pricing-review-table.test.tsx`
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`
- Create: `client/src/components/estimating/estimate-workbench-summary-strip.test.tsx`
- Create: `client/src/components/estimating/estimate-workbench-detail-pane.test.tsx`

- [ ] **Step 1: Write failing client tests for market evidence and override controls**
  Cover:
  - pricing evidence shows resolved market, resolution level, baseline, and component adjustments
  - pricing review footer renders structured market-rate assumptions/evidence instead of raw JSON
  - shell renders deal-level market override controls
  - override controls load canonical market choices from the server
  - override state is visible when active
  - queued, running, or failed override-triggered reruns show explicit status in the summary strip and detail pane
  - clearing override removes override marker after refresh

- [ ] **Step 2: Run the focused client tests and verify they fail**
  Run in `client/`: `npx vitest run src/components/estimating/estimate-market-override-panel.test.tsx src/components/estimating/estimate-recommendation-options-panel.test.tsx src/components/estimating/estimate-pricing-review-table.test.tsx src/components/estimating/estimate-workbench-summary-strip.test.tsx src/components/estimating/estimate-workbench-detail-pane.test.tsx src/components/estimating/estimating-workflow-shell.test.tsx`
  Expected: FAIL because the client does not render market-rate UI yet.

- [ ] **Step 3: Build the market override panel**
  Requirements:
  - show effective market and resolution source
  - load and render canonical market choices from the new server route
  - support choosing a replacement market
  - support clearing the override
  - show queued, running, or failed rerun status from the workbench payload after override actions
  - call the new deal-level override endpoints and refresh the workbench

- [ ] **Step 4: Extend pricing evidence rendering**
  Requirements:
  - render market-rate rationale through the pricing review table evidence footer where assumptions/evidence are already summarized
  - show baseline price, labor/material/equipment adjustments, final adjusted price
  - show whether the market was auto-detected or overridden
  - show fallback level when no exact market match was used

- [ ] **Step 5: Re-run the focused client tests and verify they pass**
  Run in `client/`: `npx vitest run src/components/estimating/estimate-market-override-panel.test.tsx src/components/estimating/estimate-recommendation-options-panel.test.tsx src/components/estimating/estimate-pricing-review-table.test.tsx src/components/estimating/estimate-workbench-summary-strip.test.tsx src/components/estimating/estimate-workbench-detail-pane.test.tsx src/components/estimating/estimating-workflow-shell.test.tsx`
  Expected: PASS

- [ ] **Step 6: Commit**
  `git commit -m "feat: add estimating market-rate workbench ui"`

## Task 7: Add Integration Coverage for Generation and Override Refresh

**Files:**
- Create: `server/tests/modules/estimating/market-rate-integration.test.ts`
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`
- Modify: `worker/tests/jobs/estimate-generation.test.ts`

- [ ] **Step 1: Write failing integration tests for generation enrichment and override refresh**
  Cover:
  - estimate generation persists market-rate-enriched recommendations end to end
  - a deal market override changes downstream pricing context on refresh or rerun
  - clearing the override restores auto-resolved geography on subsequent refreshes
  - refreshed workbench state excludes stale pricing rows from the pre-override generation run
  - pending override-triggered reruns keep the previous completed run visible until the new run completes
  - queued override-triggered reruns surface status from `public.job_queue` before a new generation run exists
  - queued rerun status clears only after a generation run with the same `rerunRequestId` exists
  - worker-side generation coverage proves the production job uses new market-resolution inputs

- [ ] **Step 2: Run the focused integration tests and verify they fail**
  Run in `server/`: `npx vitest run tests/modules/estimating/market-rate-integration.test.ts tests/modules/estimating/workflow-state-routes.test.ts`
  Run in `worker/`: `npx vitest run tests/jobs/estimate-generation.test.ts`
  Expected: FAIL because end-to-end market-rate generation and override-refresh coverage is not implemented yet.

- [ ] **Step 3: Add the missing integration fixtures or wiring needed by the tests**
  Requirements:
  - generation fixtures exercise resolved market selection and persisted evidence
  - override route tests confirm refreshed workbench state reflects the new market context
  - override refresh uses the active generation run so stale pricing rows are not returned
  - queued rerun fixtures verify workbench status before the worker creates the next generation run
  - correlated rerun fixtures verify queue rows and generation runs are linked by `rerunRequestId`
  - worker fixtures confirm the live generation path uses the override-triggered rerun flow

- [ ] **Step 4: Re-run the focused integration tests and verify they pass**
  Run in `server/`: `npx vitest run tests/modules/estimating/market-rate-integration.test.ts tests/modules/estimating/workflow-state-routes.test.ts`
  Run in `worker/`: `npx vitest run tests/jobs/estimate-generation.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "test: add estimating market-rate integration coverage"`

## Task 8: Final Verification and Hardening

**Files:**
- Modify: any touched files from Tasks 1-7

- [ ] **Step 1: Run the focused estimating server test suite**
  Run in `server/`: `npx vitest run tests/modules/estimating/*.test.ts`
  Expected: PASS

- [ ] **Step 2: Run the focused estimating client test suite**
  Run in `client/`: `npx vitest run src/components/estimating/*.test.tsx`
  Expected: PASS

- [ ] **Step 3: Run workspace typecheck**
  Run from repo root: `npm run typecheck`
  Expected: PASS

- [ ] **Step 4: Fix any remaining failures and rerun verification until green**

- [ ] **Step 5: Commit**
  `git commit -m "test: verify estimating market-rate slice"`

---

## Notes

- Keep market-rate enrichment as a pricing input, not a second approval model.
- Do not block estimate generation when geography falls back; disclose the fallback in evidence instead.
- Do not introduce third-party market providers in this slice.
- Keep the market override deal-scoped, not row-scoped.
