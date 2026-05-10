# Track F Fix-Forward: project number casing edge cases

This PR fixes the Codex post-merge findings from Track F PR #212, which introduced the uppercase project-number generator and production normalization script. Note: `origin/main` did not yet contain PR #212 when this worktree was created, so this branch includes the Track F baseline commit plus this fix-forward commit.

## Findings addressed

- P2: `resolveIntendedProjectNumberFromCode` now compares computed intended project numbers to issued deal numbers case-insensitively, so legacy lowercase values like `dfw-1-12826-aa` clear `intendedProjectNumber` when the type already matches.
- P2: `normalize-project-number-case.ts` now marks execute runs as failed when any batch fails, while preserving database-client cleanup and dry-run exit-0 behavior.
- P3: `ProjectNumberBuildInput.officeCode` is constrained again to `DFW | ATL | dfw | atl`.

## Tests

- `npx vitest run --config vitest.config.ts server/tests/modules/deals/service.test.ts server/tests/scripts/normalize-project-number-case.test.ts server/tests/services/project-number.test.ts`
- `npm run typecheck`
- `npm run test --workspace=server -- tests/modules/deals/service.test.ts tests/services/project-number.test.ts`

## Review

- Subagent review round 1: clean, no P1/P2 findings.
- Full `npm run test --workspace=server` was also attempted; it still has broad pre-existing route/sandbox failures (`listen EPERM`, missing route tests, and unrelated legacy failures), while the changed/focused tests pass.
