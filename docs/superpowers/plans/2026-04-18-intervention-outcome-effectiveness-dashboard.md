# Intervention Outcome Effectiveness Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen `/admin/intervention-analytics` so managers can evaluate conclusion-family, reason-level, disconnect-type, and assignee-level intervention effectiveness using history-backed metrics and deterministic drill-ins.

**Architecture:** Extend the existing `InterventionAnalyticsDashboard.outcomeEffectiveness` payload instead of creating a parallel reporting route. Server aggregation stays history-backed inside `intervention-service.ts`, server-produced drill-ins remain canonical, and the client swaps the lightweight effectiveness card for a richer but still read-first dashboard section on the existing analytics page.

**Tech Stack:** TypeScript, Express, Drizzle ORM, React, existing admin analytics components/hooks, Vitest.

---

## File Structure

### Existing files to modify

- `server/src/modules/ai-copilot/intervention-types.ts`
  - expand `InterventionOutcomeEffectiveness` with reason-level, escalation-target, interaction, warning, and assignee effectiveness rows
- `server/src/modules/ai-copilot/intervention-service.ts`
  - build the new history-backed effectiveness aggregations and deterministic drill-in links
- `server/src/modules/ai-copilot/routes.ts`
  - keep the route stable; only adjust payload typing/tests if needed
- `server/tests/modules/ai-copilot/intervention-service.test.ts`
  - add cohort, threshold, and link-contract coverage
- `server/tests/modules/ai-copilot/routes.test.ts`
  - protect API compatibility and payload shape
- `client/src/hooks/use-admin-interventions.ts`
  - extend workspace path helpers only if implementation needs new server-supported deep-link params
- `client/src/hooks/use-ai-ops.ts`
  - widen the response type for `outcomeEffectiveness`
- `client/src/hooks/use-ai-ops.test.ts`
  - lock the new analytics response contract
- `client/src/components/ai/intervention-effectiveness-summary.tsx`
  - replace lightweight cards with a richer effectiveness section
- `client/src/pages/admin/admin-intervention-analytics-page.tsx`
  - wire the enhanced section into the page layout
- `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`
  - verify the page renders the expanded effectiveness section safely

### New files likely needed

- `client/src/components/ai/intervention-effectiveness-reason-table.tsx`
  - reusable table for resolve/snooze/escalate reason rows
- `client/src/components/ai/intervention-effectiveness-reason-table.test.tsx`
  - focused render and `n/a` handling coverage
- `client/src/components/ai/intervention-effectiveness-warnings.tsx`
  - compact warning rail for weak conclusion patterns
- `client/src/components/ai/intervention-effectiveness-warnings.test.tsx`
  - threshold rendering and empty-state coverage

### Boundaries

- Keep all effectiveness aggregation in `intervention-service.ts`; do not add a new reporting service yet.
- Keep drill-in links server-authored.
- Keep the dashboard read-first; no mutations from outcome-effectiveness UI.
- Reuse the existing `/api/ai/ops/intervention-analytics` route.
- Do not invent client-only history filters for `/admin/interventions`; any new deep-link parameter must be explicitly supported server-side.

---

## Task 1: Lock the Expanded Effectiveness Contract

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`
- Modify: `client/src/hooks/use-ai-ops.ts`
- Test: `client/src/hooks/use-ai-ops.test.ts`

- [ ] **Step 1: Write the failing contract test**

Add a test that expects `outcomeEffectiveness` to include:

- `summaryByConclusionFamily`
- `resolveReasonPerformance`
- `snoozeReasonPerformance`
- `escalationReasonPerformance`
- `escalationTargetPerformance`
- `disconnectTypeInteractions`
- `assigneeEffectiveness`
- `warnings`

- [ ] **Step 2: Run the hook contract test to verify it fails**

Run: `npx vitest run client/src/hooks/use-ai-ops.test.ts`
Expected: FAIL on missing fields or mismatched typing.

- [ ] **Step 3: Expand the shared TypeScript contract**

Add deterministic row shapes for:

- summary rows
- reason-performance rows
- escalation-target performance rows
- disconnect-type interaction rows
- assignee effectiveness rows
- warning rows

Important rules:

- each actionable row must include `queueLink`
- nullable metrics should be `number | null`
- avoid optional nested objects unless rollout truly needs them

- [ ] **Step 4: Re-run the hook contract test**

Run: `npx vitest run client/src/hooks/use-ai-ops.test.ts`
Expected: PASS.

---

## Task 2: Build History-Backed Summary and Reason Aggregations

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Test: `server/tests/modules/ai-copilot/intervention-service.test.ts`

- [ ] **Step 1: Write failing server tests for reason-level cohorts**

Cover:

- durable close rate by conclusion family
- reopen rate by conclusion family
- median days to reopen by conclusion family
- resolve/snooze/escalate reason rows with volume and rates
- escalation target-type rows with volume and rates

Include a regression proving:

- reopened cases remain counted in the original conclusion cohort
- mutable current case state cannot erase historical effectiveness rows

- [ ] **Step 2: Run the targeted server test**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts`
Expected: FAIL on missing aggregation output.

- [ ] **Step 3: Implement the minimum history-backed aggregations**

Use conclusion history events plus later reopen events to compute:

- summary-by-family rows
- reason-level performance rows
- escalation-target performance rows

Rules:

- use a 30-day observation window
- return `null` instead of zero for statistically empty median/average values
- keep reason labels taxonomy-backed and deterministic

- [ ] **Step 4: Re-run the targeted server test**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts`
Expected: PASS for the new cohort tests.

---

## Task 3: Add Disconnect-Type and Assignee Effectiveness Cuts

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Test: `server/tests/modules/ai-copilot/intervention-service.test.ts`

- [ ] **Step 1: Write failing tests for interaction and assignee rows**

Cover:

- reopen rate by disconnect type and conclusion family
- assignee-at-conclusion rows with:
  - volume
  - resolve/snooze/escalate mix
  - durable close rate
  - reopen rate

Regression to add:

- below-threshold rows are omitted or grouped from manager-visible ranking output
- assignee name resolution uses historical assignee identity captured at conclusion time, not only current row ownership

- [ ] **Step 2: Run the service test**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts`
Expected: FAIL on missing rows/threshold behavior.

- [ ] **Step 3: Implement interaction and assignee aggregations**

Build:

- `disconnectTypeInteractions`
- `assigneeEffectiveness`

Guardrails:

- enforce minimum sample-size filtering in the server payload
- preserve exact raw counts used to compute manager-facing rates
- resolve `assigneeName` server-side

- [ ] **Step 4: Re-run the service test**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts`
Expected: PASS.

---

## Task 4: Add Deterministic Warning Rows and Queue Links

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`
- Test: `server/tests/modules/ai-copilot/intervention-service.test.ts`
- Test: `server/tests/modules/ai-copilot/routes.test.ts`

- [ ] **Step 1: Write failing tests for warning thresholds and links**

Cover warning rows for:

- snooze reasons with reopen rate `>= 0.35`
- escalation reason codes with durable close rate `<= 0.40`
- escalation target types with durable close rate `<= 0.40`
- disconnect types dominated by administrative-close patterns

Also cover:

- every warning row carries a `queueLink`
- route response exposes the new rows without breaking existing keys
- links only use supported workspace parameters or explicit singleton `caseId` drill-ins

- [ ] **Step 2: Run the targeted tests**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts server/tests/modules/ai-copilot/routes.test.ts`
Expected: FAIL on missing warnings or shape mismatch.

- [ ] **Step 3: Implement warning construction**

Rules:

- warning thresholds are deterministic constants in the server
- links should point to the nearest operational queue subset
- if exact history cohort drill-in is impossible, label and link to the best current queue subset rather than fabricating exactness
- only extend `buildInterventionWorkspacePath()` if the queue route gains real server support for a new parameter

- [ ] **Step 4: Re-run the targeted tests**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts server/tests/modules/ai-copilot/routes.test.ts`
Expected: PASS.

---

## Task 5: Replace the Lightweight Effectiveness UI

**Files:**
- Modify: `client/src/components/ai/intervention-effectiveness-summary.tsx`
- Create: `client/src/components/ai/intervention-effectiveness-reason-table.tsx`
- Create: `client/src/components/ai/intervention-effectiveness-warnings.tsx`
- Test: `client/src/components/ai/intervention-effectiveness-reason-table.test.tsx`
- Test: `client/src/components/ai/intervention-effectiveness-warnings.test.tsx`
- Test: `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`

- [ ] **Step 1: Write failing component/page tests**

Cover:

- summary-by-family cards render correctly
- reason tables render `n/a` safely for null metrics
- warning rail renders links and empty state
- analytics page still renders if one subsection has no rows

- [ ] **Step 2: Run the client tests**

Run: `npx vitest run client/src/pages/admin/admin-intervention-analytics-page.test.tsx`
Expected: FAIL because the old component cannot render the richer payload.

- [ ] **Step 3: Build the richer read-first UI**

Recommended layout inside the existing page section:

- top row:
  - conclusion-family summary cards
- middle:
  - three reason tables
- lower row:
  - disconnect-type interaction panel
  - assignee effectiveness panel
- side or bottom rail:
  - operational warnings

UI rules:

- no inline mutations
- no dense BI styling
- links should feel like queue handoffs, not dead labels

- [ ] **Step 4: Re-run the client tests**

Run: `npx vitest run client/src/components/ai/intervention-effectiveness-reason-table.test.tsx client/src/components/ai/intervention-effectiveness-warnings.test.tsx client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts`
Expected: PASS.

---

## Task 6: Full Verification and Review Readiness

**Files:**
- Review all touched files above

- [ ] **Step 1: Run the focused test suite**

Run:

```bash
npx vitest run \
  server/tests/modules/ai-copilot/intervention-service.test.ts \
  server/tests/modules/ai-copilot/routes.test.ts

npx vitest run \
  client/src/hooks/use-ai-ops.test.ts \
  client/src/components/ai/intervention-effectiveness-reason-table.test.tsx \
  client/src/components/ai/intervention-effectiveness-warnings.test.tsx \
  client/src/pages/admin/admin-intervention-analytics-page.test.tsx \
  --config client/vite.config.ts
```

Expected: PASS.

- [ ] **Step 2: Run workspace typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run whitespace / patch sanity**

Run: `git diff --check`
Expected: no output.

- [ ] **Step 4: Review for product alignment**

Confirm:

- no new routes were added
- analytics remain read-first
- links are deterministic
- metrics are history-backed, not current-row shortcuts
- below-threshold rows are not over-presented as hard conclusions

- [ ] **Step 5: Prepare for review loop**

Be ready to send both the updated implementation and the docs for the usual review/fix cycle before any merge handoff.

---

## Notes for the Implementer

- Reuse the existing intervention outcome taxonomy helpers rather than copying reason labels into the analytics layer.
- Be strict about `n/a` versus `0`; the dashboard should not imply certainty where the sample is weak.
- Prefer server-generated labels/links for any row the user can click.
- Keep the data model honest: effectiveness is a historical cohort problem, not a current queue snapshot with cosmetic math.
