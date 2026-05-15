# Permission Expansion Rebuild Discovery

Date: 2026-05-15
Branch: `fix/permission-expansion-rebuild`
Base: `origin/main` at `075c358d`

## Assumption

Bug #23 on current `origin/main` means:

- add Excel export only to the report pages a user can already access
- keep every existing report page role gate exactly as-is
- keep every existing report API role gate exactly as-is
- do not add broader report-data visibility for reps

Current shipped code has CSV/PDF-style helpers but no shared Excel export endpoint or button on `main`. A stale local worktree from the killed session contains a client-side Excel export implementation. For this rebuild, Bug #23 is scoped to restoring that client-side export surface without changing report authorization.

## Bug #10 - Recording uploads gated to admins

Server gates found:

- `server/src/modules/call-recordings/routes.ts:22-26`
  - `requireAdminRole()` throws `403` for any non-admin.
- `server/src/modules/call-recordings/routes.ts:52-78`
  - `POST /call-recordings/upload-url` calls `requireAdminRole(req.user!.role)`.
- `server/src/modules/call-recordings/routes.ts:80-94`
  - `POST /call-recordings/:id/confirm` also calls `requireAdminRole(req.user!.role)`.

Client gates found:

- `client/src/components/call-recordings/recording-list.tsx:57-58`
  - `const isAdmin = user?.role === "admin"`.
- `client/src/components/call-recordings/recording-list.tsx:187-192`
  - Upload button only renders for admins.

Adjacent gates to preserve:

- `server/src/modules/call-recordings/routes.ts:28-32`
  - `requireCallRecordingRole()` still blocks `field_contractor`.
- `server/src/modules/call-recordings/routes.ts:118-142`
  - playback/transcript routes use `requireCallRecordingRole`, not `requireAdminRole`.
- `server/src/modules/call-recordings/routes.ts:144-157`
  - delete remains admin-only and is out of scope.
- `client/src/components/call-recordings/recording-list.tsx:216+`
  - delete button is also admin-only and should stay that way.

## Bug #11 - Deal emails scoped per-user instead of team-visible

Deal email route:

- `server/src/modules/email/routes.ts:124-147`
  - `GET /api/email/deal/:dealId` verifies deal access, then calls `getEmails(req.tenantDb!, filters, req.user!.id, req.user!.role)`.

Server-side user scoping found:

- `server/src/modules/email/service.ts:1031-1046`
  - `getEmails()` adds `eq(emails.userId, userId)` for reps before applying `dealId` / `leadId` / `contactId` filters.
- `server/src/modules/email/service.ts:1048-1059`
  - deal email fetch includes deal-linked messages plus lead-linked messages for `sourceLeadId`, but still after the rep user filter above.
- `server/src/modules/email/service.ts:1128-1141`
  - `getEmailThread()` also scopes rep thread reads by `emails.userId`. This is likely relevant for deal-linked thread drill-in.

Personal inbox path to preserve:

- `server/src/modules/email/routes.ts:105-122`
  - `GET /api/email` uses `getUserEmails(req.tenantDb!, req.user!.id, filters)`.
- `server/src/modules/email/service.ts:1195+`
  - `getUserEmails()` is explicitly current-user scoped and should remain that way.

Client-side deal email surface:

- `client/src/components/email/deal-email-tab.tsx:20-25`
  - Uses `useDealEmails(dealId, ...)`.
- No extra client-side current-user filter found in `deal-email-tab.tsx`.

## Bug #12 - Sales reps can only assign tasks to themselves

Server gates found:

- `server/src/modules/tasks/routes.ts:24-52`
  - `GET /tasks/assignees` returns only the current rep for `req.user!.role === "rep"`.
- `server/src/modules/tasks/routes.ts:100-130`
  - `POST /tasks` forces reps to `assignedTo = req.user!.id`.
- `server/src/modules/tasks/routes.ts:164-176`
  - `PATCH /tasks/:id` strips `assignedTo` for reps.

Client gates found:

- `client/src/components/tasks/task-create-dialog.tsx:63`
  - `canAssign` only for admin/director.
- `client/src/components/tasks/task-create-dialog.tsx:66-72`
  - assignee list is only fetched when `canAssign`.
- `client/src/components/tasks/task-create-dialog.tsx:109-118`
  - `assignedTo` only sent when `canAssign`.
- `client/src/components/tasks/task-create-dialog.tsx:185-200`
  - assignee dropdown only renders when `canAssign`.

Related project-task surface:

- `client/src/components/projects/project-tasks-tab.tsx:41-42`
  - `canManage` only admin/director.
- `client/src/components/projects/project-tasks-tab.tsx:71-76`
  - reps do not get the project-scoped task create action at all.

Likely adjacent gate to keep:

- `server/src/modules/tasks/service.ts:533-539`
  - reps can only view their own tasks via `getTaskById()`. That is a different visibility rule than assignment and should not be changed unless tests prove the create/edit flow requires it.

## Bug #23 - Excel export should match the parent report gate

Current `origin/main` findings:

- `client/src/App.tsx:234-284`
  - current report page gates:
    - `/reports/sales/pipeline-velocity` - no route wrapper in `App.tsx`
    - `/reports/sales/closed-won-revenue` - no route wrapper in `App.tsx`
    - `/reports/sales/lead-conversion` - no route wrapper in `App.tsx`
    - `/reports/performance/director-scorecard` - `RequireRole(["admin", "director"])`
    - `/reports/performance/rep-activity` - `RequireRole(["admin", "director", "rep"])`
    - `/reports/performance/forecast-accuracy` - `RequireRole(["admin", "director"])`
    - `/reports/analytics/market-mix` - no route wrapper in `App.tsx`
    - `/reports/analytics/customer-concentration` - no route wrapper in `App.tsx`
    - `/reports/analytics/executive-trends` - no route wrapper in `App.tsx`
    - `/reports/operations/workflow-bottlenecks` - `RequireRole(["admin", "director"])`
    - `/reports/operations/project-readiness` - `RequireRole(["admin", "director"])`
    - `/reports/operations/portfolio-load` - `RequireRole(["admin", "director"])`
- `server/src/modules/reports/routes.ts:152-600`
  - current report API gates:
    - `GET /api/reports/pipeline-velocity` - no explicit route-level role wrapper in this file
    - `GET /api/reports/lead-conversion` - no explicit route-level role wrapper in this file
    - `GET /api/reports/closed-won-summary` - `requireDirector`
    - `GET /api/reports/director-scorecard` - `requireDirector`
    - `GET /api/reports/rep-activity` - `requireAnyRole`
    - `GET /api/reports/forecast-accuracy` - `requireDirector`
    - `GET /api/reports/market-mix` - `requireAnyRole`
    - `GET /api/reports/customer-concentration` - `requireAnyRole`
    - `GET /api/reports/executive-trends` - `requireAnyRole`
    - `GET /api/reports/workflow-bottlenecks` - `requireDirector`
    - `GET /api/reports/project-readiness` - `requireDirector`
    - `GET /api/reports/portfolio-load` - `requireDirector`
- `client/src/pages/reports/reports-page.tsx:21-23`
  - `canViewDataMiningSection()` still hardcodes director-only logic, though it is not clearly used in the current page.
- `client/src/lib/report-export.ts`
  - current `main` only has CSV/PDF helpers, no XLSX builder.
- there are no dedicated `/export`, `/excel`, or `/xlsx` report endpoints on current `main`.

Stale local evidence from the killed session:

- local stale worktree contains:
  - `client/src/components/reports/export-excel-button.tsx`
  - `client/src/lib/excel-export.ts`
  - report-page integrations for sales, performance, operations, analytics, commissions, and some director/admin pages
- there is still no corresponding server-side XLSX endpoint in the stale worktree; the export was client-side workbook generation.

Rebuild interpretation:

- recreate the shared client-side Excel export button/helper in the report pages users can already reach
- keep director-only report pages director-only
- keep broader-role report pages broader-role
- leave server report authorization untouched because there is no dedicated server export endpoint to relax or align
