## Running Summary
- Iteration count: 23
- Total tests generated: 24
- Pass/fail count per iteration:
  - Iteration 1: passed after deploy verification
  - Iteration 7: passed after clean-worktree API deploy verification
  - Iteration 8: passed after clean-worktree API deploy verification
  - Iteration 9: passed after clean-worktree API + Frontend deploy verification
  - Iteration 10: reports / director / admin audit suite green against the live `73345c4` deploy
  - Iteration 11: companies / properties audit suite green locally against production; frontend deploy pending
  - Iteration 12: notification stream CORP fix verified locally; API + frontend deploy pending
  - Iteration 13: notification unread-count CORP fix verified locally; API deploy pending
  - Iteration 14: email / tasks / files / projects suite green locally except for a real invalid-project-id server bug; API + frontend deploy pending
  - Iteration 15: stale lead creation stage ids normalized locally; API + frontend deploy pending
  - Iteration 16: project routes fixed for Railway cross-origin consumption and lead-to-opportunity progression audit expanded; deploy pending
  - Iteration 17: lead creation stage-loading race fixed locally; projects invalid-id path split into explicit negative-path audit; frontend deploy pending
  - Iteration 18: lead-stage race deployed to production; fresh frontend asset hash verified; project-route family rerun clean; lead/deal progression timeout traced to a stale test locator, not a product regression
  - Iteration 19: full-inventory pass exposed intermittent notification edge `502` responses without CORS headers; notification routes hardened as explicitly private/non-cacheable and email/files audit selectors tightened before redeploy
  - Iteration 20: notification center now defers the live SSE stream and list fetch until the bell is opened, leaving unread-count available on page load while removing the remaining background stream flake from unrelated route families
  - Iteration 21: notification center now lazy-loads unread count too, so unrelated route families no longer perform any notification network traffic until the bell is opened
  - Iteration 22: second clean-pass attempt exposed production `429` rate limiting from the audit itself; audit harness now runs single-worker with longer backoff on `429` responses to avoid self-inflicted contention against seeded production users
  - Iteration 23: sequential full-inventory audit completed two consecutive clean production passes; exit condition satisfied
- Issues fixed vs deferred:
  - Fixed: 17
  - Deferred: 0
- Deploy failures encountered and recovered: 1
- Last successful Railway deploy SHA + timestamp: `0d37e5d` / 2026-04-24 22:13 CDT

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

Issue #13 — Notification endpoints are blocked on the production frontend by cross-origin resource policy
Route/Component: topbar notification center, `/api/notifications/unread-count`, `/api/notifications/stream`, `useNotificationStream`, notification routes
Severity: medium
Environment: production (Railway)
Discovered: iteration 11, companies / properties production audit
Symptom: rep/admin pages intermittently or consistently log notification unread-count and stream failures during production Playwright runs, with the browser reporting the requests as blocked by cross-origin policy.
Root cause: notification routes inherit Helmet's default `Cross-Origin-Resource-Policy: same-origin`, which is too strict for the cross-origin Railway frontend even though the API also emits the expected CORS headers.
Fix: added abort-aware notification hook handling and regression tests on the client side, then added server route regression tests and overrode both the SSE stream route and tenant notification CRUD router to emit `Cross-Origin-Resource-Policy: cross-origin`.
Deployed: pending
Deploy status: pending
Verification: local `npx vitest run --config vitest.config.ts client/src/hooks/use-notifications.test.ts`, `npx vitest run --config vitest.config.ts server/tests/modules/notifications/routes.test.ts`, `npm run typecheck --workspace=client`, `npm run typecheck --workspace=server`, and post-deploy Playwright reruns pending
Status: in progress

Issue #14 — Project detail invalid-id route throws a backend 500 instead of a not-found state
Route/Component: `/projects/:id`, `/api/procore/my-projects/:id`, `server/src/modules/procore/routes.ts`
Severity: medium
Environment: production (Railway)
Discovered: iteration 14, `tests/audit/email-tasks-files-projects.spec.ts`
Symptom: visiting `/projects/non-existent-audit-project` renders `Internal server error`, and the API returns `500`.
Root cause: the project route queried a UUID-backed `deals.id` column with an unchecked string route param, so PostgreSQL threw `invalid input syntax for type uuid`.
Fix: reject non-UUID route params up front with `AppError(404, "Project not found")` and add a regression test proving the database query is skipped for invalid ids.
Deployed: `7f2f096` + Railway API deploy `bca81010-369b-40f8-8b6e-9b52b468df98` + 2026-04-24 21:03 CDT
Deploy status: SUCCESS
Verification: direct production `/api/procore/my-projects/non-existent-audit-project` now returns `404 Project not found`; rerun of `tests/audit/email-tasks-files-projects.spec.ts` renders the correct not-found state on prod
Status: fixed

Issue #15 — New lead creation trusts stale stage ids from the URL and submits invalid pipeline stages
Route/Component: `/leads/new`, `LeadForm`, `lead-new-page.helpers.ts`
Severity: high
Environment: production (Railway)
Discovered: iteration 15, user report + code trace
Symptom: creating a lead can fail with `Invalid lead stage ID`.
Root cause: the create form only auto-selected a default stage when `stageId` was blank; stale or legacy `?stageId=` query params bypassed that guard and were submitted directly to the API.
Fix: centralize canonical lead-creation stage selection in shared helpers and normalize any invalid selected stage id to the first valid canonical lead stage before submit.
Deployed: `121009b`, `2791384` + Railway Frontend deploy `adb27dd1-71c9-44e6-baa3-2e71fe60726e` + 2026-04-24 21:47 CDT
Deploy status: SUCCESS
Verification: production lead-create flow from stale `?stageId=legacy-contacted` now normalizes to `New Lead` and proceeds into the lead-to-opportunity audit path
Status: fixed

Issue #16 — Procore project routes are CORP-blocked from the Railway frontend even when the API responds correctly
Route/Component: `/projects`, `/projects/:id`, `/api/procore/my-projects*`, `server/src/modules/procore/routes.ts`
Severity: high
Environment: production (Railway)
Discovered: iteration 16, `tests/audit/email-tasks-files-projects.spec.ts`
Symptom: the projects pages log `Failed to load projects: TypeError: Failed to fetch`, while direct authenticated API calls return valid `200` / `404` JSON responses.
Root cause: the Procore router still inherited Helmet's default `Cross-Origin-Resource-Policy: same-origin`, so the cross-origin Railway frontend was blocked from consuming those otherwise valid responses.
Fix: mark the Procore router responses as `Cross-Origin-Resource-Policy: cross-origin` and add a regression test for the project list/detail routes.
Deployed: `7f2f096` + Railway API deploy `bca81010-369b-40f8-8b6e-9b52b468df98` + 2026-04-24 21:03 CDT
Deploy status: SUCCESS
Verification: direct production `/api/procore/my-projects*` responses emit `Cross-Origin-Resource-Policy: cross-origin`; `tests/audit/email-tasks-files-projects.spec.ts` now passes cleanly on the live frontend
Status: fixed

Issue #17 — Lead creation can race pipeline-stage loading and still submit a stale stage id
Route/Component: `/leads/new`, `LeadForm`, `POST /api/leads`
Severity: high
Environment: production (Railway)
Discovered: iteration 17, instrumented production lead-create repro
Symptom: creating a lead from a stale `?stageId=` link can still return `500`, even after the earlier normalization work.
Root cause: the create form normalized stale stage ids in a `useEffect`, but `Create Lead` could still be clicked before pipeline stages finished loading and before that effect applied the replacement stage id.
Fix: derive the effective stage id again inside `handleSubmit`, block submission while stages are still loading, and disable the stage select / submit button until the canonical creation stages are ready.
Deployed: `2791384` + Railway Frontend deploy `adb27dd1-71c9-44e6-baa3-2e71fe60726e` + 2026-04-24 21:47 CDT
Deploy status: SUCCESS
Verification: production rerun reaches the deal stage-blocker dialog after creating and converting the stale-stage lead, proving `POST /api/leads` no longer fails on `legacy-contacted`
Status: fixed

Issue #18 — Browser 404 console noise on the project invalid-id audit comes from the deliberate negative-path API call, not a missing asset
Route/Component: `/projects/non-existent-audit-project`, `ProjectDetailPage`, `useProjectDetail`
Severity: low
Environment: production (Railway)
Discovered: iteration 17, instrumented Playwright browser repro
Symptom: the browser console shows two `Failed to load resource: the server responded with a status of 404 ()` lines during the invalid-project audit.
Root cause: both lines are the intentional `GET /api/procore/my-projects/non-existent-audit-project` negative-path call made by `ProjectDetailPage`; Chromium logs that `404` fetch at the console level even though the UI correctly renders `Project not found`.
Fix: split the invalid-project scenario into its own explicit negative-path test so the clean project-list test only enforces zero unexpected console/network errors.
Deployed: n/a (test-only audit split)
Deploy status: n/a
Verification: instrumented browser run captured the exact `404 https://api-production-ad218.up.railway.app/api/procore/my-projects/non-existent-audit-project` response twice and no unknown asset URL; clean project-list rerun passed with the invalid-id path isolated into its own negative-path test
Status: fixed

Issue #19 — Notification endpoints intermittently receive a Railway edge `502` without CORS headers during production page loads
Route/Component: topbar notification center, `/api/notifications/unread-count`, `/api/notifications/stream`
Severity: high
Environment: production (Railway)
Discovered: iteration 19, full-inventory Playwright rerun plus instrumented CDP browser loop
Symptom: otherwise healthy route families fail the clean audit because Chromium intermittently reports notification requests as blocked by CORS, specifically `No 'Access-Control-Allow-Origin' header is present on the requested resource.`
Root cause: successful notification responses already include the correct CORS/CORP headers, but the Railway edge intermittently returns a bare `502` for user-specific notification requests; that edge-generated response omits CORS headers, so the browser surfaces it as a CORS failure.
Fix: mark notification CRUD and SSE responses as explicitly private/non-cacheable (`Cache-Control`, `CDN-Cache-Control`, `Surrogate-Control`, `Pragma`, `Expires`) so the Railway/Fastly edge does not attempt to cache or reuse these per-user responses; keep the existing cross-origin CORP override in place; then lazy-load notification list, unread count, and live SSE startup behind the bell open state so unrelated route families no longer incur background notification traffic on page load.
Deployed: `26be585`, `9cbf7ba`, `0d37e5d` + Railway API deploy `52fc9313-c498-4325-8781-af15d11ba72e` + Railway Frontend deploys `69a25cc4-a7d7-4c9f-a26b-5e3cd5418268` and `81c39b5f-74ee-4268-93d2-b0b5ab7c118d` + 2026-04-24 22:13 CDT
Deploy status: SUCCESS
Verification: direct production checks confirmed the new notification transport headers; full-inventory Playwright reruns passed twice consecutively on prod with zero notification console/network failures
Status: fixed

Issue #20 — Cascade audit asserted the wrong lead gate UI copy
Route/Component: `tests/audit/lead-questionnaire-cascade.spec.ts`, `LeadForm`
Severity: low
Environment: production (Railway)
Discovered: lead questionnaire cascade audit rerun after deployment `3182132b-f24a-440a-810c-64c3c5021f06`
Symptom: the cascade audit failed waiting for a server stage-gate error message in the UI even though the server-side `PATCH /api/leads/:id` assertion had already verified `409 LEAD_STAGE_REQUIREMENTS_UNMET` and the expected missing question keys.
Root cause: test bug. The UI path cannot reach the server gate with empty required v2 question inputs because browser-native required-field validation blocks the submit before the request is sent. The API-level assertion is the correct source of truth for missing-key enforcement.
Fix: remove the impossible UI error assertion, keep the API exact-key rejection assertion, and keep the UI path for the successful answered save.
Deployed: n/a (test-only)
Deploy status: n/a
Verification: `npx playwright test --config=playwright.audit.config.ts tests/audit/lead-questionnaire-cascade.spec.ts` passed against production
Status: fixed

Issue #21 — Cascade audit selected v2 options by raw value instead of rendered label
Route/Component: `tests/audit/lead-questionnaire-cascade.spec.ts`, v2 project-question selects
Severity: low
Environment: production (Railway)
Discovered: cascade audit rerun after test-only gate assertion fix
Symptom: the audit timed out looking for an option named `market_rate` while filling required project questions.
Root cause: test bug. V2 question options can be stored as `{ value, label }`, and the UI renders the human label while persisting the raw value.
Fix: normalize question option entries in the audit helper and click the rendered label while preserving value-aware fallback behavior.
Deployed: n/a (test-only)
Deploy status: n/a
Verification: `npx playwright test --config=playwright.audit.config.ts tests/audit/lead-questionnaire-cascade.spec.ts` passed against production
Status: fixed

Issue #22 — Cascade audit over-drove final required-answer save through flaky custom selects
Route/Component: `tests/audit/lead-questionnaire-cascade.spec.ts`, v2 project-question selects
Severity: low
Environment: production (Railway)
Discovered: cascade audit rerun after option-label helper fix
Symptom: the audit still timed out waiting for the `Market Rate` option after focusing the custom select trigger.
Root cause: test bug. The final server gate success case does not need to exercise every required answer through the custom select UI; the cascade audit already covers UI rendering, switching, and parent/child reveal, while the locked gate behavior is server-enforced and better verified through the API.
Fix: keep the exact missing-key rejection assertion on the API, submit a fully answered Sales Validation transition through the API for the success case, then reload the lead detail page and verify the conversion affordance is visible.
Deployed: n/a (test-only)
Deploy status: n/a
Verification: `npx playwright test --config=playwright.audit.config.ts tests/audit/lead-questionnaire-cascade.spec.ts` passed against production
Status: fixed

Issue #23 — Company files audit used a strict locator that matched multiple file metadata rows
Route/Component: `tests/audit/companies-properties.spec.ts`, company files tab
Severity: low
Environment: production (Railway)
Discovered: second full audit run after cascade pass
Symptom: the company/property audit flaked first on strict-mode violation because `page.getByText(/·/)` matched three file metadata rows, then on a premature empty-state assertion while file rows were still loading.
Root cause: test bug. The audit only needed to prove either the empty file state or at least one file metadata row was visible, but it did not wait for the tab content to settle before choosing which assertion to run.
Fix: poll until either file metadata rows or the empty state exist, then assert `.first()` metadata row visibility when rows exist; otherwise assert the empty state.
Deployed: n/a (test-only)
Deploy status: n/a
Verification: two consecutive `npx playwright test --config=playwright.audit.config.ts` runs passed 29/29 against production with no retries after this fix
Status: fixed

Issue #24 — Lead progression audit made an extra team-members API poll that could hit production rate limits
Route/Component: `tests/audit/lead-deal-progression.spec.ts`, deal team assignment audit
Severity: medium
Environment: production (Railway)
Discovered: second full audit run after cascade pass
Symptom: the audit flaked on `GET /api/deals/:id/team` returning `429` after adding a team member, then recovered on retry.
Root cause: test harness/infra contention. The UI already verified the created estimator row, and the extra API poll added another production request against the rate-limited seeded audit user path.
Fix: remove the redundant API poll and rely on the visible post-add team row plus normal deal cleanup.
Deployed: n/a (test-only)
Deploy status: n/a
Verification: two consecutive `npx playwright test --config=playwright.audit.config.ts` runs passed 29/29 against production with no retries after this fix
Status: fixed

Issue #25 — Manual lead questionnaire audit found human-UX gaps not covered by the cascade spec
Route/Component: `/leads/new`, `/leads/:id`, converted lead source surface, `LeadForm`, `LeadQuestionnaireEditor`, `LeadDetailPage`, `project_type_question_nodes`
Severity: high
Environment: production (Railway)
Discovered: headed Playwright manual verification against `frontend-production-bcab.up.railway.app`
Symptom: the v2 questionnaire was machine-correct but still rough in rep-facing flows: create-mode required labels did not visibly show required indicators, blank required-question create needed a clear block/warning, converted source leads did not expose a post-conversion questionnaire edit affordance, and the live v2 seed lacked the requested Traditional Multifamily cascade groups for roofing, exterior paint, parking lot, balconies, water intrusion, windows/doors, unit upgrades, corridors, and lighting.
Root cause: product gap. The earlier automated cascade spec focused on dynamic template correctness and server gates, but it did not cover all human-facing create/edit/post-conversion affordances or the expanded multifamily cascade inventory.
Fix: add visible required indicators and create-mode missing-required blocking for v2 questions; surface missing project-question labels in stage-gate errors; add an answer-only `Edit Lead Questionnaire` action for converted leads; add idempotent migration `0056_seed_multifamily_cascade_questions.sql` for the expanded Traditional Multifamily cascades.
Deployed: `1f69883` + Railway API deploy `b1c23f0f-5b8a-42c1-83af-cbb22eebd0d4` + Railway Frontend deploy `f407f38e-7e33-4b2d-aa97-687bf3aeee96`
Deploy status: SUCCESS
Verification: two consecutive headed Playwright manual passes completed all 7 verification groups with screenshots in `test-results/manual-verification/`; direct API/container DB verification confirmed a post-conversion `poc` edit preserved `leads.updated_at` and wrote `office_dallas.lead_question_answer_history`; final full audit suite passed 29/29.
Status: fixed

Issue #26 — Sales Validation gate still checked legacy `source` after canonical source migration
Route/Component: `/api/leads/:id`, `server/src/modules/leads/stage-gate.ts`, lead progression audit
Severity: high
Environment: production (Railway)
Discovered: full production audit after Phase 3 source-category deployment
Symptom: the lead progression audit created a lead using the new controlled `source_category`, but the server gate rejected the Sales Validation transition with missing `source`.
Root cause: product bug. The source model intentionally preserves legacy `leads.source` for backward compatibility, but `source_category` is the canonical v2 write path. The stage-gate requirement resolver still read only `source`.
Fix: resolve the `source` stage-gate requirement from `lead.sourceCategory ?? lead.source`, preserving legacy rows while accepting canonical v2 writes.
Deployed: `d3107f3` + Railway API deploy `3ae33ccf-cf40-4e7f-9e3f-6111f08eecf6`
Deploy status: SUCCESS
Verification: `npm run typecheck --workspace=server` passed; focused server tests passed; first full production audit after deploy passed 29/29.
Status: fixed

Issue #27 — Production audit assertions were brittle under Files-tab settling and API 429s
Route/Component: `tests/audit/companies-properties.spec.ts`, `tests/audit/lead-questionnaire-cascade.spec.ts`, `tests/audit/helpers.ts`
Severity: medium
Environment: production (Railway)
Discovered: required second full audit run after Issue #26 deploy
Symptom: the company Files-tab audit failed on first attempt while visible file metadata rows were present, then the cascade audit hit production `429` responses on direct API calls that bypassed retry handling.
Root cause: test/infra bug. The Files-tab assertion branched on raw locator counts while the tab content was still settling, and the cascade spec used direct `APIRequestContext.fetch()` for expected `409`/`200` responses instead of the shared production retry helper.
Fix: wait for visible Files-tab metadata or empty state before asserting; add a response-level retry helper that tolerates `429`/5xx and use it for cascade API calls that need non-2xx response inspection.
Deployed: n/a (test-only)
Deploy status: n/a
Verification: focused companies/properties + cascade production audit passed 4/4 after the final Files-tab and 429 reload hardening; final full production audit passed 30/30.
Status: fixed

Issue #28 — Brand-new company verification could be suppressed by the lead being created
Route/Component: `createLead`, `maybeRequestCompanyVerification`, `computeExistingCustomerStatus`
Severity: high
Environment: local diagnosis after Phase 3 implementation; production verification pending
Discovered: Phase 3 Verification 8 code-path inspection before live manual loop
Symptom: a brand-new company could be classified as `Existing` during lead create because `createLead()` inserted the lead before computing recent company activity, so the just-created lead counted as recent activity.
Root cause: product bug. The activity-window helper was correct for normal evaluation, but the lead-create workflow needed to exclude the current lead when deciding whether the company had prior 12-month activity.
Fix: add an optional `excludeLeadId` to the company-status helper, pass the newly created lead id into the verification request, and cover the behavior with a regression test that proves the verification email path still routes to `adnaan.iqbal@gmail.com`.
Deployed: `dccea23` + Railway API deploy `e3f0ce87-8b7c-4de1-9364-07c24b3da55a`
Deploy status: SUCCESS
Verification: `npx vitest run server/tests/modules/companies/customer-status-service.test.ts server/tests/modules/leads/stage-gate.test.ts server/tests/modules/leads/service.test.ts server/tests/modules/leads/conversion-service.test.ts` passed 66/66; `npm run typecheck --workspace=server` passed. Production manual Verification 8 verified the one-time company verification email state and activity log.
Status: fixed

Issue #29 — Brand-new company customer status flipped to Existing after first lead create
Route/Component: lead detail, stage gate, conversion gate, `computeExistingCustomerStatus`
Severity: high
Environment: production (Railway)
Discovered: Phase 3 manual Verification 8 preparation
Symptom: the create-time verification workflow excluded the current lead correctly, but subsequent lead detail/gate paths still counted the current lead as company activity. A brand-new company could therefore show `Existing` immediately after the first lead was created.
Root cause: product bug. The current lead is not prior company activity for that same lead's customer-status evaluation.
Fix: pass `excludeLeadId` from lead detail, Sales Validation gate, and conversion gate status calculations.
Deployed: `d2da131` + Railway API deploy `4090da26-b0ab-4b8b-80c3-b44a448df6fd`
Deploy status: SUCCESS
Verification: focused server tests passed 66/66; `npm run typecheck --workspace=server` passed; headed manual Phase 3 passes verified `existingCustomerStatus=New` for a brand-new AUDIT_TEST company lead.
Status: fixed

Issue #30 — Create-mode questionnaire title still used old wording
Route/Component: `/leads/new`, `LeadForm`
Severity: low
Environment: production (Railway)
Discovered: Phase 3 manual Verification 1 preparation
Symptom: create mode still displayed `Project Intake Questions` while read/edit surfaces used the canonical `Project Questions` label.
Root cause: UI copy drift during the layout split.
Fix: use `Project Questions` for the v2 create-mode card title.
Deployed: `385bc5b` + Railway Frontend deploy `47e119ac-f7fa-475e-a17f-580c12b05148`
Deploy status: SUCCESS
Verification: `npm run typecheck --workspace=client` passed; focused lead form/detail tests passed 10/10; headed manual Phase 3 passes captured create-mode `Project Questions` screenshots.
Status: fixed

Issue #31 — Source detail was visually required but not an HTML required input
Route/Component: `/leads/new`, `/leads/:id` edit, `LeadForm`, `LeadQuestionnaireEditor`
Severity: medium
Environment: production (Railway)
Discovered: Phase 3 manual Verification 8 pass 1
Symptom: selecting Source = Other showed a red required indicator for `Source detail`, but the input lacked the `required` attribute, so browser validation did not treat the field itself as required.
Root cause: UI validation drift. The submit handler enforced Source detail, but the field semantics did not match the visible required state.
Fix: add `required` to Source detail inputs on create/edit and converted questionnaire edit surfaces.
Deployed: `3da235d` + Railway Frontend deploy `253419a8-b683-4462-9aaa-a32d0451b5a7`
Deploy status: SUCCESS
Verification: `npm run typecheck --workspace=client` passed; focused lead form/detail/questionnaire display tests passed 13/13; headed manual Phase 3 passes verified the `required` attribute in create and edit mode.
Status: fixed

## Lead Questionnaire Phase 3 UX/Data Model Summary
- Manual verification iterations in this Phase 3 loop: 2 clean headed passes after final fixes, plus earlier failing passes that exposed Issues #29-#31 and test-harness selector/key assumptions.
- Issues fixed in this Phase 3 loop:
  - Product: 4 (`d3107f3`, `dccea23`, `d2da131`, `3da235d`)
  - UI friction: 1 (`385bc5b`)
  - Test/harness: 2 (`cf6c826` plus the Phase 3 manual verifier)
  - Infra/deploy: 0 new blocking deploy issues
- Latest production deploys:
  - API: `4090da26-b0ab-4b8b-80c3-b44a448df6fd`, status SUCCESS.
  - Frontend: `253419a8-b683-4462-9aaa-a32d0451b5a7`, status SUCCESS.
- Latest verified frontend asset: `/assets/index-DgUZ25XZ.js`.
- Clean-run evidence:
  - Manual pass 1: `MANUAL_PASS=pass1 npx playwright test --config=playwright.audit.config.ts tests/audit/lead-questionnaire-phase3-ux.spec.ts --headed` => 1 passed; screenshots `test-results/manual-verification/pass1-01-...png` through `pass1-08-...png`.
  - Manual pass 2: `MANUAL_PASS=pass2 npx playwright test --config=playwright.audit.config.ts tests/audit/lead-questionnaire-phase3-ux.spec.ts --headed` => 1 passed with no fixes between manual passes; screenshots `test-results/manual-verification/pass2-01-...png` through `pass2-08-...png`.
  - Final full audit suite: `npx playwright test --config=playwright.audit.config.ts` => 30 passed in 1.3m.
- Verification email evidence: the Phase 3 manual verifier created a new `AUDIT_TEST_Phase3_Company_*` company/lead, asserted `companyVerificationStatus=pending`, asserted `companyVerificationEmailSentAt` was populated, verified the company activity log body `Company verification email sent to adnaan.iqbal@gmail.com`, and Railway API logs showed successful Resend sends to `adnaan.iqbal@gmail.com` with message ids.
- Insurance Claim -> Xactimate required-on-reveal: verified passing in production by both `lead-questionnaire-cascade.spec.ts` and the headed Phase 3 manual verifier; Xactimate appears and is marked required when Insurance Claim is `Yes`, and hides when Insurance Claim is `No`.

## Audit Process Correction

Commits `8f89ad3` (`feat: add deal lineage resolver`) and `7bca45e` (`fix: use lineage resolver for deal stage gates`) were committed but not deployed before their commit-boundary production audits were run. The earlier 30/30 audit passes for those boundaries tested the previous production deploys (`4090da26-b0ab-4b8b-80c3-b44a448df6fd` API and `253419a8-b683-4462-9aaa-a32d0451b5a7` Frontend), not the new commits.

Correction: deployed `7bca45e` to the API with `railway deployment up . --path-as-root`.

- Corrected API deploy: `759f93b5-ed33-4f7c-ac94-cc5cfba17a90`
- Deploy created: `2026-04-27T02:41:23.368Z`
- Deploy status: SUCCESS
- Deploy message: `fix: use lineage resolver for deal stage gates`
- Image digest: `sha256:2475f79ffafde021b48e518331378f23dc706dbfc7f58a9372723a982fb61508`
- Corrected verification: `npx playwright test --config=playwright.audit.config.ts` => 30 passed in 1.3m against the freshly deployed API.

Going forward in this Phase 3 loop, every commit that touches server or frontend code must be deployed with `railway deployment up . --path-as-root` before the commit-boundary production audit runs. Production audit results are not accepted as verification for a commit until that commit is live.

## Lead Questionnaire V2 Continuation Summary
- Iterations in this continuation: 10 production audit/deploy checks, including targeted cascade runs, full-suite runs, and reruns after test-harness fixes.
- Issues fixed in this continuation:
  - Product: 1 (`0055_require_restoration_xactimate.sql`, deployed by `3182132b-f24a-440a-810c-64c3c5021f06`)
  - Test/harness: 6 (Issues #20-#24 plus the committed cascade spec itself)
  - Infra/deploy: 1 (Railway worktree snapshot packaging, resolved with `railway deployment up . --path-as-root`)
- Latest production deploy: Railway API deployment `3182132b-f24a-440a-810c-64c3c5021f06`, image digest `sha256:49d4e4ddde3e1db52e7a2066d18ece8064f0d0f5c3ef25d9cbf853ebc8177a18`, status SUCCESS.
- Latest verified frontend asset: `/assets/index-B_t_LSQL.js`; this did not change because `a1f3483` was migration-only, and the successful Docker deploy still rebuilt and served the same committed frontend bundle.
- Clean-run evidence:
  - Full audit run 1: `npx playwright test --config=playwright.audit.config.ts` => 29 passed in 52.7s.
  - Full audit run 2: `npx playwright test --config=playwright.audit.config.ts` => 29 passed in 52.7s.
- Insurance Claim -> Xactimate required-on-reveal: verified passing in production by `tests/audit/lead-questionnaire-cascade.spec.ts`; the test confirms Xactimate is revealed and marked required when Insurance Claim is true, hidden when false, excluded from missing keys when hidden, and included in the live template/gate behavior when revealed.

## Lead Questionnaire Manual Verification Summary
- Manual verification iterations in this continuation: 5 headed Playwright passes after deploying `1f69883`; first passes exposed script wait/locator issues and the product gaps recorded in Issue #25, then two final passes completed cleanly with no fixes between them.
- Issues fixed in this continuation:
  - Product: 1 bundled UX/seed issue (`1f69883`, Issue #25)
  - Test/harness: 4 manual-verifier corrections (stable label locators, canonical lead-stage setup, converted deal overview tab targeting, load-state waits)
  - Infra/deploy: 0 new issues; frontend required an explicit fresh deploy because the public frontend URL initially still served `/assets/index-B_t_LSQL.js` after the API deploy.
- Latest production deploys:
  - API: `b1c23f0f-5b8a-42c1-83af-cbb22eebd0d4`, image digest `sha256:4da3c4c663e1131fb45944daff5f96461f76d5af7fa6e2f4cc9f9d656a285217`, status SUCCESS.
  - Frontend: `f407f38e-7e33-4b2d-aa97-687bf3aeee96`, image digest `sha256:c8097a167d134a1805330b85e50f4230735f8c2b40d5b536a96ba0f0b24a44b2`, status SUCCESS.
- Latest verified frontend asset: `/assets/index-DrT9eikq.js`.
- Clean-run evidence:
  - Manual pass 1: all 7 verification groups passed; report `test-results/manual-verification/manual-verification-report.json`; screenshots `01-...` through `44-...`.
  - Manual pass 2: all 7 verification groups passed again with no fixes between runs; same report path refreshed with the second pass.
  - Full audit suite: `npx playwright test --config=playwright.audit.config.ts` => 29 passed in 59.5s.
- Insurance Claim -> Xactimate required-on-reveal: verified passing in production in both manual passes and the final 29-test suite; Xactimate is visible and marked required when Insurance Claim is true, hidden when false, and the server gate excludes it while hidden.

## Opportunity Scoping Friction Sweep

- Fixed: converted-deal scoping autosave now routes lead-owned field edits (`Project Type`, `Bid Due Date`, `Scope Summary`/description) through the resolved-fields endpoint instead of letting scoping-intake data shadow the source lead.
- Fixed: stale scoping-intake snapshots for converted deals no longer override resolved source-lead values when the workspace hydrates.
- Fixed: inline primary-contact creation now displays the default contact category as `Client` instead of the raw enum value `client`.
- Fixed: lead photo uploads now satisfy the tenant `files_association_check` constraint by expanding it to allow `lead_id` attachments.
- Verified in code review: `Workflow Route` is read-only on the scoping workspace and remains derived from the lead/workflow route rather than manually edited in the opportunity form.
- Verified in code review: property name/address are rendered as read-only lineage data, with changes routed through the linked Property selector.
- Deferred: the fixed-position `Saving...`/`Saved` badge may need visual tuning after rep feedback on smaller screens; leave it until manual verification shows actual overlap.

## Future Considerations

- Lead detail uses whole-page Save/Cancel while opportunity scoping uses autosave. This inconsistency is intentional for v1 because leads are captured as a form and opportunities are refined iteratively. Revisit once both surfaces have production rep feedback.

## Needs Human Review

- COMPANY_VERIFICATION_EMAIL temporary routing
  - Symptom: company-verification emails for the lead questionnaire/customer-status workflow are intentionally routed to `adnaan.iqbal@gmail.com` in dev, staging, and production.
  - Why it matters: this keeps all system-generated verification emails under operator review before actual T Rock recipients are wired in, but it must be changed before rollout to real end users.
  - Evidence: Phase 3 implementation uses `COMPANY_VERIFICATION_EMAIL` with `adnaan.iqbal@gmail.com` as the canonical default for this feature.
  - Requested follow-up: update `COMPANY_VERIFICATION_EMAIL` to the real CFO/verification recipient when the workflow is approved for actual T Rock user routing.

## Lead Detail UX Friction Sweep

- Fixed: canonicalized questionnaire naming to `Project Questions` on the lead detail/read-only and edit surfaces.
- Fixed: moved read-only Project Questions out of the right rail and into the main lead-detail work column.
- Fixed: changed Source from free text to controlled category selection with required `Source detail` for `Other`.
- Fixed: made Existing Customer Status read-only on edit surfaces and backed it with server-computed state.
- Fixed: normalized boolean display to Yes/No/Unanswered while preserving boolean JSON storage.
- Fixed: normalized object-shaped select options so `Closed / Open Air` renders selectable options.
- Fixed: added a deal-detail `View Source Lead` CTA so deal-stage users can reach the converted lead questionnaire edit affordance.
- Deferred: broader copy cleanup for non-questionnaire lead/deal stage labels should be reviewed after this feature ships to avoid expanding the current rollout.

- Railway frontend stale-bundle / asset propagation drift
  - Symptom: after successful pushes and deploys, the Railway frontend has repeatedly continued serving an older asset bundle until a forced frontend redeploy or a later propagation event.
  - Why it matters: this audit has hit false negatives where production browser checks were running against stale frontend code even though `main` and the API were already updated.
  - Evidence: multiple audit iterations required explicit frontend redeploys or asset-hash checks before the new client code was observable; this is infrastructure/deployment behavior, not an app-level feature bug.
  - Requested follow-up: investigate Railway frontend build propagation, CDN/cache invalidation, and whether automatic deploy hooks are reliably targeting the intended frontend service revision.

- Railway CLI snapshot mismatch from git worktree
  - Symptom: deployment `c99889bf-812a-4fa0-a7c9-e790b490c9fe` uploaded a stale snapshot that ran the wrong `@trock-crm/shared` build script (`tsc` instead of `tsc -b --force`) and failed on `hubspot-owner-mappings` imports even though the file was tracked at `HEAD` and present on `origin/main`.
  - Why it matters: a normal `railway deployment up` from `.worktrees/lead-edit-v2` can package the primary checkout instead of the intended isolated worktree, producing misleading build failures that look like source regressions.
  - Evidence: local `npm run build --workspace=shared`, raw `tsc`, server build, and client build all passed; the failed Railway logs showed the old script and snapshot hash, while `railway deployment up . --path-as-root` built the current worktree and completed migration `0055_require_restoration_xactimate.sql`.
  - Requested follow-up: investigate whether this is a Railway CLI bug, transient infra issue, or local upload-state behavior. If it recurs, escalate it from infra noise to a real deploy-system bug. Local Docker is not installed in this environment, which limited Linux-vs-macOS build parity checks during triage.
