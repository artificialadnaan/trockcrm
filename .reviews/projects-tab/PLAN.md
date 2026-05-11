# Projects Tab Procore Mirror

## Intent

Rebuild `/projects` from a deal-backed page into a tenant-local display-only mirror of Procore Portfolio projects.

## Scope

- Add tenant mirror tables for `projects`, `project_phase_history`, `project_team`, `project_documents`, and `project_sync_state` in `office_dallas` and `office_atlanta`.
- Add `/api/projects` read APIs, `/api/projects/by-phase`, project detail related resources, and admin-only `POST /api/projects/backfill`.
- Extend the existing SyncHub `procore.project.created` relay so its current deal-link behavior remains intact and it also upserts the new project mirror row.
- Rebuild the `/projects` list/Kanban page and `/projects/:id` detail page on the new APIs.
- Keep Procore as the system of record: all UI is display-only and no CRM writes are made back to Procore.

## Discovery Notes

- SyncHub relays a narrow `procore.project.created` payload to CRM with company id, portfolio project id, project number, and project name. It does not relay the full SyncHub `procore_projects` snapshot.
- CRM relay previously only updated `deals.procore_project_id`.
- Backfill uses the existing CRM `procoreClient` to page Procore projects directly because SyncHub does not expose a CRM-readable projects API in this repo.

## Verification So Far

- `npm run typecheck` passes.
- Focused tests pass:
  - `client/src/pages/projects/project-routing.test.tsx`
  - `client/src/pages/projects/project-ui-source.test.tsx`
  - `server/src/modules/projects/service.test.ts`
  - `server/src/modules/projects/backfill-service.test.ts`
  - `server/src/modules/projects/routes.test.ts`
  - `server/src/modules/synchub/procore-project-relay-service.test.ts`
