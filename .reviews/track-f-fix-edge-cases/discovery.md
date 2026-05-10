# Track F Fix-Forward Discovery

Date: 2026-05-10
Branch: `fix/project-number-casing-edge-cases`
Worktree: `/Users/adnaaniqbal/projects/trockcrm-track-f-fix`

## Baseline State

- Pulled latest `origin/main`; HEAD was `b95b78c` (`Merge pull request #214 from artificialadnaan/fix/scope-tab-recovery-edge-cases`).
- Track F PR `#212` (`fix/project-number-uppercase`) was still open and not merged on `origin/main`, despite the prompt saying it had shipped.
- To make this fix-forward branch match the requested Track F baseline, I cherry-picked Track F commit `81b4ea5` onto this branch as commit `a4411d2`.

## `resolveIntendedProjectNumberFromCode`

Callers:

- `applyProjectTypeChange` in `server/src/modules/deals/service.ts`.

Contract:

- Input `issuedProjectNumber`: the current issued deal number stored on the deal.
- Input `projectTypeCode`: the code for the selected active project type.
- Output `null`: no intended project number change is needed, or the issued number is not parseable enough to compute one.
- Output non-null string: the project type segment in the issued number differs from the selected project type, so the UI can present an intended replacement while preserving the original issued number.

Semantics:

- `issuedProjectNumber` is the actual persisted deal number.
- `intendedProjectNumber` is a suggested replacement when the selected project type no longer matches the issued number's type segment.
- The selected project type matching the issued number should clear `intendedProjectNumber`.

Risk review:

- Case-insensitive comparison only affects the final equality test between computed canonical output and the persisted issued number.
- It does not loosen parsing; malformed issued values still return `null`.
- A pure exported helper was added for direct unit coverage of null/undefined issued values after office/date/suffix parts are already known. The wrapper still returns `null` when no issued value can be parsed.

Decision:

- Compare `intended.toLowerCase()` to `issuedProjectNumber.toLowerCase()` after guarding null/undefined.

## `normalize-project-number-case.ts`

Exit paths before the fix:

- Argument/env/load errors reach the top-level `.catch`, log the error, and `process.exit(1)`.
- `--dry-run` writes the audit CSV, logs `DRY RUN ONLY`, and returns with exit 0.
- Execute cancelled at prompt logs cancellation and returns with exit 0.
- Execute mode processes batches per tenant; each batch is transactional.
- A failed batch rolls back that batch, increments `failedBatches`, logs the rollback, and stops remaining batches for that tenant.
- The script then aggregated totals and always logged `EXECUTION COMPLETE`, even when `totalFailedBatches > 0`.

Decision:

- Add a testable `reportExecutionSummary` helper.
- Execute mode with any failed batch logs `EXECUTION COMPLETED WITH FAILURES`, includes the audit path, and sets `process.exitCode = 1`.
- `process.exitCode` is used instead of immediate `process.exit(1)` so the `finally` block still closes the database client.
- Dry-run remains informational and exit 0.

## `ProjectNumberBuildInput.officeCode`

Callers:

- `generateDealNumberForProject` in `server/src/services/projectNumber.ts`.
- `scripts/refixDealNumbers.ts`.
- `scripts/migration-promote.ts`.
- `server/src/modules/procore/synchub-routes.ts`.
- Unit tests in `server/tests/services/project-number.test.ts`.

Observed production call shape:

- Production-facing callers resolve office codes through `resolveOfficeCode`, which returns `"dfw" | "atl"`.
- Tests and direct helper usage also use uppercase `"DFW"` and lowercase legacy `"dfw" | "atl"` values.

Decision:

- Restore the smaller four-value union: `"DFW" | "ATL" | "dfw" | "atl"`.
- Keep runtime formatting as uppercase output so Track F's original casing fix remains intact.
- Add a compile-time `@ts-expect-error` test to reject malformed mixed-case prefixes such as `"Dfw"`.
