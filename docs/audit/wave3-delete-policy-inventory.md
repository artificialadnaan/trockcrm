# Wave 3 Delete Policy Inventory

Date: 2026-05-07

Wave 3 delete-policy inventory, enforcement notes, and launch exceptions.

## Summary

- Delete policy is enforced for primary business entities: admin-only soft-delete for deals, leads, companies, properties, files/photos, and call recordings; contacts remain director/admin soft-delete by deliberate exception.
- Delete audit logging was added through the shared audit helper and migration `0089`.
- Tasks are lifecycle-only by deliberate design; no true task delete endpoint or soft-delete column is in scope for May 15.
- Saved reports remain owner-only hard-delete because they are personal user artifacts, not business records.
- Server-side estimating cleanup is deferred to post-launch because worker registrations make static dead-code proof insufficient without a production queue check.
- Root typecheck passes after removing orphaned preview-only artifacts and refreshing the existing `client-field` image-compression dependency install.

| Entity | Delete endpoint | Current role guard | Current semantics | Audit logging | Response shape | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Deals | `DELETE /api/deals/:id` (`server/src/modules/deals/routes.ts:998`) | `requireRole("admin", "director")`; service only blocks `rep` (`server/src/modules/deals/service.ts:1407`) | Soft-delete: `deals.isActive = false`; also dismisses pending/in-progress deal tasks (`server/src/modules/deals/service.ts:1412`) | Generic update trigger should record `deals` update if DB triggers are active; no explicit `writeAuditLog` call in delete path | `200 { success: true }` | Policy target is admin-only, so director currently has broader access than locked policy. |
| Leads | `DELETE /api/leads/:id` (`server/src/modules/leads/routes.ts:455`) | No route-level role guard; service scopes through `getLeadById` (`server/src/modules/leads/service.ts:1621`) | Soft-delete: `leads.isActive = false`, updates `updatedAt` (`server/src/modules/leads/service.ts:1626`) | Generic update trigger should record `leads` update if DB triggers are active; no explicit `writeAuditLog` call in delete path | `200 { success: true }` | Policy target is admin-only. |
| Contacts | `DELETE /api/contacts/:id` (`server/src/modules/contacts/routes.ts:295`) | `requireRole("admin", "director")`; service only blocks `rep` (`server/src/modules/contacts/service.ts:543`) | Soft-delete: `contacts.isActive = false` (`server/src/modules/contacts/service.ts:548`) | Generic update trigger should record `contacts` update if DB triggers are active; no explicit `writeAuditLog` call in delete path | `200 { success: true }` | Matches locked exception: director + admin soft-delete. |
| Companies | None in `server/src/modules/companies/routes.ts` | Not applicable | Not applicable; table has `companies.isActive` and lists/searches filter active rows (`server/src/modules/companies/service.ts:36`) | Not applicable | Not applicable | Policy target is new admin-only soft-delete endpoint. |
| Properties | None in `server/src/modules/properties/routes.ts` | Not applicable | Not applicable; table has `properties.isActive` and list defaults active (`server/src/modules/properties/service.ts:129`) | Not applicable | Not applicable | Policy target is new admin-only soft-delete endpoint. Client-side property edit UI gap remains a Wave 5 item. |
| Tasks | No primary delete endpoint in `server/src/modules/tasks/routes.ts` | Lifecycle routes use task visibility/ownership checks; no delete guard | No soft-delete column exists in `shared/src/schema/tenant/tasks.ts`; lifecycle retirement is via `status = dismissed` / `completed` | No explicit generic delete audit for lifecycle dismissal; dismissal writes task-resolution state for dedupe suppression (`server/src/modules/tasks/service.ts:92`) | Not applicable | Deliberate policy exception: lifecycle-only retirement, no true delete for May 15. |
| Files / photos | `DELETE /api/files/:id` (`server/src/modules/files/routes.ts:707`) | Custom: admin/director or original uploader for deal/lead files; reps can delete only their own unscoped files (`server/src/modules/files/routes.ts:713`) | Soft-delete: `files.isActive = false`, `deletedAt`, `deletedByUserId` (`server/src/modules/files/service.ts:960`) | Photo deletes write `photo_audit_log` event `deleted` with IP/user-agent context (`server/src/modules/files/routes.ts:737`); generic update trigger should also record `files` update if active | `200 { success: true }` | Policy target is admin-only for all files/photos unless a user-upload self-delete exception is intentionally retained. |
| Call recordings | `DELETE /api/call-recordings/:id` (`server/src/modules/call-recordings/routes.ts:145`) | Admin-only via route `requireAdminRole` and service role check (`server/src/modules/call-recordings/service.ts:327`) | Soft-delete: `call_recordings.deletedAt = now()` where not already deleted (`server/src/modules/call-recordings/service.ts:337`) | Creates a CRM activity noting the deletion (`server/src/modules/call-recordings/service.ts:345`); generic update trigger should also record the update if active | `204 No Content` | Already matches admin-only policy. |
| Users | No primary user delete endpoint; tenant `GET /api/users/sales-reps` only (`server/src/modules/users/routes.ts`) | Admin-managed invite/access routes use admin guard | Users are managed through invite/revoke and office-access grant/revoke. `DELETE /api/admin/users/:id/office-access/:officeId` removes access join row, not the user (`server/src/modules/admin/routes.ts:247`) | No generic primary user delete audit because no user delete exists | Access revoke returns `200 { success: true }` | User rows appear intentionally non-deletable; access revoke is not a primary entity delete. |
| Projects | No standalone CRM project table found; CRM project views are deal-backed Procore project routes (`server/src/modules/procore/routes.ts:359`) and field project routes (`server/src/modules/field/routes.ts:35`) | No primary project delete endpoint | Project visibility appears derived from active deals with `procoreProjectId`; field star deletion only removes a preference association | Not applicable for primary project delete | Not applicable | Treat as deal-backed unless a separate CRM project entity is introduced. |
| Saved reports | `DELETE /api/reports/saved/:id` (`server/src/modules/reports/routes.ts:465`) | Owner-only in service; no role guard (`server/src/modules/reports/saved-reports-service.ts:160`) | Hard-delete from public `saved_reports` after locked/owner checks (`server/src/modules/reports/saved-reports-service.ts:172`) | No explicit audit log observed | `200 { success: true }` | Deliberate policy exception: personal artifact, not a business record. |
| Contact-deal associations | `DELETE /api/contacts/associations/:associationId` (`server/src/modules/contacts/routes.ts:373`) | Association visibility/ownership checks | Hard-delete association row | No primary entity audit observed | `200 { success: true }` | Association cleanup, not a primary entity delete. |
| Deal team members | `DELETE /api/deals/:id/team/:memberId` (`server/src/modules/deals/routes.ts:1094`) | Route-local access checks | Deactivates team membership association | No primary entity audit observed | `200 { success: true }` | Association cleanup, not a primary entity delete. |
| Estimate sections/items | `DELETE /api/deals/:id/estimates/sections/:sectionId`, `DELETE /api/deals/:id/estimates/items/:itemId` (`server/src/modules/deals/routes.ts:1168`, `server/src/modules/deals/routes.ts:1244`) | Existing active estimates route checks | Hard-delete estimate subresources | No primary entity audit observed | JSON success payloads | Active `DealEstimatesTab` route family; explicitly out of scope for Wave 3 delete-policy changes. |
| Field project stars | `DELETE /api/field/projects/:dealId/star` (`server/src/modules/field/routes.ts:70`) | Field-project middleware | Hard-delete field-user star association | No primary entity audit observed | `204 No Content` | Preference association, not a primary project delete. |
| Admin office access | `DELETE /api/admin/users/:id/office-access/:officeId` (`server/src/modules/admin/routes.ts:247`) | `requireAdmin` | Hard-delete user-office access join row (`server/src/modules/admin/users-service.ts:247`) | No primary entity audit observed | `200 { success: true }` | Access revoke flow, not a user delete. |

## Audit Infrastructure Observed

- Tenant `audit_log` table exists with `table_name`, `record_id`, `action`, `changed_by`, `changes`, `full_row`, `ip_address`, `user_agent`, and `created_at` (`shared/src/schema/tenant/audit-log.ts:16`).
- `writeAuditLog` helper exists for explicit audit entries (`server/src/lib/audit-log.ts:28`).
- `AUDIT_ACTIONS` enum currently supports only `insert`, `update`, and `delete` (`shared/src/types/enums.ts:334`), so explicit soft-delete audit rows need to use existing enum values unless a schema/enum migration is approved.
- Photo-specific `photo_audit_log` exists and file/photo delete already writes a `deleted` photo event.

## Delete Policy Exceptions

### Tasks: Lifecycle-Only Retirement

Tasks do not have a soft-delete column. Task retirement is handled through lifecycle status (`dismissed`, `completed`, `cancelled`) with reason fields where applicable. This is deliberate: tasks are operational records where lifecycle intent (cancelled, no longer relevant, scope changed) carries more value than a binary deleted state. If a task was created in error and needs to vanish, an admin can dismiss it with a reason. True deletion is not in scope for May 15.

### Saved Reports: Owner-Only Hard-Delete

Saved reports are personal user artifacts, not business records. Owners may hard-delete their own saved reports without admin involvement. Non-owners, including admins, cannot delete another user's saved reports through this flow. This is an exception to the admin-only soft-delete policy that applies to business entities such as deals, contacts, companies, properties, leads, files, and call recordings.

Server-side enforcement lives in `server/src/modules/reports/routes.ts:465` and `server/src/modules/reports/saved-reports-service.ts:160`. The route passes the authenticated user ID to `deleteSavedReport`; the service rejects missing reports, locked reports, and reports where `saved_reports.created_by` does not match the actor before hard-deleting the row.

## Deferred to Post-Launch

### Estimating Module Cleanup

The server-side estimating module (`server/src/modules/estimating/*`) and its associated worker jobs (`estimate_document_ocr`, `estimate_generation`) appear to have no live entry point following the Wave 2 deletion of the client workbench, but static analysis cannot rule out hidden triggers. Cleanup is deferred to post-launch pending a production queue check confirming no recent jobs of these types have been enqueued. The active `DealEstimatesTab` and `/api/deals/:id/estimates/*` route family are unrelated and should be preserved.

Targeted post-launch deletion plan if the production queue check confirms no recent use:

- Delete `server/src/modules/estimating/*`.
- Delete `server/tests/modules/estimating/*`.
- Delete `worker/src/jobs/estimate-document-ocr.ts` and `worker/src/jobs/estimate-generation.ts`.
- Remove the worker registrations for `estimate_document_ocr` and `estimate_generation` from `worker/src/jobs/index.ts`.
- Delete estimating worker tests that only cover the deferred job path.
- Remove shared estimating-only schemas after confirming no remaining imports.
- Keep historical migrations unless a later explicit database cleanup migration is approved.

### `rollingPaidRevenue` Field Rename

Wave 1 reconciled the dashboard commission KPI to read from `deal_signed_commissions` while preserving the response field name `rollingPaidRevenue` to avoid a coordinated client/server change. The field name is now misleading because it reflects signed-commission data, not paid revenue. Rename it to `earnedYtd` or similar after the UI overhaul merges, in coordination with the client.

### Paid YTD Label Change

The dashboard card currently labeled "Paid YTD" now displays earned commission from contract signings. Client label change to "Earned YTD" is deferred to Wave 5 after the UI overhaul.
