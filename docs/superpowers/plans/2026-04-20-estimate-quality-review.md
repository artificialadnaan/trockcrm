# Estimate Quality Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve estimate generation quality inside the estimating workbench by adding ranked recommendation options, inferred missing-scope rows, stronger evidence/rationale, manual missing-item flows, local-catalog promotion for free-text custom rows, and deterministic duplicate-review gating before promotion into the canonical estimate model.

**Architecture:** Extend the current estimating generation and workbench flow instead of creating a second estimating product. The backend adds richer recommendation/option persistence, ranking and omission logic, deterministic review-state transitions, and duplicate-gated promotion rules. The client upgrades the existing workbench tables so estimators can inspect alternates, resolve missing items, add manual rows, promote useful custom rows into the local catalog, and promote only reviewable rows into the canonical estimate.

**Tech Stack:** Express, Drizzle, PostgreSQL, React, TypeScript, Vitest

---

## File Structure

- Modify: `shared/src/schema/tenant/estimate-pricing-recommendations.ts`
  Responsibility: add the recommendation-row fields required by the estimate-quality spec.
- Create: `shared/src/schema/tenant/estimate-pricing-recommendation-options.ts`
  Responsibility: persist ranked default/alternate/manual option rows.
- Modify: `shared/src/schema/index.ts`
  Responsibility: export the new recommendation-option table and schema additions.
- Create: `migrations/0031_estimate_quality_review.sql`
  Responsibility: add recommendation-option storage and recommendation metadata columns.
- Create: `server/src/modules/estimating/recommendation-option-service.ts`
  Responsibility: build and persist ranked recommendation options, rationale, and duplicate-group signals.
- Modify: `server/src/modules/estimating/pricing-service.ts`
  Responsibility: generate ranked defaults/alternates, option-level pricing rationale, and duplicate-group metadata.
- Modify: `server/src/modules/estimating/workbench-service.ts`
  Responsibility: return grouped recommendation sets, evidence, duplicate blockers, and promotable status.
- Modify: `server/src/modules/estimating/draft-estimate-service.ts`
  Responsibility: enforce duplicate gating, override precedence, and atomic promotion idempotency.
- Modify: `server/src/modules/estimating/local-catalog-service.ts`
  Responsibility: promote free-text custom manual rows into the tenant local catalog using the effective row values.
- Modify: `server/src/modules/deals/routes.ts`
  Responsibility: expose review-state mutations, manual add, local-catalog promotion, and row-scoped promotion actions.
- Create: `server/src/modules/estimating/manual-row-service.ts`
  Responsibility: create/edit manual rows, clone option state on rerun, and enforce free-text versus catalog-backed mode rules.
- Modify: `worker/src/jobs/estimate-generation.ts`
  Responsibility: emit recommendation sets with ranked options, inferred rows, and duplicate-group metadata.
- Create: `server/tests/modules/estimating/recommendation-option-service.test.ts`
  Responsibility: verify ranked options, duplicate grouping, and inference gating.
- Modify: `server/tests/modules/estimating/pricing-service.test.ts`
  Responsibility: verify ranking, alternate generation, and inferred-row output.
- Modify: `server/tests/modules/estimating/workbench-service.test.ts`
  Responsibility: verify grouped recommendation payloads, promotable derivation, and duplicate blockers.
- Modify: `server/tests/modules/estimating/draft-estimate-service.test.ts`
  Responsibility: verify atomic/idempotent promotion, duplicate blocking, and override precedence.
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`
  Responsibility: verify new review mutation routes and row payload contracts.
- Create: `client/src/components/estimating/estimate-recommendation-options-panel.tsx`
  Responsibility: render ranked options, rationale, and evidence for the selected row.
- Modify: `client/src/components/estimating/estimate-pricing-review-table.tsx`
  Responsibility: show recommendation status, duplicate blockers, local-catalog badges, and row actions.
- Modify: `client/src/components/estimating/estimate-extraction-review-table.tsx`
  Responsibility: surface inferred rows and missing-item handling inside the workbench flow.
- Modify: `client/src/components/estimating/estimating-workflow-shell.tsx`
  Responsibility: wire richer review actions, manual-add flow, and promote-to-estimate gating.
- Create: `client/src/components/estimating/estimate-manual-row-dialog.tsx`
  Responsibility: support catalog-first manual add with free-text fallback.
- Create: `client/src/components/estimating/estimate-recommendation-options-panel.test.tsx`
  Responsibility: verify option rendering, duplicate blockers, and local-catalog actions.
- Modify: `client/src/components/estimating/estimate-pricing-review-table.test.tsx`
  Responsibility: verify duplicate gating, review-state changes, and promotion enablement.
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`
  Responsibility: verify the end-to-end workbench state for recommendation review.

---

## Task 1: Add Recommendation-Option Storage and Schema Fields

**Files:**
- Modify: `shared/src/schema/tenant/estimate-pricing-recommendations.ts`
- Create: `shared/src/schema/tenant/estimate-pricing-recommendation-options.ts`
- Modify: `shared/src/schema/index.ts`
- Create: `migrations/0031_estimate_quality_review.sql`
- Modify: `server/tests/modules/estimating/schema-exports.test.ts`

- [ ] **Step 1: Write failing schema export tests for the new recommendation-option table and recommendation metadata**
- [ ] **Step 2: Run the focused schema tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/schema-exports.test.ts`
- [ ] **Step 3: Add the migration and schema changes**
  Include: `source_type`, `normalized_intent`, `source_row_identity`, `generation_run_id`, `manual_origin`, `selected_source_type`, `catalog_backing`, `promoted_local_catalog_item_id`, `manual_*`, `override_*`, and the new option table.
- [ ] **Step 4: Re-run the schema tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/schema-exports.test.ts`
- [ ] **Step 5: Commit**
  `git commit -m "feat: add estimate quality recommendation storage"`

## Task 2: Build Ranked Recommendation and Inferred-Scope Generation

**Files:**
- Create: `server/src/modules/estimating/recommendation-option-service.ts`
- Modify: `server/src/modules/estimating/pricing-service.ts`
- Modify: `worker/src/jobs/estimate-generation.ts`
- Create: `server/tests/modules/estimating/recommendation-option-service.test.ts`
- Modify: `server/tests/modules/estimating/pricing-service.test.ts`

- [ ] **Step 1: Write failing tests for ranked options, alternate selection order, and inferred-row gating**
- [ ] **Step 2: Run the focused generation tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/recommendation-option-service.test.ts tests/modules/estimating/pricing-service.test.ts`
- [ ] **Step 3: Implement ranked default/alternate generation**
  Requirements:
  - at most one recommended default plus up to four alternates
  - deterministic tie-break ordering
  - duplicate option suppression by catalog item or normalized custom item
  - inferred rows require document-backed evidence plus historical/dependency support
- [ ] **Step 4: Persist duplicate-group metadata and rationale payloads**
- [ ] **Step 5: Re-run the focused generation tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/recommendation-option-service.test.ts tests/modules/estimating/pricing-service.test.ts`
- [ ] **Step 6: Commit**
  `git commit -m "feat: generate estimate quality recommendation sets"`

## Task 3: Implement Review-State Mutations and Duplicate-Gated Promotion

**Files:**
- Modify: `server/src/modules/estimating/workbench-service.ts`
- Modify: `server/src/modules/estimating/draft-estimate-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/tests/modules/estimating/workbench-service.test.ts`
- Modify: `server/tests/modules/estimating/draft-estimate-service.test.ts`
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`

- [ ] **Step 1: Write failing tests for accept/switch/override/reject/pending-review actions and duplicate-blocked promotion**
- [ ] **Step 2: Run the focused review/promotion tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/workbench-service.test.ts tests/modules/estimating/draft-estimate-service.test.ts tests/modules/estimating/workflow-state-routes.test.ts`
- [ ] **Step 3: Implement review-state mutation handlers**
  Requirements:
  - `accept recommended`
  - `accept manual row`
  - `switch to alternate`
  - `override`
  - `reject`
  - `return to pending_review`
- [ ] **Step 4: Implement derived promotable logic and duplicate-review gating**
  Requirements:
  - duplicate groups are section-scoped
  - explicit rows are grouped and flagged, not auto-collapsed
  - inferred rows are the only rows auto-suppressed
  - rows blocked by duplicate groups cannot promote
- [ ] **Step 5: Implement atomic promotion idempotency**
  Requirements:
  - canonical estimate line creation plus `promoted_estimate_line_item_id` write-back is atomic
  - duplicate-blocked rows return row-level errors and create no canonical line
- [ ] **Step 6: Re-run the focused tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/workbench-service.test.ts tests/modules/estimating/draft-estimate-service.test.ts tests/modules/estimating/workflow-state-routes.test.ts`
- [ ] **Step 7: Commit**
  `git commit -m "feat: add estimate quality review and promotion flow"`

## Task 4: Add Manual Missing-Item Flow and Local-Catalog Promotion

**Files:**
- Create: `server/src/modules/estimating/manual-row-service.ts`
- Modify: `server/src/modules/estimating/local-catalog-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`
- Modify: `server/tests/modules/estimating/draft-estimate-service.test.ts`

- [ ] **Step 1: Write failing tests for manual add, manual catalog selection, free-text/local-catalog promotion, and rerun carry-forward**
- [ ] **Step 2: Run the focused manual-row tests and verify they fail**
  Run: `npx vitest run tests/modules/estimating/workflow-state-routes.test.ts tests/modules/estimating/draft-estimate-service.test.ts`
- [ ] **Step 3: Implement manual row creation/edit rules**
  Requirements:
  - catalog-first search with free-text fallback
  - immutable `manual_identity_key`
  - pending-review initial state
  - free-text versus catalog-backed mode transitions
- [ ] **Step 4: Implement local-catalog promotion rules**
  Requirements:
  - only free-text custom manual rows are eligible
  - direct selection of an existing local catalog item uses child option rows, not `promoted_local_catalog_item_id`
  - if override values exist, seed the new local catalog item from effective override values
- [ ] **Step 5: Re-run the focused manual/local-catalog tests and verify they pass**
  Run: `npx vitest run tests/modules/estimating/workflow-state-routes.test.ts tests/modules/estimating/draft-estimate-service.test.ts`
- [ ] **Step 6: Commit**
  `git commit -m "feat: add manual estimate quality item flows"`

## Task 5: Upgrade the Workbench UI for Recommendation Sets

**Files:**
- Create: `client/src/components/estimating/estimate-recommendation-options-panel.tsx`
- Create: `client/src/components/estimating/estimate-manual-row-dialog.tsx`
- Modify: `client/src/components/estimating/estimate-pricing-review-table.tsx`
- Modify: `client/src/components/estimating/estimate-extraction-review-table.tsx`
- Modify: `client/src/components/estimating/estimating-workflow-shell.tsx`
- Create: `client/src/components/estimating/estimate-recommendation-options-panel.test.tsx`
- Modify: `client/src/components/estimating/estimate-pricing-review-table.test.tsx`
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`

- [ ] **Step 1: Write failing client tests for ranked options, duplicate blockers, manual add, and promote-to-estimate gating**
- [ ] **Step 2: Run the focused client tests and verify they fail**
  Run: `npx vitest run src/components/estimating/estimate-recommendation-options-panel.test.tsx src/components/estimating/estimate-pricing-review-table.test.tsx src/components/estimating/estimating-workflow-shell.test.tsx`
- [ ] **Step 3: Build the recommendation/evidence panel and manual-add dialog**
- [ ] **Step 4: Upgrade the pricing review table**
  Requirements:
  - recommended/default badges
  - alternates access
  - inferred markers
  - duplicate-blocked state
  - local-catalog badges/actions
- [ ] **Step 5: Wire workbench actions end-to-end**
  Requirements:
  - accept/switch/override/reject/pending-review
  - manual add
  - promote custom row to local catalog
  - promote approved rows into the canonical estimate
- [ ] **Step 6: Re-run the focused client tests and verify they pass**
  Run: `npx vitest run src/components/estimating/estimate-recommendation-options-panel.test.tsx src/components/estimating/estimate-pricing-review-table.test.tsx src/components/estimating/estimating-workflow-shell.test.tsx`
- [ ] **Step 7: Commit**
  `git commit -m "feat: add estimate quality workbench ui"`

## Task 6: Final Verification and Hardening

**Files:**
- Modify: any touched files from Tasks 1-5

- [ ] **Step 1: Run the focused server test suite**
  Run: `npx vitest run tests/modules/estimating/*.test.ts`
- [ ] **Step 2: Run the focused client test suite**
  Run: `npx vitest run src/components/estimating/*.test.tsx`
- [ ] **Step 3: Run workspace typecheck**
  Run: `npm run typecheck --workspace=shared --workspace=server --workspace=client --workspace=worker`
- [ ] **Step 4: Fix any remaining failures and rerun verification until green**
- [ ] **Step 5: Commit**
  `git commit -m "test: verify estimate quality review slice"`

---

## Notes

- Do not backfill legacy recommendation rows into this workflow. Regenerate them under a fresh generation run instead.
- Keep canonical estimate rows as the final output. The workbench remains a review/promotion layer.
- Do not add a second spreadsheet-style estimate editor in this slice.
