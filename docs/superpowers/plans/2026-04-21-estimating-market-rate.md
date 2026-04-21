# Estimating Market-Rate Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal market-rate pricing enrichment to estimate recommendations, including ZIP-to-market resolution, fallback geography rules, labor/material/equipment adjustment logic, workbench evidence, and estimator market overrides.

**Architecture:** Extend the existing estimating pricing pipeline instead of creating a separate pricing subsystem. The backend adds normalized market tables, deal-level market override state, market resolution and adjustment services, and pricing rationale enrichment. The client surfaces resolved market context and deal-level override controls inside the estimating workbench while keeping a single recommended price per row.

**Tech Stack:** Express, Drizzle, PostgreSQL, React, TypeScript, Vitest

---

## File Structure

- Create: `shared/src/schema/tenant/estimate-markets.ts`
  Responsibility: define market, ZIP mapping, adjustment rule, and deal override tables.
- Modify: `shared/src/schema/index.ts`
  Responsibility: export the new market-rate schema tables.
- Create: `migrations/0033_estimating_market_rate.sql`
  Responsibility: add market-rate tables and indexes.
- Create: `server/src/modules/estimating/market-resolution-service.ts`
  Responsibility: resolve effective deal market from ZIP, fallback geography, and override state.
- Create: `server/src/modules/estimating/market-rate-service.ts`
  Responsibility: load active adjustment rules, apply labor/material/equipment adjustments, and emit rationale payloads.
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
  Responsibility: expose resolved market context, active-generation filtering, and market-rate rationale in workbench pricing rows.
- Modify: `server/src/modules/deals/routes.ts`
  Responsibility: add deal-level market context, market listing, and override endpoints for estimating.
- Create: `server/tests/modules/estimating/market-resolution-service.test.ts`
  Responsibility: verify ZIP resolution, fallback behavior, and override precedence.
- Create: `server/tests/modules/estimating/market-rate-service.test.ts`
  Responsibility: verify rule selection, component adjustments, and rationale output.
- Modify: `server/tests/modules/estimating/pricing-service.test.ts`
  Responsibility: verify market-rate helper math and fallback behavior.
- Create: `server/tests/modules/estimating/recommendation-persistence-service.test.ts`
  Responsibility: verify persisted recommendation rows carry market-rate-enriched values and rationale.
- Modify: `server/tests/modules/estimating/workbench-service.test.ts`
  Responsibility: verify workbench state exposes market context and evidence.
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`
  Responsibility: verify market override routes and review-event behavior.
- Create: `server/tests/modules/estimating/market-rate-integration.test.ts`
  Responsibility: verify end-to-end generation enrichment and override-triggered refresh behavior.
- Modify: `worker/tests/jobs/estimate-generation.test.ts`
  Responsibility: verify the real generation worker persists market-rate-enriched recommendations.
- Modify: `client/src/components/estimating/estimate-recommendation-options-panel.tsx`
  Responsibility: render market-rate evidence for the selected pricing row.
- Modify: `client/src/components/estimating/estimating-workflow-shell.tsx`
  Responsibility: render deal-level market override controls and refresh behavior.
- Create: `client/src/components/estimating/estimate-market-override-panel.tsx`
  Responsibility: provide estimator controls to inspect, set, and clear the effective market.
- Modify: `client/src/components/estimating/estimate-recommendation-options-panel.test.tsx`
  Responsibility: verify market-rate evidence rendering.
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`
  Responsibility: verify market override controls and refresh behavior.
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
  - `estimateMarketAdjustmentRules`
  - `estimateDealMarketOverrides`

- [ ] **Step 2: Run the focused schema test and verify it fails**
  Run: `npx vitest run tests/modules/estimating/schema-exports.test.ts`
  Expected: FAIL because the new tables are not exported yet.

- [ ] **Step 3: Add market-rate tables and migration**
  Requirements:
  - canonical market records with active flag
  - ZIP-to-market mapping rows
  - metro-aware geography fields or mapping rows to support ZIP -> metro -> region/state -> default resolution
  - market adjustment rules with fallback fields, component percentages, and effective dates
  - deal-level market override rows with user attribution and reason
  - indexes for ZIP lookup, rule selection, and deal override reads

- [ ] **Step 4: Re-run the schema test and verify it passes**
  Run: `npx vitest run tests/modules/estimating/schema-exports.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "feat: add estimating market-rate storage"`

## Task 2: Implement Market Resolution and Adjustment Services

**Files:**
- Create: `server/src/modules/estimating/market-resolution-service.ts`
- Create: `server/src/modules/estimating/market-rate-service.ts`
- Create: `server/tests/modules/estimating/market-resolution-service.test.ts`
- Create: `server/tests/modules/estimating/market-rate-service.test.ts`

- [ ] **Step 1: Write failing tests for market resolution**
  Cover:
  - ZIP resolves directly to a market
  - ZIP resolves to metro context before broader fallback
  - ZIP falls back to region/state rule when no market mapping exists
  - global default is used when no geographic rule matches
  - deal-level override wins over auto-resolution

- [ ] **Step 2: Write failing tests for adjustment rule selection and math**
  Cover:
  - exact market + scope match outranks broader fallback
  - effective-date filtering excludes expired rules
  - labor/material/equipment deltas are applied separately
  - rationale payload includes resolved market, resolution level, baseline, and component adjustments

- [ ] **Step 3: Run the focused service tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/market-resolution-service.test.ts tests/modules/estimating/market-rate-service.test.ts`
  Expected: FAIL because the services do not exist yet.

- [ ] **Step 4: Implement market resolution service**
  Requirements:
  - accept deal/project location inputs
  - resolve effective market by override, ZIP mapping, metro-aware geography, broader geography fallback, then default
  - return both market identity and resolution source

- [ ] **Step 5: Implement market-rate adjustment service**
  Requirements:
  - resolve the best matching active rule for a pricing scope
  - compute labor/material/equipment deltas from baseline price using rule weights
  - emit a normalized rationale payload with all applied components

- [ ] **Step 6: Re-run the focused service tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/market-resolution-service.test.ts tests/modules/estimating/market-rate-service.test.ts`
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
  - `estimate_generation` receives ZIP/state geography inputs needed for ZIP-first market resolution
  - `estimate_generation` uses resolved market context during recommendation generation
  - worker-generated pricing rows persist market-rate-enriched values
  - worker generation uses override market context when one exists

- [ ] **Step 4: Run the focused generation tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/pricing-service.test.ts tests/modules/estimating/recommendation-persistence-service.test.ts`
  Run: `npx vitest run worker/tests/jobs/estimate-generation.test.ts`
  Expected: FAIL because market-rate enrichment is not wired into the stored recommendation generation path yet.

- [ ] **Step 5: Integrate market-rate service into the actual recommendation generation path**
  Requirements:
  - keep historical/catalog price as the baseline
  - expand the current deal lookup or add an equivalent deal-context query so the live generation path has ZIP and state inputs, not only project type and region
  - replace the old hardcoded regional adjustment path in `pricing-service.ts` with the new market-rate service
  - apply component adjustments to the baseline
  - persist adjusted recommendations through a shared helper that `worker/src/jobs/estimate-generation.ts` actually calls
  - wire the same ZIP-first market-resolution inputs through `worker/src/jobs/estimate-generation.ts`
  - persist market-rate rationale into evidence/assumptions fields

- [ ] **Step 6: Re-run the focused generation tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/pricing-service.test.ts tests/modules/estimating/recommendation-persistence-service.test.ts`
  Run: `npx vitest run worker/tests/jobs/estimate-generation.test.ts`
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
  - enqueue or rerun side effects for `estimate_generation` after override set/clear

- [ ] **Step 2: Run the focused route tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/workflow-state-routes.test.ts`
  Expected: FAIL because the endpoints and override service are missing.

- [ ] **Step 3: Implement deal market override service and routes**
  Requirements:
  - add a canonical active-market list or search route for the override UI
  - create or replace the deal override row
  - clear the override row cleanly
  - write estimating review events with before/after market context
  - enqueue or rerun `estimate_generation` so pricing recommendations refresh after set/clear
  - return the refreshed effective market payload

- [ ] **Step 4: Re-run the focused route tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/workflow-state-routes.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "feat: add estimating market override routes"`

## Task 5: Expose Market Context in Workbench State

**Files:**
- Modify: `server/src/modules/estimating/workbench-service.ts`
- Modify: `server/tests/modules/estimating/workbench-service.test.ts`

- [ ] **Step 1: Write failing workbench-state tests for market context**
  Cover:
  - workbench payload includes effective market info
  - pricing rows include market-rate rationale
  - overridden deals surface override metadata distinctly from auto-detected markets
  - fallback-resolution rows disclose the fallback source
  - only pricing rows from the active or refreshed generation run are returned after a market override rerun

- [ ] **Step 2: Run the focused workbench tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/workbench-service.test.ts`
  Expected: FAIL because workbench state does not include market context yet.

- [ ] **Step 3: Extend workbench state assembly**
  Requirements:
  - include deal-level effective market summary
  - include override state and fallback source
  - select the active generation run for pricing review state after market override reruns
  - filter pricing rows so stale pre-override generation results do not mix with refreshed rows
  - attach market-rate rationale to each pricing row without breaking existing row fields

- [ ] **Step 4: Re-run the focused workbench tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/workbench-service.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "feat: expose market context in the estimating workbench"`

## Task 6: Add Workbench Market Override UI and Evidence Display

**Files:**
- Create: `client/src/components/estimating/estimate-market-override-panel.tsx`
- Modify: `client/src/components/estimating/estimate-recommendation-options-panel.tsx`
- Modify: `client/src/components/estimating/estimating-workflow-shell.tsx`
- Create: `client/src/components/estimating/estimate-market-override-panel.test.tsx`
- Modify: `client/src/components/estimating/estimate-recommendation-options-panel.test.tsx`
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`

- [ ] **Step 1: Write failing client tests for market evidence and override controls**
  Cover:
  - pricing evidence shows resolved market, resolution level, baseline, and component adjustments
  - shell renders deal-level market override controls
  - override controls load canonical market choices from the server
  - override state is visible when active
  - clearing override removes override marker after refresh

- [ ] **Step 2: Run the focused client tests and verify they fail**
  Run: `npx vitest run src/components/estimating/estimate-market-override-panel.test.tsx src/components/estimating/estimate-recommendation-options-panel.test.tsx src/components/estimating/estimating-workflow-shell.test.tsx`
  Expected: FAIL because the client does not render market-rate UI yet.

- [ ] **Step 3: Build the market override panel**
  Requirements:
  - show effective market and resolution source
  - load and render canonical market choices from the new server route
  - support choosing a replacement market
  - support clearing the override
  - call the new deal-level override endpoints and refresh the workbench

- [ ] **Step 4: Extend pricing evidence rendering**
  Requirements:
  - show baseline price, labor/material/equipment adjustments, final adjusted price
  - show whether the market was auto-detected or overridden
  - show fallback level when no exact market match was used

- [ ] **Step 5: Re-run the focused client tests and verify they pass**
  Run: `npx vitest run src/components/estimating/estimate-market-override-panel.test.tsx src/components/estimating/estimate-recommendation-options-panel.test.tsx src/components/estimating/estimating-workflow-shell.test.tsx`
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
  - worker-side generation coverage proves the production job uses new market-resolution inputs

- [ ] **Step 2: Run the focused integration tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/market-rate-integration.test.ts tests/modules/estimating/workflow-state-routes.test.ts`
  Run: `npx vitest run worker/tests/jobs/estimate-generation.test.ts`
  Expected: FAIL because end-to-end market-rate generation and override-refresh coverage is not implemented yet.

- [ ] **Step 3: Add the missing integration fixtures or wiring needed by the tests**
  Requirements:
  - generation fixtures exercise resolved market selection and persisted evidence
  - override route tests confirm refreshed workbench state reflects the new market context
  - override refresh uses the active generation run so stale pricing rows are not returned
  - worker fixtures confirm the live generation path uses the override-triggered rerun flow

- [ ] **Step 4: Re-run the focused integration tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/market-rate-integration.test.ts tests/modules/estimating/workflow-state-routes.test.ts`
  Run: `npx vitest run worker/tests/jobs/estimate-generation.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "test: add estimating market-rate integration coverage"`

## Task 8: Final Verification and Hardening

**Files:**
- Modify: any touched files from Tasks 1-7

- [ ] **Step 1: Run the focused estimating server test suite**
  Run: `npx vitest run tests/modules/estimating/*.test.ts`
  Expected: PASS

- [ ] **Step 2: Run the focused estimating client test suite**
  Run: `npx vitest run src/components/estimating/*.test.tsx`
  Expected: PASS

- [ ] **Step 3: Run workspace typecheck**
  Run: `npm run typecheck --workspace=shared --workspace=server --workspace=client --workspace=worker`
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
