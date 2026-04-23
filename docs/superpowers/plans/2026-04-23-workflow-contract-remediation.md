# Workflow Contract Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate workflow contract drift by establishing one canonical lead/deal workflow model, enforcing it on the server, projecting it consistently in the UI, and normalizing Bid Board sync/reporting around the same definitions.

**Architecture:** Introduce a canonical workflow registry in `shared/`, then move all server validation, sync, and reporting onto that registry before refactoring client surfaces to consume projected workflow metadata instead of raw stage slugs. The rollout is contract-first: make shared/server authoritative, then update sync, then UI, then analytics/tests.

**Tech Stack:** TypeScript, React, Express, Drizzle schema, Vitest, Playwright

---

### Task 1: Repair Broken Shared Schema Exports And Establish Canonical Workflow Types

**Files:**
- Modify: `shared/src/schema/index.ts`
- Modify: `shared/src/schema/public/index.ts`
- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/types/index.ts`
- Create: `shared/src/types/workflow.ts`
- Test: `shared` typecheck via workspace command

- [ ] **Step 1: Write the failing shared/server build verification**

Run:
```bash
npm run typecheck --workspace=shared
npm run typecheck --workspace=server
```

Expected:
- shared and/or server typecheck fails on missing `hubspot-owner-mappings.js` export and stale workflow contract mismatches

- [ ] **Step 2: Repair the broken schema export surface**

Implement:
- remove or correct the nonexistent `hubspot-owner-mappings.js` exports in both schema index files
- keep the shared schema export graph internally consistent

- [ ] **Step 3: Create canonical workflow contract types**

Add `shared/src/types/workflow.ts` containing:
- canonical lead stages:
  - `new_lead`
  - `qualified_lead`
  - `sales_validation`
  - `opportunity`
- canonical deal stages:
  - `opportunity`
  - `estimate_in_progress`
  - `service_estimating`
  - `estimate_under_review`
  - `estimate_sent_to_client`
  - `sent_to_production`
  - `service_sent_to_production`
  - `production_lost`
  - `service_lost`
- `WorkflowRoute`
- `WorkflowSystemOfRecord`
- canonical outcome categories
- helpers for stage-family and terminal-state checks

- [ ] **Step 4: Re-export canonical workflow types from the shared index**

Implement:
- re-export `workflow.ts` from `shared/src/types/index.ts`
- remove duplicated workflow unions from shared type barrels where they overlap with the new canonical contracts

- [ ] **Step 5: Run shared/server typecheck again**

Run:
```bash
npm run typecheck --workspace=shared
npm run typecheck --workspace=server
```

Expected:
- typecheck reaches green or fails only on downstream workflow consumers that still need refactoring in later tasks

- [ ] **Step 6: Commit**

```bash
git add shared/src/schema/index.ts shared/src/schema/public/index.ts shared/src/types/enums.ts shared/src/types/index.ts shared/src/types/workflow.ts
git commit -m "refactor: add canonical workflow contracts"
```

### Task 2: Enforce Canonical Lead Progression And Conversion On The Server

**Files:**
- Modify: `server/src/modules/leads/conversion-service.ts`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Test: `server/tests/modules/leads/conversion-service.test.ts`
- Test: `server/tests/modules/leads/service.test.ts`

- [ ] **Step 1: Add a failing conversion test for illegal lead conversion**

Add tests covering:
- converting `new_lead` directly to a deal is rejected
- converting `qualified_lead` directly to a deal is rejected
- only `opportunity` can hand off to estimating/deal creation
- project-type questions and qualification gates are required before later stages

- [ ] **Step 2: Run the targeted lead tests to verify failure**

Run:
```bash
npx vitest run --config client/vite.config.ts
```

Then run the correct server slice:
```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/leads/conversion-service.test.ts server/tests/modules/leads/service.test.ts
```

Expected:
- new canonical progression tests fail against current permissive conversion logic

- [ ] **Step 3: Implement lead progression enforcement**

Implement in server lead services:
- only canonical lead stages are valid for CRM-owned progression
- conversion requires `opportunity`
- route selection (`service` vs `normal`) comes from threshold/business rules, not arbitrary payload choice
- gate failures return explicit reasons, not generic 500/validation failures

- [ ] **Step 4: Verify tests pass**

Run:
```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/leads/conversion-service.test.ts server/tests/modules/leads/service.test.ts
```

Expected:
- all targeted lead progression tests pass

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/leads/conversion-service.ts server/src/modules/leads/service.ts server/src/modules/leads/routes.ts server/tests/modules/leads/conversion-service.test.ts server/tests/modules/leads/service.test.ts
git commit -m "fix: enforce canonical lead progression"
```

### Task 3: Enforce Deal Route/Family Compatibility And Bid Board Read-Only Ownership

**Files:**
- Modify: `server/src/modules/deals/stage-gate.ts`
- Modify: `server/src/modules/deals/stage-change.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/src/modules/deals/timer-service.ts`
- Test: `server/tests/modules/deals/stage-gate.test.ts`
- Test: `server/tests/modules/deals/service.test.ts`
- Test: `server/tests/modules/deals/stage-change.test.ts`

- [ ] **Step 1: Write failing tests for invalid route/stage combos and post-handoff edits**

Cover:
- normal deals cannot enter service-family stages
- service deals cannot enter normal-family stages
- downstream mirrored stages reject manual stage mutations after estimating handoff
- metadata/context edits remain allowed where designed

- [ ] **Step 2: Run the deal workflow tests to verify failure**

Run:
```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/deals/stage-gate.test.ts server/tests/modules/deals/service.test.ts
```

Expected:
- new route-family and read-only tests fail

- [ ] **Step 3: Implement server-side route-family validation and read-only enforcement**

Implement:
- stage lookup/validation must use canonical family metadata
- downstream stages marked `bid_board` reject manual CRM stage changes
- timers and stage side effects key off canonical workflow metadata, not legacy slugs

- [ ] **Step 4: Re-run targeted deal tests**

Run:
```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/deals/stage-gate.test.ts server/tests/modules/deals/service.test.ts
```

Expected:
- targeted tests pass

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/deals/stage-gate.ts server/src/modules/deals/stage-change.ts server/src/modules/deals/routes.ts server/src/modules/deals/timer-service.ts server/tests/modules/deals/stage-gate.test.ts server/tests/modules/deals/service.test.ts
git commit -m "fix: enforce deal workflow ownership boundaries"
```

### Task 4: Normalize Procore/Bid Board Sync Into Canonical Workflow States

**Files:**
- Modify: `server/src/modules/procore/synchub-routes.ts`
- Modify: `server/src/modules/procore/routes.ts`
- Modify: `server/src/modules/procore/stage-mapping.ts`
- Test: `server/tests/modules/procore/synchub-routes.test.ts`
- Test: `server/tests/modules/procore/bidboard-mirror-service.test.ts`

- [ ] **Step 1: Write failing sync tests for workflow route/history drift**

Cover:
- synced service-family stages write `workflow_route = service`
- synced normal-family stages write `workflow_route = normal`
- stage sync writes `deal_stage_history` and updates `stage_entered_at`
- ambiguous Procore mappings fail deterministically rather than `LIMIT 1` arbitrarily

- [ ] **Step 2: Run targeted sync tests to verify failure**

Run:
```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/procore/synchub-routes.test.ts
```

Expected:
- new sync correctness tests fail

- [ ] **Step 3: Implement canonical sync adapter behavior**

Implement:
- external stage/status -> canonical stage mapping
- synced route reconciliation
- stage history/timestamp updates through one path
- safer deduplication than `source + normalized name` alone

- [ ] **Step 4: Re-run sync tests**

Run:
```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/procore/synchub-routes.test.ts
```

Expected:
- targeted sync tests pass

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/procore/synchub-routes.ts server/src/modules/procore/routes.ts server/src/modules/procore/stage-mapping.ts server/tests/modules/procore/synchub-routes.test.ts
git commit -m "fix: normalize bid board sync onto canonical workflow"
```

### Task 5: Refactor Reports And Dashboards To Use Canonical Outcome Categories

**Files:**
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/dashboard/service.ts`
- Modify: `client/src/hooks/use-dashboard.ts`
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx`
- Test: `server/tests/modules/reports/service.test.ts`
- Test: `server/tests/modules/dashboard/service.test.ts`
- Test: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`

- [ ] **Step 1: Write failing analytics tests for canonical outcomes**

Cover:
- `service_lost` and `production_lost` count as losses
- production handoff is not treated as `closed_won`
- dashboard summaries expose canonical stage labels, not raw legacy names

- [ ] **Step 2: Run targeted reporting/dashboard tests to verify failure**

Run:
```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/reports/service.test.ts server/tests/modules/dashboard/service.test.ts
npx vitest run --config client/vite.config.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx
```

Expected:
- at least one server and one client assertion fails on legacy stage assumptions

- [ ] **Step 3: Implement canonical outcome/category mapping**

Implement:
- reports aggregate by canonical outcome category
- dashboard stage summaries normalize labels before returning to the client
- rep dashboard surfaces the same canonical stages as the deal board

- [ ] **Step 4: Re-run targeted tests**

Run:
```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/reports/service.test.ts server/tests/modules/dashboard/service.test.ts
npx vitest run --config client/vite.config.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx
```

Expected:
- targeted dashboard/report tests pass

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/reports/service.ts server/src/modules/dashboard/service.ts client/src/hooks/use-dashboard.ts client/src/pages/dashboard/rep-dashboard-page.tsx server/tests/modules/reports/service.test.ts server/tests/modules/dashboard/service.test.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx
git commit -m "fix: align dashboards and reports with canonical workflow"
```

### Task 6: Refactor Client Workflow Projection And Remove Legacy Stage Branching

**Files:**
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/components/leads/lead-stage-badge.tsx`
- Modify: `client/src/pages/leads/lead-new-page.tsx`
- Modify: `client/src/pages/deals/deal-detail-page.tsx`
- Modify: `client/src/components/deals/stage-change-dialog.tsx`
- Modify: `client/src/components/deals/deal-stage-badge.tsx`
- Modify: `client/src/hooks/use-pipeline-config.ts`
- Modify: `client/src/components/contacts/contact-deals-tab.tsx`
- Test: `client/src/pages/leads/lead-detail-page.test.tsx`
- Test: `client/src/pages/deals/deal-detail-page.test.tsx`
- Test: `client/src/pages/leads/lead-list-page.test.tsx`

- [ ] **Step 1: Write failing client tests for canonical workflow projection**

Cover:
- lead detail treats `qualified_lead` and `sales_validation` as active leads, not converted
- lead badges show canonical labels, not `Converted · ...`
- deal detail only offers valid stage moves for the record route/family
- loss dialog keys off canonical loss stages
- new lead creation defaults to canonical `new_lead`
- contact empty state offers a context-aware create-deal path

- [ ] **Step 2: Run targeted client tests to verify failure**

Run:
```bash
npx vitest run --config client/vite.config.ts client/src/pages/leads/lead-detail-page.test.tsx client/src/pages/deals/deal-detail-page.test.tsx client/src/pages/leads/lead-list-page.test.tsx
```

Expected:
- new projection tests fail on legacy branch logic

- [ ] **Step 3: Implement canonical workflow projection in the client**

Implement:
- remove `dd`, `closed_won`, `closed_lost`, `bid_sent`, `in_production` branching from these surfaces
- consume canonical workflow helpers/metadata from `shared/`
- make stage badges, move dialogs, and detail tabs route-aware
- make new-lead and contact-to-deal entry points choose canonical flows only

- [ ] **Step 4: Re-run targeted client tests**

Run:
```bash
npx vitest run --config client/vite.config.ts client/src/pages/leads/lead-detail-page.test.tsx client/src/pages/deals/deal-detail-page.test.tsx client/src/pages/leads/lead-list-page.test.tsx
```

Expected:
- targeted client tests pass

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/leads/lead-detail-page.tsx client/src/components/leads/lead-stage-badge.tsx client/src/pages/leads/lead-new-page.tsx client/src/pages/deals/deal-detail-page.tsx client/src/components/deals/stage-change-dialog.tsx client/src/components/deals/deal-stage-badge.tsx client/src/hooks/use-pipeline-config.ts client/src/components/contacts/contact-deals-tab.tsx client/src/pages/leads/lead-detail-page.test.tsx client/src/pages/deals/deal-detail-page.test.tsx client/src/pages/leads/lead-list-page.test.tsx
git commit -m "refactor: project canonical workflow in the client"
```

### Task 7: End-To-End Verification And Remediation Report

**Files:**
- Create: `docs/superpowers/reports/2026-04-23-workflow-contract-remediation-report.md`

- [ ] **Step 1: Run full targeted verification**

Run:
```bash
npm run typecheck --workspace=shared
npm run typecheck --workspace=server
npm run typecheck --workspace=client
npx vitest run --config server/vitest.config.ts
npx vitest run --config client/vite.config.ts
```

Expected:
- all workflow-relevant suites are green

- [ ] **Step 2: Run production-safe browser smoke if environment is available**

Run the existing Playwright production audit flow against:
- lead progression
- opportunity conversion
- opportunity -> estimating handoff
- service and normal stage family projection
- post-handoff read-only behavior
- rep dashboard canonical stage display

- [ ] **Step 3: Write remediation report**

Include:
- fixed findings
- residual risks
- deferred redesign items
- rollout recommendations

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/reports/2026-04-23-workflow-contract-remediation-report.md
git commit -m "docs: record workflow remediation verification"
```
