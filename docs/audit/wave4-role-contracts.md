# Wave 4 Role Contract Audit

Date: 2026-05-07

Scope: server/shared role strings and client coordination items. No `client/src/` files were modified.

## Canonical Shared Roles

`shared/src/types/enums.ts` defines:

- `admin`
- `director`
- `rep`
- `construction`
- `field_contractor`

The same list feeds `shared/src/schema/public/users.ts` through `userRoleEnum`.

## Server-Side Usage Check

Server-side role checks are covered by the shared role list.

| Role | Server usage evidence |
| --- | --- |
| `admin` | `server/src/middleware/rbac.ts:21`, admin routes, Procore routes, migration routes, delete policy routes |
| `director` | `server/src/middleware/rbac.ts:22`, reports, AI ops, cleanup queues, contacts delete exception |
| `rep` | `server/src/middleware/rbac.ts:23`, reports scoping, deals/tasks/files ownership filters |
| `construction` | `server/src/modules/call-recordings/service.ts:216`, `266`, `303` |
| `field_contractor` | `server/src/middleware/field-auth.ts:46`, field-user services, local-auth exclusion, call-recording exclusion |

No server-side usage of `sales_manager` or `salesManager` was found in `server/src`, `worker/src`, or `shared/src`. Because the server does not currently accept that role, no shared enum change was made in Wave 4.

## Inconsistent Role Strings

No server-side camelCase role strings were found. Office role overrides remain constrained to `"admin" | "director" | "rep"` in admin-user routes and services, which is narrower than the full user-role enum by design for CRM office access.

## Client Coordination Needed For Wave 5

The client still defines local role unions or role assumptions that should be pointed at `@trock-crm/shared/types` after the UI overhaul branch merges:

- `client/src/components/auth/require-role.tsx:5` defines `type Role = "admin" | "director" | "sales_manager" | "rep" | "construction"`.
- `client/src/components/layout/sidebar.tsx:37` defines the same local `Role` union, including client-only `sales_manager` and excluding `field_contractor`.
- `client/src/lib/auth.tsx:9` defines `role: "admin" | "director" | "sales_manager" | "rep" | "construction"`.
- `client/src/lib/pipeline-scope.ts:7` defines `PipelineRole = "rep" | "director" | "admin"` for a narrower UI-scoping helper.
- `client/src/components/auth/require-role.test.tsx:20` narrows test helper allowed roles to `"admin" | "director" | "rep"`.

Client-only `sales_manager` is not backed by the current shared/server role enum. Wave 5 should either remove it from client unions or add a deliberate product/server role if that role is still intended.
