# Track F Fix-Forward Review - Round 1

Date: 2026-05-10
Worktree: `/Users/adnaaniqbal/projects/trockcrm-track-f-fix`

## Findings

No P1/P2 findings.

## Verified Items

- P2 intended-number clearing is fixed: `resolveIntendedProjectNumberFromCode` still returns `null` for unparseable/null issued values, and the computed intended value is now compared to the issued deal number case-insensitively via `resolveIntendedProjectNumberFromParts` in `server/src/modules/deals/service.ts:235`.
- P2 script failure signaling is fixed: execute-mode batch failures now set `process.exitCode = 1` after logging a failure summary, while the `finally` block still reaches `client.end()` in `scripts/normalize-project-number-case.ts:262` and `scripts/normalize-project-number-case.ts:325`.
- P2 dry-run behavior is unchanged for the actual script path: dry-run calls the summary helper with zero failed batches, logs `DRY RUN ONLY`, returns before writes, and does not set `process.exitCode` in `scripts/normalize-project-number-case.ts:296`.
- P3 office-code typing is constrained again: `ProjectNumberBuildInput.officeCode` is narrowed to `"DFW" | "ATL" | "dfw" | "atl"` in `server/src/services/projectNumber.ts:9`, and existing production callers still feed it through `resolveOfficeCode`.
- Track F uppercase generation is preserved: `buildProjectNumber` still uppercases the office prefix through `formatProjectNumberOfficePrefix` in `server/src/services/projectNumber.ts:48` and `server/src/services/projectNumber.ts:98`.

## Tests Reviewed

- `server/tests/modules/deals/service.test.ts:735` covers lowercase legacy issued deal numbers clearing `intendedProjectNumber`.
- `server/tests/modules/deals/service.test.ts:758` covers case-insensitive intended/issued comparison plus null/undefined helper handling.
- `server/tests/scripts/normalize-project-number-case.test.ts:70` covers execute-mode failed-batch exit signaling.
- `server/tests/scripts/normalize-project-number-case.test.ts:124` covers dry-run remaining informational.
- `server/tests/services/project-number.test.ts:55` uses `@ts-expect-error` to keep malformed mixed-case prefixes rejected at compile time.

## Verification Run

- `npx vitest run server/tests/modules/deals/service.test.ts server/tests/scripts/normalize-project-number-case.test.ts server/tests/services/project-number.test.ts` - passed, 55 tests.
- `npm run typecheck` - passed across shared, server, worker, client, and client-field workspaces.

## Residual Risks

- `resolveIntendedProjectNumberFromParts` is exported for direct unit coverage and returns an intended value when `issuedProjectNumber` is null/undefined. The production wrapper still guards null/unparseable issued numbers before calling it, so I do not see a current regression, but future direct callers should preserve that contract distinction.
- Runtime validation for `buildProjectNumber` remains unchanged; the office-code restriction is compile-time only. That matches the minimal fix requested and existing caller shape.
