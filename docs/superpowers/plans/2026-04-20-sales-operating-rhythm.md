# Sales Operating Rhythm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing CRM so sales can manage forecast discipline, structured selling activity, weekly review meetings, and pipeline hygiene directly in-product.

**Architecture:** Reuse the current lead/deal hierarchy, report service, dashboards, and activity system. Add forecast and qualification fields to leads and deals, extend structured activity types, build a dedicated weekly review surface on top of current report foundations, then add a hygiene queue and stage-alignment enforcement so the workflow stays clean.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Express, Drizzle ORM, PostgreSQL

---

## Scope Check

This plan covers one coherent subsystem: the sales operating layer on top of the current CRM. Forecasting, structured activity, weekly review, and hygiene checks are interdependent and should be implemented together in dependency order.

## File Structure

### Shared schema and types

- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/schema/tenant/leads.ts`
- Modify: `shared/src/schema/tenant/deals.ts`
- Modify: `shared/src/schema/tenant/activities.ts`
- Modify: `shared/src/schema/public/pipeline-stage-config.ts`
- Create: `shared/src/types/sales-review.ts`

### Server modules

- Modify: `server/src/app.ts`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Modify: `server/src/modules/deals/service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/src/modules/deals/stage-gate.ts`
- Modify: `server/src/modules/activities/service.ts`
- Modify: `server/src/modules/activities/routes.ts`
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Create: `server/src/modules/sales-review/service.ts`
- Create: `server/src/modules/sales-review/routes.ts`
- Create: `server/src/modules/sales-review/hygiene-service.ts`

### Client surfaces

- Modify: `client/src/components/layout/sidebar.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/pages/deals/deal-detail-page.tsx`
- Modify: `client/src/components/activities/activity-log-form.tsx`
- Modify: `client/src/pages/reports/reports-page.tsx`
- Create: `client/src/hooks/use-sales-review.ts`
- Create: `client/src/pages/sales-review/sales-review-page.tsx`
- Create: `client/src/components/sales-review/sales-review-filters.tsx`
- Create: `client/src/components/sales-review/sales-review-forecast-table.tsx`
- Create: `client/src/components/sales-review/sales-review-activity-card.tsx`
- Create: `client/src/components/sales-review/sales-review-hygiene-card.tsx`
- Create: `client/src/components/sales-review/sales-review-support-card.tsx`
- Create: `client/src/components/shared/forecast-editor.tsx`
- Create: `client/src/components/shared/next-step-editor.tsx`
- Create: `client/src/pages/pipeline/pipeline-hygiene-page.tsx`
- Modify: `client/src/App.tsx`

### Tests and migrations

- Create: `migrations/00xx_sales_operating_rhythm.sql`
- Create: `server/tests/modules/sales-review/service.test.ts`
- Create: `server/tests/modules/sales-review/hygiene-service.test.ts`
- Modify: `server/tests/modules/reports/service.test.ts`
- Modify: `server/tests/modules/deals/stage-gate.test.ts`
- Modify: `server/tests/modules/activities/service.test.ts`
- Create: `client/src/pages/sales-review/sales-review-page.test.tsx`
- Create: `client/src/components/shared/forecast-editor.test.tsx`
- Create: `client/src/components/shared/next-step-editor.test.tsx`
- Modify: `client/src/components/activities/activity-log-form.test.tsx`

## Task 1: Add Forecast And Qualification Schema

**Files:**
- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/schema/tenant/leads.ts`
- Modify: `shared/src/schema/tenant/deals.ts`
- Create: `migrations/00xx_sales_operating_rhythm.sql`
- Test: `server/tests/modules/sales-review/service.test.ts`

- [ ] Add failing tests that expect leads and deals to expose forecast window, category, confidence, blockers, next step, next milestone, support-needed, and qualification fields.
- [ ] Run: `npx vitest run server/tests/modules/sales-review/service.test.ts`
- [ ] Add enums for `forecastWindow`, `forecastCategory`, and `supportNeededType` in `shared/src/types/enums.ts`.
- [ ] Extend `shared/src/schema/tenant/leads.ts` and `shared/src/schema/tenant/deals.ts` with the new sales-operating fields from the spec.
- [ ] Create `migrations/00xx_sales_operating_rhythm.sql` to add the new columns with safe nullable defaults for existing records.
- [ ] Re-run: `npx vitest run server/tests/modules/sales-review/service.test.ts`
- [ ] Run: `npm run typecheck`
- [ ] Commit: `git commit -m "feat: add sales operating forecast fields"`

## Task 2: Extend Activity Types And Logging Contract

**Files:**
- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/schema/tenant/activities.ts`
- Modify: `server/src/modules/activities/service.ts`
- Modify: `server/src/modules/activities/routes.ts`
- Modify: `client/src/components/activities/activity-log-form.tsx`
- Modify: `client/src/components/activities/activity-log-form.test.tsx`
- Modify: `server/tests/modules/activities/service.test.ts`

- [ ] Add failing server tests for the new activity types: `voicemail`, `lunch`, `site_visit`, `proposal_sent`, `redline_review`, `go_no_go`, `follow_up`, and `support_request`.
- [ ] Run: `npx vitest run server/tests/modules/activities/service.test.ts`
- [ ] Extend the activity enum and schema so the new activity types are valid and persist next-step metadata.
- [ ] Update activity service validation to accept the new types and optional next-step fields.
- [ ] Update `activity-log-form.tsx` so reps can choose the new types without expanding the form into a long workflow wizard.
- [ ] Re-run: `npx vitest run server/tests/modules/activities/service.test.ts client/src/components/activities/activity-log-form.test.tsx`
- [ ] Run: `npm run typecheck`
- [ ] Commit: `git commit -m "feat: expand sales activity logging"`

## Task 3: Add Forecast And Next-Step Editing To Lead And Deal Detail Views

**Files:**
- Create: `client/src/components/shared/forecast-editor.tsx`
- Create: `client/src/components/shared/next-step-editor.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/pages/deals/deal-detail-page.tsx`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Modify: `server/src/modules/deals/service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Test: `client/src/components/shared/forecast-editor.test.tsx`
- Test: `client/src/components/shared/next-step-editor.test.tsx`

- [ ] Add failing client tests that expect forecast and next-step editors to render current values, validate required combinations, and submit updates.
- [ ] Run: `npx vitest run client/src/components/shared/forecast-editor.test.tsx client/src/components/shared/next-step-editor.test.tsx`
- [ ] Add lead and deal update APIs for the new sales-operating fields.
- [ ] Build shared forecast and next-step editor components instead of duplicating forms in both detail pages.
- [ ] Mount those editors in the lead and deal detail views in a location visible during normal rep workflow.
- [ ] Re-run: `npx vitest run client/src/components/shared/forecast-editor.test.tsx client/src/components/shared/next-step-editor.test.tsx`
- [ ] Run: `npm run typecheck`
- [ ] Commit: `git commit -m "feat: add forecast editing to lead and deal detail"`

## Task 4: Build Sales Review Service And Reports

**Files:**
- Create: `shared/src/types/sales-review.ts`
- Modify: `server/src/app.ts`
- Create: `server/src/modules/sales-review/service.ts`
- Create: `server/src/modules/sales-review/routes.ts`
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Modify: `server/tests/modules/reports/service.test.ts`
- Create: `server/tests/modules/sales-review/service.test.ts`

- [ ] Add failing tests for:
  - `new opportunities in last 14 days`
  - per-rep `30/60/90` forecast rollups across leads and deals
  - expanded activity counts with the new sales activity types
  - support-needed rollups
- [ ] Run: `npx vitest run server/tests/modules/sales-review/service.test.ts server/tests/modules/reports/service.test.ts`
- [ ] Implement a dedicated sales review service that returns one meeting-friendly payload rather than forcing the client to stitch together many unrelated report endpoints.
- [ ] Extend the report service to expose the new forecast and hygiene counts alongside existing weighted forecast and stale-record reports.
- [ ] Add server routes for the sales review workspace and its filters, and register them in `server/src/app.ts` with the same tenant auth middleware as other operational routes.
- [ ] Re-run: `npx vitest run server/tests/modules/sales-review/service.test.ts server/tests/modules/reports/service.test.ts`
- [ ] Run: `npm run typecheck`
- [ ] Commit: `git commit -m "feat: add sales review reporting service"`

## Task 5: Build Weekly Sales Review Workspace

**Files:**
- Create: `client/src/hooks/use-sales-review.ts`
- Create: `client/src/pages/sales-review/sales-review-page.tsx`
- Create: `client/src/components/sales-review/sales-review-filters.tsx`
- Create: `client/src/components/sales-review/sales-review-forecast-table.tsx`
- Create: `client/src/components/sales-review/sales-review-activity-card.tsx`
- Create: `client/src/components/sales-review/sales-review-hygiene-card.tsx`
- Create: `client/src/components/sales-review/sales-review-support-card.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/layout/sidebar.tsx`
- Test: `client/src/pages/sales-review/sales-review-page.test.tsx`

- [ ] Add failing UI tests that expect the page to render new-opportunity, forecast, activity, hygiene, and support sections from one mock payload.
- [ ] Run: `npx vitest run client/src/pages/sales-review/sales-review-page.test.tsx`
- [ ] Add a focused `use-sales-review.ts` hook so the page does not embed fetch and filter orchestration directly.
- [ ] Build the review page and supporting components with consistent row structure for weekly meeting use.
- [ ] Wire the route into `client/src/App.tsx` with the same auth patterns used by existing operational pages.
- [ ] Add navigation entry points in `client/src/components/layout/sidebar.tsx` that respect role boundaries for reps versus directors/admins.
- [ ] Keep the layout scan-friendly: tables for forecast, compact cards for activity/hygiene/support, and filters for rep/date/window.
- [ ] Re-run: `npx vitest run client/src/pages/sales-review/sales-review-page.test.tsx`
- [ ] Run: `npm run typecheck`
- [ ] Commit: `git commit -m "feat: add weekly sales review workspace"`

## Task 6: Build Hygiene Queue And Deep-Link Workflow

**Files:**
- Create: `server/src/modules/sales-review/hygiene-service.ts`
- Create: `server/tests/modules/sales-review/hygiene-service.test.ts`
- Modify: `server/src/modules/deals/stage-gate.ts`
- Modify: `shared/src/schema/public/pipeline-stage-config.ts`
- Create: `client/src/pages/pipeline/pipeline-hygiene-page.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/layout/sidebar.tsx`

- [ ] Add failing tests for hygiene rules:
  - missing forecast window/category/confidence
  - missing next milestone
  - missing next step on active record
  - stale stage beyond threshold
  - active record with no recent activity
- [ ] Run: `npx vitest run server/tests/modules/sales-review/hygiene-service.test.ts server/tests/modules/deals/stage-gate.test.ts`
- [ ] Implement hygiene evaluation as a server service so the rules are deterministic and reusable across the queue, reports, and future automation.
- [ ] Extend stage-gate rules so sales-facing stages can require qualification and forecast fields when appropriate.
- [ ] Build a pipeline hygiene page that lists actionable issues with deep links back to the owning record.
- [ ] Add route and navigation wiring for the hygiene page using the existing role-aware app-shell patterns.
- [ ] Re-run: `npx vitest run server/tests/modules/sales-review/hygiene-service.test.ts server/tests/modules/deals/stage-gate.test.ts`
- [ ] Run: `npm run typecheck`
- [ ] Commit: `git commit -m "feat: add pipeline hygiene queue"`

## Task 7: Connect Reports And Final Verification

**Files:**
- Modify: `client/src/pages/reports/reports-page.tsx`
- Modify: `server/src/modules/reports/service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Test: `client/src/pages/sales-review/sales-review-page.test.tsx`
- Test: `server/tests/modules/reports/service.test.ts`

- [ ] Add failing tests that expect reports to expose the new `30/60/90` and hygiene summaries without breaking the existing weighted forecast and stale-record reports.
- [ ] Run: `npx vitest run server/tests/modules/reports/service.test.ts client/src/pages/sales-review/sales-review-page.test.tsx`
- [ ] Add the new sales-operating reports and links into `reports-page.tsx` so the review workspace and canonical reports stay aligned.
- [ ] Verify the final route map, auth wiring, and navigation entry points.
- [ ] Re-run: `npx vitest run server/tests/modules/reports/service.test.ts client/src/pages/sales-review/sales-review-page.test.tsx`
- [ ] Run: `npm run typecheck`
- [ ] Commit: `git commit -m "feat: finalize sales operating rhythm reporting"`

## Final Verification

- [ ] Run: `npx vitest run server/tests/modules/sales-review/service.test.ts server/tests/modules/sales-review/hygiene-service.test.ts server/tests/modules/reports/service.test.ts server/tests/modules/deals/stage-gate.test.ts server/tests/modules/activities/service.test.ts client/src/components/activities/activity-log-form.test.tsx client/src/components/shared/forecast-editor.test.tsx client/src/components/shared/next-step-editor.test.tsx client/src/pages/sales-review/sales-review-page.test.tsx`
- [ ] Expected: all targeted tests pass with no skipped assertions for the new workflow.
- [ ] Run: `npm run typecheck`
- [ ] Expected: repo typecheck passes.
- [ ] Run: `git status --short`
- [ ] Expected: only intended files are modified.

## Self-Review

Spec coverage check:

- forecast discipline is covered in Tasks 1, 3, 4, and 7
- structured activity expansion is covered in Task 2
- weekly review workspace is covered in Tasks 4 and 5
- hygiene queue and stage enforcement are covered in Task 6
- report alignment is covered in Task 7

Placeholder scan:

- no `TBD` or deferred implementation markers remain
- each task names exact files and concrete verification commands

Type consistency check:

- plan uses `forecastWindow`, `forecastCategory`, `forecastConfidencePercent`, `nextMilestoneAt`, `nextStep`, and `supportNeededType` consistently across schema, services, client, and tests
