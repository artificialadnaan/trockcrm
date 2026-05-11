# Final Report: Projects Tab Procore Mirror

## Final State

NEEDS INTERVENTION

The implementation is local only. The track stopped after review round 3 because one material finding remains.

## Changed Locally

- Added tenant project mirror schema and migration draft:
  - `office_dallas.projects`
  - `office_dallas.project_phase_history`
  - `office_dallas.project_team`
  - `office_dallas.project_documents`
  - `office_dallas.project_sync_state`
  - same table set for `office_atlanta`
- Added `/api/projects` read APIs, grouped-by-phase API, detail related-resource APIs, and admin-only backfill endpoint.
- Extended SyncHub `procore.project.created` relay to upsert the new project mirror while preserving deal-link behavior.
- Rebuilt `/projects` and `/projects/:id` on the new display-only Procore mirror APIs.

## PR / Merge / Deploy

- PR: not created.
- Merge SHA: none.
- Deploy IDs: none.
- Backfill counts: none, production backfill not run.

## Review Rounds

- Round 1: 3 findings.
- Round 2: 2 findings.
- Round 3: 1 finding remains.

## Escalation

See `.reviews/projects-tab/ESCALATION.md`.

Remaining issue: phase-history initial-row idempotency is not fully concurrency-safe when Procore provides a phase name but no phase id.

## Verification

Passed before stopping:

- `npm run typecheck`
- `npx vitest run client/src/pages/projects/project-detail-page.test.tsx client/src/pages/projects/project-routing.test.tsx client/src/pages/projects/project-ui-source.test.tsx server/src/modules/projects/service.test.ts server/src/modules/projects/backfill-service.test.ts server/src/modules/projects/routes.test.ts server/src/modules/synchub/procore-project-relay-service.test.ts`

Focused test result after round-2 fixes: 7 test files, 19 tests passed.

## Smoke

Not run. The branch was not pushed, merged, deployed, or backfilled.

## Worktree Cleanup

Ran `git worktree prune --verbose`; no prune output was produced. The active worktree remains in place at `/Users/adnaaniqbal/projects/trockcrm-projects-tab` because it contains unpushed local work.

## Open Follow-Ups

- Fix the null-safe phase-history idempotency key.
- Rerun focused tests and `npm run typecheck`.
- Run another review after the fix before PR/deploy.
