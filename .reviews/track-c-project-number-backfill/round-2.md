# Track C Project Number Backfill Review - Round 2

Verdict: clean

## Findings

No blocking issues found.

## Requirement Re-check

- No mutation without `--execute`: `parseBackfillArgs()` defaults to dry run unless `--execute` is present, rejects `--dry-run` plus `--execute`, and `runBackfill()` returns before execution in dry-run mode (`scripts/backfill-project-numbers.ts:88-104`, `scripts/backfill-project-numbers.ts:413-415`). The only database write path is gated behind the execute branch and confirmation (`scripts/backfill-project-numbers.ts:422-430`).
- Explicit tenant: `--tenant=<office_dallas|office_atlanta|all>` is required and invalid tenants are rejected (`scripts/backfill-project-numbers.ts:72-85`). Test coverage asserts missing tenant refusal (`server/tests/scripts/backfill-project-numbers.test.ts:118-122`).
- `y` confirmation on execute: `confirmExecution()` only returns true for an exact case-insensitive `y` after trimming, and `runBackfill()` cancels before `executePlan()` if confirmation fails (`scripts/backfill-project-numbers.ts:345-352`, `scripts/backfill-project-numbers.ts:422-425`).
- Tenant-local collision handling based on discovered index: discovery confirms `deals_project_number_uidx` is per tenant schema (`.reviews/track-c-project-number-backfill/discovery.md:41-48`), and the script loads existing populated `project_number` values per selected tenant before planning (`scripts/backfill-project-numbers.ts:240-261`, `scripts/backfill-project-numbers.ts:401-406`). Existing-value and duplicate-candidate collisions are excluded from updates and recorded as `COLLISION` rows (`scripts/backfill-project-numbers.ts:117-193`), with test coverage for both paths (`server/tests/scripts/backfill-project-numbers.test.ts:25-77`).
- CSV audit completeness: audit rows include updates, skips, and collisions (`scripts/backfill-project-numbers.ts:201`, `scripts/backfill-project-numbers.ts:304-342`), and the CSV includes tenant, deal IDs, HubSpot deal IDs, action, reason, old/new value, and collision references (`scripts/backfill-project-numbers.ts:269-301`).
- Canonical regex: the implementation uses `^(DFW|ATL)-[0-9]+-[0-9]{5}-[a-z]{2}$`, matching discovery (`scripts/backfill-project-numbers.ts:8`, `.reviews/track-c-project-number-backfill/discovery.md:11-15`). Test coverage accepts DFW/ATL canonical examples and rejects legacy/freeform, lowercase prefix, wrong suffix length, wrong date length, wrong prefix, and null (`server/tests/scripts/backfill-project-numbers.test.ts:10-23`).
- Batch transaction error reporting: each batch runs inside `BEGIN`/`COMMIT`; failures roll back the current batch, increment `failedBatches`, log tenant/batch context plus the error message, and stop further batches while preserving prior committed batches (`scripts/backfill-project-numbers.ts:363-391`).

## Round-1 Blocker Verification

The over-reporting bug is fixed. `executePlan()` now accumulates `batchUpdated` inside the transaction and only adds it to the returned `updated` count after `COMMIT` succeeds (`scripts/backfill-project-numbers.ts:363-380`). If a later update in the same batch throws, the catch rolls back and returns no rows from that failed batch as updated (`scripts/backfill-project-numbers.ts:382-391`).

Regression coverage directly simulates the old failure mode: first update returns `rowCount: 1`, second update throws, `executePlan()` returns `{ updated: 0, failedBatches: 1 }`, `ROLLBACK` is observed, and `COMMIT` is not observed (`server/tests/scripts/backfill-project-numbers.test.ts:124-163`).

Focused verification run:

```text
npx vitest run server/tests/scripts/backfill-project-numbers.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)
```
