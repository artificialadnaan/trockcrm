# Test Suite Cleanup — 40 Pre-existing Failures on Main

## Problem

The server test suite on `main` has **40 failing tests across 13 files** out of 1,095 total. These predate the lead-verification PR1 work and were surfaced when running the full suite as a regression check.

With 40 reds always present, the suite has lost its signal: any new red is invisible against the baseline noise. We can no longer trust "tests passed" as a quality gate, because the baseline has been "tests partially failed" for some unknown duration.

## Concrete example seen during PR1

`server/tests/modules/tasks/inbound-email-rules.test.ts:26`:

```ts
expect(emailRules).toHaveLength(2);
// AssertionError: expected [ { …(6) }, { …(6) }, { …(6) } ] to have a length of 2 but got 3
```

A third email rule was added to `TASK_RULES` at some point and the assertion was never updated. Could be a real bug (the new rule was a mistake), could be stale (the test should now expect 3), or could be flaky — we don't know without inspection. That ambiguity is the whole problem.

## Suggested approach

**Do not attempt to fix all 40 in one PR.** That's a different scope and will conflict with active branches.

Instead, **triage all 40 into three buckets**, then tackle them in batches:

### Bucket 1 — Real bug, fix
The test was right; production code regressed. Treat as a bug fix: open a focused PR per failure with the regression hypothesis stated up front.

### Bucket 2 — Stale test, delete or update
The production behavior intentionally changed and the test wasn't updated. Either delete the test (if the assertion no longer matches business intent) or rewrite the assertion to match current behavior. Document *why* in the commit message.

### Bucket 3 — Flaky, investigate
Test passes sometimes, fails others. Most expensive bucket. Common causes: ordering dependencies between tests, shared global state, time-of-day assertions, real-clock dependencies. Investigate one at a time; do not bulk-skip.

## First steps

1. Run the full server suite three times in a row on `main`. Any test that fails inconsistently across the three runs lands in **Bucket 3 (flaky)** immediately. Don't even read those files yet.
2. For the consistently-failing tests, open each file, read the most recent commit that touched the production code under test, and decide Bucket 1 vs Bucket 2.
3. Build a triage table: `file:line | bucket | one-line rationale | est. fix size`. Commit that table to `docs/superpowers/audits/test-failures-2026-04-27.md` so progress is visible.

## Out of scope for this plan

- A new linter/CI gate that blocks merging on red tests. That's the right end state, but you can't enable it until the baseline is green. Tackle baseline first.
- Rewriting the test framework / runner. Vitest is fine; the problem is content, not tooling.

## Why this matters now

PR2 (verification email + tokenized approval) and PR3 (assigned-approver UI) will both touch lead-creation and email pathways. Without a green baseline, regressions introduced by those PRs will be indistinguishable from existing noise. Resolving the 40 reds before PR2 lands is the cheap path; doing it after means re-running PR1's regression-check exercise every PR.

## Suggested timeline

- 1 hour: triage to buckets (the table).
- 2-4 hours: Bucket 2 (stale tests — usually one-line fixes or deletions).
- 4-8 hours: Bucket 1 (real bugs — varies).
- Open-ended: Bucket 3 (flakies — schedule one-per-week if needed).
