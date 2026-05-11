# Projects Tab PR Review - Round 2

## Findings

### High - Admin backfill can mirror every Procore company project into whichever tenant runs it

- `server/src/modules/projects/routes.ts:69`
- `server/src/modules/projects/routes.ts:71`
- `server/src/modules/projects/backfill-service.ts:60`
- `server/src/modules/projects/backfill-service.ts:63`
- `server/src/modules/projects/backfill-service.ts:75`
- `server/src/modules/projects/backfill-service.ts:105`

`POST /api/projects/backfill` scopes the write target to the current tenant schema, but the fetch side is not tenant/office scoped. `runProjectsBackfill` defaults to the global `PROCORE_COMPANY_ID` and pages `/companies/{companyId}/projects`, then upserts every returned project into `currentSchema(req)`, even when `findSourceDealIdForProcoreProject` finds no matching deal in that tenant.

Because the migration creates separate `office_dallas` and `office_atlanta` mirror tables, an Atlanta admin backfill against the shared Procore company can insert Dallas projects into `office_atlanta.projects` with `source_deal_id = NULL`, and vice versa. That violates the tenant-local mirror contract and exposes cross-office project rows in `/projects`.

The backfill needs an office discriminator before insert, or it should only insert projects that can be assigned to the current tenant by a trusted mapping/prefix/source deal. At minimum, unmatched rows should not be blindly mirrored into the active tenant.

### Medium - Concurrent initial upsert can still leave missing phase history

- `server/src/modules/projects/service.ts:260`
- `server/src/modules/projects/service.ts:321`
- `server/src/modules/projects/service.ts:364`
- `server/src/modules/projects/service.ts:366`
- `server/src/modules/projects/service.ts:395`

The round-1 duplicate-history issue was addressed by using `RETURNING id, (xmax = 0) AS inserted`, so a conflict loser no longer writes a duplicate initial "Entered phase" row. However, the current logic now misses the opposite race.

If a minimal SyncHub relay and an admin backfill race for a new Procore project, both can read no existing row. The relay can win the insert with no phase, while the backfill hits `ON CONFLICT DO UPDATE` and sets `current_phase_*` from its richer snapshot. Since the backfill call still has `existing === undefined` and `inserted === false`, both `phaseChanged` and the initial-history branch are false. The final project row has a phase, but `project_phase_history` has no initial entry for it.

The phase-history write needs to be idempotent against the post-upsert row state, not just the pre-read plus inserted flag. A unique/idempotent initial event or a post-upsert comparison would close both the duplicate and missing-history cases.

## Round-1 Follow-Up

- Detail tab semantics: fixed. The detail page restores `role="tablist"`, `role="tab"`, `aria-selected`, and labelled panels.
- Raw Procore project ID display: fixed. The visible detail UI no longer renders `project.procoreProjectId`.
- Duplicate initial phase-history rows: partially fixed. Exact duplicate initial rows are avoided, but the concurrent conflict path above can now lose the initial history event.

## Verification

Focused tests passed:

`npx vitest run client/src/pages/projects/project-detail-page.test.tsx client/src/pages/projects/project-ui-source.test.tsx client/src/pages/projects/project-routing.test.tsx server/src/modules/projects/service.test.ts server/src/modules/projects/backfill-service.test.ts server/src/modules/projects/routes.test.ts server/src/modules/synchub/procore-project-relay-service.test.ts`

Result: 7 test files passed, 18 tests passed.
