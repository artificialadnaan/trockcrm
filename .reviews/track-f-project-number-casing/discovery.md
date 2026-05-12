# Project Number Casing Discovery

Timestamp: 2026-05-10T19:13:59Z

## Branch And Merge State

- Worktree: `/Users/adnaaniqbal/projects/trockcrm-project-number-casing`
- Branch: `fix/project-number-uppercase`
- Base: `origin/main` at `b629551 docs(audit): record project number backfill run`
- Recent main includes PR #204 (`fix/lead-conversion-projecttype`), PR #205 (`fix/scope-tab-get-write-bug`), and PR #206 (`feat/project-number-backfill`).

## Root Cause

The generated value seen in the Track A smoke test (`dfw-1-13026-aa`) comes from the CRM-owned generated `deal_number` column, surfaced in TypeScript as `dealNumber`.

The generation path is:

1. `server/src/modules/leads/conversion-service.ts` converts a lead and calls `deps.createDeal(...)`.
2. `server/src/modules/deals/service.ts:createDeal` validates `officeCode`, then calls `generateDealNumberForProject(...)`.
3. `server/src/services/projectNumber.ts:generateDealNumberForProject` resolves the office to lowercase `dfw` / `atl`.
4. `server/src/services/projectNumber.ts:buildProjectNumber` formats the final value with `input.officeCode.toLowerCase()`.

That final lowercase call is the immediate root cause.

There are two related fields on `deals`:

- `deal_number`: generated CRM project/deal identifier used by new deal creation and many UI/API surfaces.
- `project_number`: imported/backfilled canonical project number from HubSpot/Bid Board context. Track C backfilled this field from preserved HubSpot properties.

The user-facing smoke value matches `deal_number`, not `project_number`.

## Other Project Number Builders

Found project-number/deal-number builders:

- `server/src/services/projectNumber.ts:buildProjectNumber` is the shared generator used by:
  - `server/src/modules/deals/service.ts:createDeal`
  - `scripts/refixDealNumbers.ts`
  - `scripts/migration-promote.ts`
  - `server/src/modules/procore/synchub-routes.ts`
- `server/src/services/projectNumber.ts:buildIntendedProjectNumber` also lowercases the office prefix when computing a type-correct intended number.
- `server/src/modules/deals/service.ts:resolveIntendedProjectNumberFromCode` separately lowercases the office prefix for intended-number suggestions.

The generator fix should update the shared formatter, and intended-number helpers should also emit uppercase prefixes so future suggested canonical values do not reintroduce lowercase prefixes.

## Office Code Storage

`officeCode` is intentionally stored/validated as lowercase in current deal creation:

- `server/src/modules/deals/service.ts:assertValidOfficeCode` returns `"dfw" | "atl"`.
- `server/src/modules/leads/service.ts:assertValidOfficeCode` follows the same convention.
- `server/src/services/projectNumber.ts:resolveOfficeCode` returns `"dfw" | "atl"`.

No evidence suggests the `office_code` storage convention should change. The low-blast-radius fix is to uppercase only the formatted project/deal number prefix.

## Production Read-Only Inspection

Railway internal Postgres URL was not reachable from the local shell. I used the provided `test-admin@trock.test` account and the production API read-only.

Endpoint sampled:

- `GET https://<prod-api-host>/api/deals?page=1&limit=500&scope=all`
- `GET https://<prod-api-host>/api/deals?page=2&limit=500&scope=all`

Returned active deals: 756.

`dealNumber` casing:

- Values present: 756
- Uppercase DFW/ATL prefix: 0
- Lowercase dfw/atl prefix: 1
- Other legacy/import prefixes: 755
- Lowercase sample: `dfw-1-13026-aa`

`projectNumber` casing:

- Values present: 425
- Uppercase DFW/ATL prefix: 425
- Lowercase dfw/atl prefix: 0
- Other: 0
- Uppercase sample: `DFW-5-09726-ad`, `DFW-1-06926-ac`, `DFW-1-11326-aa`

This confirms Track C's backfilled `projectNumber` values are already canonical, and the live bug is in generated `dealNumber`.

## Scope Recommendation

Recommended scope: Option A + Option C, but apply the backfill normalization to both relevant columns:

1. Fix the single shared generator output so new `dealNumber` values use uppercase office prefix and lowercase suffix.
2. Do not alter `officeCode` storage.
3. Add an idempotent script that normalizes first-segment casing for:
   - `deal_number`, to correct the known generated lowercase smoke value and any similar generated values.
   - `project_number`, to satisfy the requested production audit path and protect against future/import edge cases.

The script should only touch values whose first segment is a case-insensitive DFW/ATL prefix and is not already uppercase. It should not touch legacy values such as `HS-*`, `TR-*`, or arbitrary non-canonical historical identifiers.

