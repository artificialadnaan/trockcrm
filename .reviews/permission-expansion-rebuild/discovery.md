# Permission Expansion Rebuild Discovery

Date: 2026-05-15
Branch: `fix/permission-expansion-rebuild`
Base: `origin/main` at `075c358d`

## Assumption

Bug #23 does not line up cleanly with current `origin/main`. Current shipped code has CSV/PDF-style report exports and several report pages still role-gated, but no shared Excel export endpoint or button on `main`. A stale local worktree from the killed session contains a client-side Excel export implementation. For this rebuild, I am treating Bug #23 as:

- restore the lost client-side Excel export surface for reports
- relax the remaining report page role gates so reps can access the same export surface where intended
- do not broaden unrelated admin-only report surfaces

If this assumption proves wrong during verification, stop at the scope boundary and report it.

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

## Bug #23 - Excel export on reports gated by role

Current `origin/main` findings:

- `client/src/App.tsx:238-287`
  - several report pages are still wrapped in `RequireRole(["admin", "director"])`:
    - director scorecard
    - forecast accuracy
    - workflow bottlenecks
    - project readiness
    - portfolio load
- `server/src/modules/reports/routes.ts:221-620`
  - many report API routes still use `requireDirector`, while others already use `requireAnyRole`.
- `client/src/pages/reports/reports-page.tsx:21-23`
  - `canViewDataMiningSection()` still hardcodes director-only logic, though it is not clearly used in the current page.
- `client/src/lib/report-export.ts`
  - current `main` only has CSV/PDF helpers, no XLSX builder.

Stale local evidence from the killed session:

- local stale worktree contains:
  - `client/src/components/reports/export-excel-button.tsx`
  - `client/src/lib/excel-export.ts`
  - report-page integrations for sales, performance, operations, analytics, commissions, and some director/admin pages
- there is still no corresponding server-side XLSX endpoint in the stale worktree; the export was client-side workbook generation.

Rebuild interpretation:

- recreate the shared client-side Excel export button/helper in the report surfaces touched by the lost session
- remove only the role gates necessary so reps can access the intended export-capable report pages
- keep unrelated admin-only pages such as global admin dashboards out of scope

