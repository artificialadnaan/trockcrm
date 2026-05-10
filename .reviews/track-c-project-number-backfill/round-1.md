# Track C Project Number Backfill Review - Round 1

Verdict: blocking issues

## Findings

### P2 - Rolled-back rows are still counted as updated after a partial batch failure

- `scripts/backfill-project-numbers.ts:363-386`

`executePlan()` increments `updated` immediately after each `UPDATE` statement returns (`scripts/backfill-project-numbers.ts:376`), but the transaction is not committed until after the entire batch finishes (`scripts/backfill-project-numbers.ts:378`). If any later update in the same batch throws, the catch block rolls back the whole batch (`scripts/backfill-project-numbers.ts:381`) while leaving the earlier row counts in `updated`. The final report can therefore claim rows were updated even though that batch was rolled back.

This violates the requirement that partial batch failure rolls back only that batch and reports accurately. The rollback scope itself is batch-local, but the reported `Rows updated` count is not transaction-accurate under a mid-batch failure.

Suggested fix: accumulate a `batchUpdated` count inside the transaction, add it to `updated` only after `COMMIT` succeeds, and include failed batch identity/counts in the execution report.

## Notes

- `--tenant` is required by `parseBackfillArgs()` (`scripts/backfill-project-numbers.ts:72-85`).
- Dry run defaults true unless `--execute` is present (`scripts/backfill-project-numbers.ts:88-104`, `scripts/backfill-project-numbers.ts:411-414`).
- `--execute` prompts and defaults to no unless the answer is exactly `y` (`scripts/backfill-project-numbers.ts:345-352`, `scripts/backfill-project-numbers.ts:420-423`).
- Collision detection is tenant-local, matching the discovered tenant-local partial unique index (`.reviews/track-c-project-number-backfill/discovery.md:41-48`, `shared/src/schema/tenant/deals.ts:204-206`).
- The canonical regex matches the discovery rule (`scripts/backfill-project-numbers.ts:8`, `.reviews/track-c-project-number-backfill/discovery.md:11-15`).
- Focused verification run: `npx vitest run server/tests/scripts/backfill-project-numbers.test.ts` passed 4 tests.
