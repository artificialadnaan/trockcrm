# Escalation: Projects Tab Procore Mirror

## Status

STOPPED before push, PR, merge, deploy, backfill, and production smoke.

## Reason

Review round 3 still has one material finding, so the track must stop under the review-loop rule.

## Remaining Finding

Medium: initial phase-history idempotency is not fully concurrency-safe when Procore provides a phase name without a phase id.

The attempted fix added an idempotent insert plus a partial unique index on `(project_id, to_phase_id, to_phase_name)` for initial rows. Because `to_phase_id` is nullable and PostgreSQL unique indexes treat nulls as distinct by default, two concurrent writers can still create duplicate initial rows for the same project and phase name when `to_phase_id` is null.

## Proposed Follow-Up

Make the initial phase-history idempotency key null-safe before this branch is pushed:

- Prefer a unique expression index on `(project_id, COALESCE(to_phase_id, ''), to_phase_name)` for initial rows, or a `NULLS NOT DISTINCT` unique index if the deployed PostgreSQL version supports it.
- Update the service insert to use the same normalized phase key in its `NOT EXISTS` guard.
- Add a regression test for a phase-name-only snapshot under the conflict-update path.

## Verification Completed Before Stop

- `npm run typecheck` passed after round-2 fixes.
- Focused tests passed: 7 test files, 19 tests.

## Not Run

- No branch push.
- No PR.
- No merge.
- No Railway deploy.
- No production backfill.
- No production smoke.
