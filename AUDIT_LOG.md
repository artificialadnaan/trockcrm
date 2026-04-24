## Running Summary
- Iteration count: 2
- Total tests generated: 3
- Pass/fail count per iteration:
  - Iteration 1: passed after deploy verification
  - Iteration 2: in progress
- Issues fixed vs deferred:
  - Fixed: 3
  - Deferred: 0
- Deploy failures encountered and recovered: 0
- Last successful Railway deploy SHA + timestamp: `10043d5` / 2026-04-24 09:59 CDT

## Setup
- Production URL: `https://frontend-production-bcab.up.railway.app`
- Railway project/environment: `T Rock CRM / production`
- CLI health baseline:
  - `railway whoami` confirmed authenticated
  - `railway status` confirmed linked to production
- Safety mode:
  - production-only audit
  - no local dev server
  - no destructive real-data operations

## Surface Area
### Router Shape
- App boot is `AuthProvider -> AuthGate`; unauthenticated users land on `DevUserPicker`.
- `/` is role-dependent: reps land on the rep dashboard, directors/admins land on the director dashboard.
- `/photos/capture` is outside `AppShell`; most routes render inside the shared shell.
- Unknown routes redirect to `/`.

### Role Coverage
- `rep`: deals, leads, properties, pipeline, contacts, companies, email, tasks, files, photos, reports, projects, search, user guide.
- `director`: all rep surfaces plus director views, rep detail drilldowns, merge queue, and analytics/ops surfaces.
- `admin`: all director surfaces plus offices, users, pipeline config, Procore sync, migration, data scrub, companycam, and admin guide.

### Core Flow Inventory
- Deals: list, detail, edit, create, stage change, scoping, estimates, files, timers, timeline, closeout.
- Leads: list, detail, create, qualification/edit, convert to deal flow.
- Pipeline: board view, drag/drop stage change, refresh, DD toggle, deal drilldown.
- Contacts/Companies/Properties: list/detail/edit flows with related record navigation.
- Dashboard: rep and director KPI surfaces, pipeline summaries, stale worklists, rep drilldowns.
- Reports: locked reports, custom reporting, exports, workflow overview, forecast/source/regional analytics.

Issue #1 — Missing live deal stage drilldown route
Route/Component: `/pipeline`, `/deals/stages/:stageId`, pipeline stage headers
Severity: high
Environment: production (Railway)
Discovered: iteration 1, manual production repro + code trace
Symptom: stage drilldown surface was missing in the current tree, and production users hit broken stage workflows instead of a live stage report.
Root cause: the branch lacked the client route, page, hook contract, and server endpoint for `/deals/stages/:stageId`.
Fix: added canonical deal stage route, pipeline header navigation, filtered stage report UI, and matching API endpoint.
Deployed: `10043d5`
Deploy status: SUCCESS
Verification: production rep drilldown opens `/deals/stages/:stageId?scope=mine`, renders filters, and supports clickable rows
Status: fixed

Issue #2 — Legacy dashboard stage link contract
Route/Component: `DirectorDashboardPage`, `DealListPage`, deal filters
Severity: medium
Environment: production (Railway)
Discovered: iteration 1, code trace
Symptom: dashboard links still use `?stage=dd`, but current deal filters understand `stageIds`, not `stage`, so stage drilldowns do not apply a real filter contract.
Root cause: stale query-param contract left behind after the workflow refactor.
Fix: moved stage drilldowns onto the canonical `/deals/stages/:stageId` surface and removed reliance on the legacy `?stage=dd` contract.
Deployed: `10043d5`
Deploy status: SUCCESS
Verification: live stage drilldown links now open the canonical stage report route
Status: fixed

Issue #3 — API client fails noisily on HTML responses
Route/Component: `client/src/lib/api.ts`
Severity: medium
Environment: production (Railway)
Discovered: iteration 1, production screenshot + code trace
Symptom: `Unexpected token '<'` surfaced directly in the UI when HTML was returned where JSON was expected.
Root cause: `api()` blindly called `res.json()` without checking `content-type`.
Fix: added guarded JSON parsing with content-type validation and a more actionable error message.
Deployed: `10043d5`
Deploy status: SUCCESS
Verification: stale bundle mismatch no longer surfaces as a raw JSON parse crash in the same codepath
Status: fixed

Issue #4 — Lead detail conversion bypassed the guarded lead-to-opportunity flow
Route/Component: `/leads/:id`, `LeadDetailPage`, `LeadForm` summary action
Severity: critical
Environment: production (Railway)
Discovered: iteration 2, manual production repro + code trace
Symptom: clicking `Convert to Deal` from a lead detail sent the user straight to `/deals/new`, even while the lead was still `New Lead`.
Root cause: `LeadDetailPage` rendered the summary form's generic primary action instead of the guarded `LeadConvertDialog`.
Fix: in progress — hide the generic summary action on lead detail, render an explicit `Convert to Opportunity` action only at the final lead checkpoint, and route conversion through `LeadConvertDialog`.
Deployed: pending
Deploy status: pending
Verification: local tests `client/src/pages/leads/lead-detail-page.test.tsx`, `server/tests/modules/leads/conversion-service.test.ts`
Status: in progress

Issue #5 — Lead conversion server guard required a hidden lead-stage contract
Route/Component: `/api/leads/:id/convert`, `conversion-service.ts`
Severity: critical
Environment: production (Railway)
Discovered: iteration 2, manual production repro + code trace
Symptom: the server only allowed conversion from a canonical `opportunity` lead stage even though the live lead workflow is `New Lead -> Qualified Lead -> Sales Validation Stage`.
Root cause: conversion enforcement was anchored to a hidden lead-side opportunity stage instead of the real final lead checkpoint.
Fix: in progress — allow conversion from canonical `sales_validation` while still rejecting earlier lead stages.
Deployed: pending
Deploy status: pending
Verification: local tests `server/tests/modules/leads/conversion-service.test.ts`
Status: in progress

Issue #6 — Project type select flips between uncontrolled and controlled states
Route/Component: `/leads/:id/edit`, `LeadForm`
Severity: medium
Environment: production (Railway)
Discovered: iteration 2, production browser console + manual edit flow
Symptom: React warns that the project type select switches from uncontrolled to controlled, and the select can surface internal IDs instead of stable placeholder/label behavior.
Root cause: `LeadForm` passed `undefined` when no project type was selected and then switched to a real id later.
Fix: in progress — use a stable `__none__` sentinel value and explicit placeholder option in both create and edit project type selects.
Deployed: pending
Deploy status: pending
Verification: local tests `client/src/components/leads/lead-form.test.tsx`
Status: in progress
