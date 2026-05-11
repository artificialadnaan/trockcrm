# leads-kanban-truncation-bug Escalation

## Status

Implementation is complete locally. Phase 5 was initially blocked by the Phase 3 full-suite test gate, but the owner approved proceeding with focused green tests because the remaining full-suite failures are pre-existing baseline failures on `origin/main`, unrelated to lead board work.

## Why This Stops

The track instructions require `npm run typecheck` and `npm run test` to pass before push/PR/merge. `npm run typecheck` passes, but `npm run test` does not pass on the current `origin/main` baseline even after rerunning with escalated permissions to remove sandbox socket-binding failures.

Per owner decision, continue this track with the focused lead-board regression suite as the acceptance gate for this scoped fix. Do not address the unrelated baseline failures in this PR.

## Owner Decision

Proceed with Option 1:

- Accept the focused green lead-board tests and continue the track.
- Treat the full `npm run test` failures as pre-existing baseline failures on `origin/main`.
- Document the unaddressed baseline failures in the PR body.
- File a separate Monday morning issue for repairing the baseline suite.
- After Codex review on the new PR, address only new findings, not the pre-existing baseline failures.

## Verification Already Completed

- `npm run typecheck`: passed.
- Focused regression tests: passed.
  - `npx vitest run client/src/hooks/use-leads.test.ts client/src/pages/leads/lead-list-page.test.tsx server/tests/modules/leads/board-service.test.ts`
  - Result: 3 test files, 23 tests passed.
- Review round 1: no findings.
- `git diff --check`: passed.
- Deals files check: no files under `client/src/pages/deals/` or `client/src/components/deals/` are modified in this working diff.

## Full Test Failure Summary

Initial sandboxed `npm run test` failed heavily with route-test socket errors:

- `listen EPERM: operation not permitted 0.0.0.0`

Escalated rerun removed those socket failures, but still failed with unrelated baseline suites:

- 20 failed test files, 45 failed tests, 3 failed suites.
- Examples:
  - `tests/modules/migration/commission-deal-snapshots-migration.test.ts`: missing `server/migrations/0107_commission_deal_snapshots.sql`.
  - `tests/modules/reports/analytics-cycle.test.ts` and `forecast-variance.test.ts`: mocked `rbac.js` lacks `requireAnyRole`.
  - `tests/modules/estimating/workflow-state-routes.test.ts`: expected estimating routes not found.
  - `tests/modules/deals/board-service.test.ts`: `listDealBoard is not a function`.
  - Several report/deals/auth/task tests with expectation mismatches unrelated to lead board payload size.

## Follow-Up

- Separate issue: "Repair pre-existing test baseline failures on origin/main".
