# Projects Tab PR Review - Round 4 Post-Fix

## Findings

No remaining P1/P2 material findings found in this post-escalation review.

## Escalation Fix Verification

- `migrations/0110_projects_procore_mirror.sql:8` loops over both `office_dallas` and `office_atlanta`.
- `migrations/0110_projects_procore_mirror.sql:75` creates the initial phase-history unique index with `NULLS NOT DISTINCT`, so phase-name-only initial rows with `to_phase_id IS NULL` conflict as intended.
- `server/src/modules/projects/service.ts:392` writes initial phase history whenever a pre-read found no existing project and the incoming row has a phase name.
- `server/src/modules/projects/service.ts:399` relies on `ON CONFLICT DO NOTHING` for idempotent initial-history insertion.
- `server/src/modules/projects/service.test.ts:123` covers two concurrent phase-name-only upserts, and `server/src/modules/projects/service.test.ts:174` asserts exactly one initial history row is created.

## Scoped Review Checks

- Tenant leakage: no new issue found. Read routes use the request tenant client, and the backfill still skips unmatched projects whose project number does not belong to the active office prefix.
- Migration hazards: no P1/P2 issue found in the reviewed migration path.
- Procore write-back violations: no Procore write-back path found; the CRM project mirror remains display-only.
- SyncHub relay regressions: no remaining P1/P2 relay issue found; the existing deal-link behavior is preserved while adding the mirror upsert.
- Backfill idempotency and office filtering: no remaining P1/P2 issue found.
- Phase history race/idempotency: the round-3 nullable phase-id race is fixed by the `NULLS NOT DISTINCT` unique index plus `ON CONFLICT DO NOTHING`.
- Accessibility regressions: no remaining P1/P2 issue found in the project detail tabs.
- Raw UUID/stage IDs in UI: no visible raw Procore project IDs or stage IDs found in the projects list/detail UI.

## Verification

Focused tests passed:

`npx vitest run client/src/pages/projects/project-detail-page.test.tsx client/src/pages/projects/project-ui-source.test.tsx client/src/pages/projects/project-routing.test.tsx server/src/modules/projects/service.test.ts server/src/modules/projects/backfill-service.test.ts server/src/modules/projects/routes.test.ts server/src/modules/synchub/procore-project-relay-service.test.ts`

Result: 7 test files passed, 20 tests passed.
