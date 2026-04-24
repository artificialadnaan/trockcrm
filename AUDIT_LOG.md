## Running Summary
- Iteration count: 1
- Total tests generated: 1
- Pass/fail count per iteration:
  - Iteration 1: in progress
- Issues fixed vs deferred:
  - Fixed: 0
  - Deferred: 0
- Deploy failures encountered and recovered: 0
- Last successful Railway deploy SHA + timestamp: pending this audit loop

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
Fix: in progress — adding canonical deal stage route, pipeline header navigation, filtered stage report UI, and matching API endpoint.
Deployed: pending
Deploy status: pending
Verification: pending
Status: in progress

Issue #2 — Legacy dashboard stage link contract
Route/Component: `DirectorDashboardPage`, `DealListPage`, deal filters
Severity: medium
Environment: production (Railway)
Discovered: iteration 1, code trace
Symptom: dashboard links still use `?stage=dd`, but current deal filters understand `stageIds`, not `stage`, so stage drilldowns do not apply a real filter contract.
Root cause: stale query-param contract left behind after the workflow refactor.
Fix: in progress — moving stage drilldowns onto the canonical `/deals/stages/:stageId` surface and removing reliance on `?stage=dd` for drilldown behavior.
Deployed: pending
Deploy status: pending
Verification: pending
Status: in progress

Issue #3 — API client fails noisily on HTML responses
Route/Component: `client/src/lib/api.ts`
Severity: medium
Environment: production (Railway)
Discovered: iteration 1, production screenshot + code trace
Symptom: `Unexpected token '<'` surfaced directly in the UI when HTML was returned where JSON was expected.
Root cause: `api()` blindly called `res.json()` without checking `content-type`.
Fix: in progress — added guarded JSON parsing with content-type validation and a more actionable error message.
Deployed: pending
Deploy status: pending
Verification: pending
Status: in progress
