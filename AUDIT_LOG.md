## Running Summary
- Iteration count: 12
- Total tests generated: 23
- Pass/fail count per iteration:
  - Iteration 1: passed after deploy verification
  - Iteration 7: passed after clean-worktree API deploy verification
  - Iteration 8: passed after clean-worktree API deploy verification
  - Iteration 9: passed after clean-worktree API + Frontend deploy verification
  - Iteration 10: reports / director / admin audit suite green against the live `73345c4` deploy
  - Iteration 11: companies / properties audit suite green locally against production; frontend deploy pending
  - Iteration 12: notification stream CORP fix verified locally; API + frontend deploy pending
- Issues fixed vs deferred:
  - Fixed: 12
  - Deferred: 0
- Deploy failures encountered and recovered: 1
- Last successful Railway deploy SHA + timestamp: `73345c4` / 2026-04-24 16:02 CDT

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

Issue #7 — Successful estimating handoff leaves the UI on a forbidden CRM scoping endpoint
Route/Component: `/deals/:id?tab=scoping`, `DealDetailPage`, `DealScopingWorkspace`
Severity: high
Environment: production (Railway)
Discovered: iteration 3, live lead -> opportunity -> estimating audit
Symptom: after a successful `Opportunity -> Estimate in Progress` handoff, the deal changes stages correctly but the page logs two `403` console errors from `GET /api/deals/:id/scoping-intake`.
Root cause: the detail page kept rendering the editable scoping workspace while the deal was already Bid Board-owned, so the client continued calling a CRM-only endpoint that is supposed to be blocked after handoff.
Fix: render a dedicated read-only scoping panel for Bid Board-owned deals instead of mounting `DealScopingWorkspace`; add a shared `@` alias to `vitest.config.ts` so this client path is testable in the worktree.
Deployed: pending
Deploy status: pending
Verification: local `npx vitest run --config vitest.config.ts client/src/pages/deals/deal-detail-page.test.tsx` and `npm run typecheck --workspace=client`
Status: in progress

Issue #8 — Sales rep team-member picker depends on an admin-only user directory
Route/Component: `/deals/:id?tab=team`, `DealTeamTab`, `AddMemberDialog`
Severity: high
Environment: production (Railway)
Discovered: iteration 3, live production audit of assignment flow
Symptom: opening `Add Team Member` as a sales rep triggers `GET /api/admin/users => 403`, so the UI picker cannot load selectable users even though `POST /api/deals/:id/team` succeeds.
Root cause: the dialog hard-coded the admin user directory instead of a deal-scoped assignable-user source.
Fix: added `GET /api/deals/:id/team/assignable-users` and repointed the dialog to it; also made the closed select render an explicit display label instead of relying on async option hydration.
Deployed: pending
Deploy status: pending
Verification: local `npm run typecheck --workspace=server` and `npm run typecheck --workspace=client`
Status: in progress

Issue #9 — Reports overview 500s because data-mining CTEs are declared in the wrong order
Route/Component: `/reports`, `/api/reports/data-mining`, `getDataMiningOverview`
Severity: high
Environment: production (Railway)
Discovered: iteration 7, live director production audit
Symptom: `/reports` renders `Internal server error`, and the browser logs `500` failures for `/api/reports/data-mining`.
Root cause: the first two `data-mining` queries reference `office_company_context` from `office_office_activity_scope` before `office_company_context` is declared in the `WITH` chain, which fails on PostgreSQL in production.
Fix: inserted `officeCompanyContext` before `officeOfficeActivityScope` in both untouched-contact queries and tightened the report test to assert the CTE declaration order.
Deployed: `5e51ed5` + Railway API deploy `606bb965-feec-4d72-90ff-0eaa95948358` + 2026-04-24 15:00 CDT
Deploy status: SUCCESS
Verification: local `npx vitest run --config vitest.config.ts server/tests/modules/reports/analytics-cycle.test.ts`; confirmed passing on prod via `/reports` and `/api/reports/data-mining`
Status: fixed

Issue #10 — Workflow overview 500s because a UNION mixes enum types without a cast
Route/Component: `/reports`, `/api/reports/workflow-overview`, `getUnifiedWorkflowOverview`
Severity: high
Environment: production (Railway)
Discovered: iteration 7, live director production audit
Symptom: `/reports` renders `Internal server error`, and the browser logs `500` failures for `/api/reports/workflow-overview`.
Root cause: the CRM-owned progression query unions `leads.pipeline_type` with `deals.workflow_route`; PostgreSQL cannot implicitly union `lead_pipeline_type` and `workflow_route`.
Fix: cast both union branches to `text` for the shared `workflow_route` projection and added a regression test that pins the cast in the generated SQL.
Deployed: `5e51ed5` + Railway API deploy `606bb965-feec-4d72-90ff-0eaa95948358` + 2026-04-24 15:00 CDT
Deploy status: SUCCESS
Verification: local `npx vitest run --config vitest.config.ts server/tests/modules/reports/service.test.ts` and `npm run typecheck --workspace=server`; confirmed passing on prod via `/reports` and `/api/reports/workflow-overview`
Status: fixed

Deploy Failure #1 — Manual Railway API deploy picked the stale root checkout instead of the clean audit worktree
Iteration: 7
Commit: `4673169`
Failure type: build error
Railway log excerpt: `src/schema/index.ts(15,38): error TS2307: Cannot find module './public/hubspot-owner-mappings.js'`
Root cause: `railway up` from the worktree still resolved the dirty root checkout as the archive root, and the root checkout was missing `shared/src/schema/public/hubspot-owner-mappings.ts`.
Fix: re-ran the deployment with `railway up . --path-as-root -s API -c` so Railway archived the clean worktree itself.
Recovery commit: `4673169`
Final deploy status: SUCCESS

Issue #11 — Workflow overview mirrored-stage rollup groups by a coalesced label but selects the raw stage name
Route/Component: `/reports`, `/api/reports/workflow-overview`, `getUnifiedWorkflowOverview`
Severity: high
Environment: production (Railway)
Discovered: iteration 7, post-deploy production recheck
Symptom: after fixing the first workflow-overview error, the endpoint still returned `500` with `column "psc.name" must appear in the GROUP BY clause`.
Root cause: the mirrored downstream summary grouped by `COALESCE(mirror_psc.name, psc.name)` but still selected `psc.name AS mirrored_stage_name`.
Fix: changed the select list to `COALESCE(mirror_psc.name, psc.name) AS mirrored_stage_name` and added a regression assertion to the report service test.
Deployed: `5e51ed5` + Railway API deploy `606bb965-feec-4d72-90ff-0eaa95948358` + 2026-04-24 15:00 CDT
Deploy status: SUCCESS
Verification: local `npx vitest run --config vitest.config.ts server/tests/modules/reports/service.test.ts server/tests/modules/reports/analytics-cycle.test.ts` and `npm run typecheck --workspace=server`; confirmed passing on prod via `/reports`
Status: fixed

Issue #12 — Data-mining untouched contacts can emit placeholder rows with missing ids
Route/Component: `/reports`, `/api/reports/data-mining`, `DataMiningSection`, `getDataMiningOverview`
Severity: medium
Environment: production (Railway)
Discovered: iteration 8, fresh post-deploy `/reports` browser verification
Symptom: the data-mining table renders a blank untouched-contact row and logs a React `Each child in a list should have a unique "key" prop` warning.
Root cause: malformed placeholder rows with null `contact_id` / `contact_name` were mapped straight through by the report service, and the table renderer trusted every row to have a stable key.
Fix: filter malformed untouched-contact and dormant-company rows in `getDataMiningOverview`, and defensively collapse invalid rows to the table empty state in `DataMiningSection`.
Deployed: `73345c4` + Railway API deploy `3f585d6b-96b1-43b1-9f2c-cb36a57a36f2` + Railway Frontend deploy `1d468986-4cfe-4280-be65-32701f323d78` + 2026-04-24 16:02 CDT
Deploy status: SUCCESS
Verification: local `npx vitest run --config vitest.config.ts server/tests/modules/reports/analytics-cycle.test.ts`, `npx vitest run --config vitest.config.ts client/src/components/reports/analytics-sections.test.tsx`, `npm run typecheck --workspace=server`, and `npm run typecheck --workspace=client`; confirmed passing on prod via `/reports` and `tests/audit/reports-director-admin.spec.ts`
Status: fixed

Issue #13 — Notification stream is blocked on the production frontend by cross-origin resource policy
Route/Component: topbar notification center, `/api/notifications/stream`, `useNotificationStream`, notification SSE route
Severity: medium
Environment: production (Railway)
Discovered: iteration 11, companies / properties production audit
Symptom: rep pages intermittently or consistently log notification stream failures during production Playwright runs, with the browser reporting the EventSource connection as blocked by cross-origin policy.
Root cause: the notification SSE route inherits Helmet's default `Cross-Origin-Resource-Policy: same-origin`, which blocks the cross-origin Railway frontend from consuming the credentialed EventSource stream even though CORS headers are otherwise present.
Fix: added abort-aware notification hook handling and regression tests on the client side, then added a server route regression test and overrode the SSE route to emit `Cross-Origin-Resource-Policy: cross-origin`.
Deployed: pending
Deploy status: pending
Verification: local `npx vitest run --config vitest.config.ts client/src/hooks/use-notifications.test.ts`, `npx vitest run --config vitest.config.ts server/tests/modules/notifications/routes.test.ts`, `npm run typecheck --workspace=client`, `npm run typecheck --workspace=server`, and post-deploy Playwright reruns pending
Status: in progress
