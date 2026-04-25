# Lead Questionnaire V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a feature-flagged editable lead detail surface with table-backed project-type questionnaires, Sales Validation and conversion gating, and post-conversion answer auditability without breaking existing lead/deal lineage behavior.

**Architecture:** The implementation keeps current lead and deal rows intact, adds questionnaire config and answer tables, enforces the new rules server-side first, then exposes a feature-flagged client surface that reads the new tables while preserving flag-off behavior. Legacy JSON columns remain read-only compatibility data until a later cleanup migration removes them after 30 days of clean v2 production operation.

**Tech Stack:** Node, TypeScript, Drizzle, React, Vitest, Playwright, Railway

---

### Task 1: Red Test Checkpoint

**Files:**
- Modify: `server/tests/modules/leads/conversion-service.test.ts`
- Modify: `client/src/pages/leads/lead-detail-page.test.tsx`

- [x] **Step 1: Write the failing tests**
- [x] **Step 2: Run targeted tests and verify they fail for the intended missing behavior**
- [x] **Step 3: Commit tests-only checkpoint**

### Task 2: Migration Layer

**Files:**
- Create: `migrations/<next>_lead_questionnaire_v2.sql`
- Modify: `shared/src/schema/index.ts`
- Create: `shared/src/schema/public/project-type-question-nodes.ts`
- Create: `shared/src/schema/tenant/lead-question-answers.ts`
- Create: `shared/src/schema/tenant/lead-question-answer-history.ts`
- Modify: `shared/src/schema/tenant/leads.ts`

- [ ] Add additive questionnaire tables and nullable `leads.project_type_id` support only if missing.
- [ ] Do not modify or drop legacy JSON columns in this migration.
- [ ] Add schema exports and table definitions.
- [ ] Run schema-focused tests and typecheck.
- [ ] Commit migration layer.

### Task 3: Backend Services

**Files:**
- Create: `server/src/modules/leads/questionnaire-service.ts`
- Modify: `server/src/modules/leads/stage-transition-service.ts`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/leads/conversion-service.ts`
- Modify: `server/tests/modules/leads/conversion-service.test.ts`
- Modify: `server/tests/modules/leads/stage-transition-service.test.ts`

- [ ] Implement parent/child reveal evaluation with no JSON rule engine.
- [ ] Enforce Sales Validation entry gate server-side.
- [ ] Re-enforce questionnaire completeness during conversion.
- [ ] Write answers/history without mutating `leads.updated_at` for converted leads.
- [ ] Ensure v2 never writes legacy JSON columns.
- [ ] Run backend unit tests and commit backend services.

### Task 4: Backend Routes

**Files:**
- Modify: `server/src/modules/leads/routes.ts`
- Modify: `server/tests/modules/leads/conversion-service.test.ts`

- [ ] Extend lead detail/update responses to expose questionnaire config and answer state under the flag.
- [ ] Keep route shapes backward-compatible for flag-off clients.
- [ ] Enforce hidden-lead read-only behavior at the route/service boundary.
- [ ] Run route-adjacent tests and commit backend routes.

### Task 5: Frontend Hooks

**Files:**
- Modify: `client/src/hooks/use-leads.ts`
- Modify: `client/src/hooks/use-pipeline-config.ts` as needed

- [ ] Add typed questionnaire config/answer fields for flag-on reads.
- [ ] Add lead update payload support for questionnaire answers without exposing write paths to legacy columns.
- [ ] Keep flag-off behavior unchanged.
- [ ] Run client hook/type tests and commit frontend hooks.

### Task 6: Frontend UI

**Files:**
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/components/leads/lead-form.tsx`
- Create: `client/src/components/leads/lead-questionnaire-editor.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.test.tsx`

- [ ] Add feature-flagged edit mode for the lead detail page.
- [ ] Render config-driven baseline and project-type questions with parent/child reveals only.
- [ ] Make hidden leads read-only in the UI.
- [ ] Preserve current flag-off read-only rendering.
- [ ] Run client tests and commit frontend UI.

### Task 7: Integration and Regression Verification

**Files:**
- Modify: integration or audit test files only as needed

- [ ] Add or update integration coverage for lead edit, Sales Validation entry, conversion backstop, and post-conversion answer edits.
- [ ] Run the new questionnaire tests.
- [ ] Run the existing 28-test audit suite and keep it green.
- [ ] Commit integration tests.

### Task 8: Deploy and Verify

**Files:**
- Modify: `CHANGELOG.md`

- [ ] Deploy using the Railway protocol.
- [ ] Verify feature flag off first.
- [ ] Verify stale bundle hash changes after frontend deploy.
- [ ] Verify feature flag on in test-safe conditions.
- [ ] Run post-deploy audit coverage and questionnaire verification.
- [ ] Update changelog and report outcomes.
