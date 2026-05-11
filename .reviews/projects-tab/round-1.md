# Projects Tab PR Review - Round 1

## Findings

### Medium - Detail tabs lost tab semantics and the existing detail test now fails

- `client/src/pages/projects/project-detail-page.tsx:124`
- `client/src/pages/projects/project-detail-page.tsx:128`
- `client/src/pages/projects/project-detail-page.test.tsx:15`

The new detail tab strip renders a plain `<div>` with plain `<button>` children and no `role="tablist"`, `role="tab"`, `aria-selected`, or labelled tablist. The previous test still asserts those semantics, and the focused test currently fails:

`npx vitest run client/src/pages/projects/project-detail-page.test.tsx`

Failure: expected the source to contain `role="tablist"`.

This is an accessibility regression for keyboard/screen-reader users and also leaves the branch with a failing existing test. Either restore the tab roles/ARIA state or intentionally replace the old test with equivalent coverage for the new tab implementation.

### Medium - Project detail exposes a raw Procore project ID despite the no-raw-ID display requirement

- `client/src/pages/projects/project-detail-page.tsx:152`
- `client/src/pages/projects/project-detail-page.tsx:154`

PLAN.md calls for a display-only Procore mirror, and the review prompt explicitly says no raw UUID/stage IDs should be visible to users. The overview card currently renders `Procore project id` with `project.procoreProjectId`, which is the raw Procore identifier rather than the user-facing project number/name already shown in the header and list. This should be removed from the normal user UI or moved behind an admin/debug-only affordance if support needs it.

### Medium - Concurrent upserts can duplicate initial phase-history rows

- `server/src/modules/projects/service.ts:260`
- `server/src/modules/projects/service.ts:303`
- `server/src/modules/projects/service.ts:391`

`upsertProjectMirror` first reads the existing project, then performs `INSERT ... ON CONFLICT`, then decides whether to insert the initial phase-history row based on the pre-upsert `existing` value. If a webhook and backfill, or two admin backfills, process the same new Procore project at the same time, both calls can observe no existing row before one wins the unique insert. The loser will run the `ON CONFLICT DO UPDATE` path but still has `existing === undefined`, so it will also insert an "Entered phase" history row. That breaks the intended idempotent phase-history semantics.

Use the upsert result to distinguish inserted vs conflict-updated rows, or add a unique/idempotency constraint for the initial history event, before writing phase history.

## Notes

- I did not find a server route conflict with the reports routes in `App.tsx` or `server/src/app.ts`; `/projects` is mounted separately from `/reports`.
- The SyncHub relay still preserves the existing deal-link behavior while adding the project mirror upsert in the link transaction.
- The migration targets both `office_dallas` and `office_atlanta` and uses schema-qualified DDL for the new tenant tables.
