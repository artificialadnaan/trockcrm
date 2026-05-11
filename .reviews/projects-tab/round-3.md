# Projects Tab PR Review - Round 3

## Findings

### Medium - Initial phase history is still not concurrency-idempotent when Procore does not provide a phase ID

- `migrations/0110_projects_procore_mirror.sql:75`
- `shared/src/schema/tenant/projects.ts:83`
- `shared/src/schema/tenant/projects.ts:84`
- `server/src/modules/projects/service.ts:392`
- `server/src/modules/projects/service.ts:398`
- `server/src/modules/projects/service.ts:399`
- `server/src/modules/projects/service.ts:408`

Round 2's missing-history race is fixed for the tested path, but the duplicate-history side is still open whenever the Procore snapshot has `currentPhaseName` without `currentPhaseId`. That is a supported input path: `extractPhase` can populate `phaseName` from `project_stage_name`, `stage_name`, or `stage` while leaving `phaseId` null.

The new guard inserts the initial event with:

`SELECT ... WHERE NOT EXISTS (...) ON CONFLICT DO NOTHING`

and the migration/schema add a partial unique index on `(project_id, to_phase_id, to_phase_name)` for initial rows. In Postgres, regular unique indexes treat NULLs as distinct, so two concurrent writers with the same `project_id`, `to_phase_id = NULL`, and `to_phase_name = 'Warranty'` can both pass `NOT EXISTS` before either commits, then both insert. `ON CONFLICT DO NOTHING` will not suppress the second insert because the nullable indexed column does not conflict.

This leaves the round-1 race unfixed for Procore rows that only carry a phase/stage name, which the backfill tests explicitly exercise via `project_stage_name: "Warranty"`. Make the idempotency key NULL-safe in the database, for example by indexing `COALESCE(to_phase_id, '')` plus `to_phase_name`, using `NULLS NOT DISTINCT` where supported, or storing a non-null normalized phase key for history idempotency.

## Round-2 Follow-Up

- Backfill office filtering: fixed for the reviewed scope. `runProjectsBackfill` now only mirrors unmatched rows when the Procore project number matches the active office prefix, and the focused tests cover Dallas skipping Atlanta rows.
- Missing initial phase history after a conflict update: fixed for the reviewed non-null phase-ID path. The code now attempts an initial history insert whenever the pre-read found no existing row and the incoming row has a phase name.
- Detail tab semantics: still fixed.
- Raw Procore project ID display: still fixed. I did not find visible raw Procore project IDs or stage IDs in the projects list/detail UI.

## Verification

Focused tests passed:

`npx vitest run client/src/pages/projects/project-detail-page.test.tsx client/src/pages/projects/project-ui-source.test.tsx client/src/pages/projects/project-routing.test.tsx server/src/modules/projects/service.test.ts server/src/modules/projects/backfill-service.test.ts server/src/modules/projects/routes.test.ts server/src/modules/synchub/procore-project-relay-service.test.ts`

Result: 7 test files passed, 19 tests passed.
