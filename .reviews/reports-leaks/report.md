# Reports Leaks Fix Summary

## Investigation Findings

### 1. `GET /api/admin/reports/cross-office-pipeline`

- Location: `server/src/modules/admin/routes.ts`, `/api/admin/reports/cross-office-pipeline`.
- Current query shape: raw `pg` SQL per tenant schema with `SET search_path`.
- Existing filters:
  - `active_deals`: `COUNT(*) FILTER (WHERE is_active = true)`.
  - `total_pipeline_value`: summed current deal value only for `is_active = true`, but did not exclude `on_hold = true`.
  - `total_awarded_value`: summed any positive `awarded_amount`, without active or On Hold filtering.
- Fix:
  - `total_pipeline_value` now sums only `is_active = true AND COALESCE(on_hold, false) = false`.
  - `total_awarded_value` now sums only `is_active = true AND COALESCE(on_hold, false) = false AND awarded_amount > 0`.
- Helper decision: this endpoint uses raw `pg` SQL, not Drizzle `SQL`, so the On Hold predicate is duplicated inline rather than routing through `aliasedEffectiveDealValueSql`.
- Scope note: test-data exclusion was not added to this endpoint because this PR was explicitly scoped to the On Hold value leak for cross-office pipeline and the prompt said not to change any other aspect of the endpoint. Treat test-data exclusion here as a possible follow-up policy cleanup if leadership wants report-wide test filtering for this endpoint too.

### 2. `POST /api/reports/run`

- Location: `server/src/modules/reports/report-builder-service.ts`, `runReportBuilder()` / `buildFilters()`.
- Current query shape: report-builder SQL uses aliased deal table `d`.
- Existing filters:
  - `COALESCE(d.is_test_data, false) = false`.
  - `aliasedReportableDealFilterSql("d")`, which expands to `COALESCE(d.on_hold, false) = false`.
  - Missing `d.is_active = true`.
- Fix:
  - Added `d.is_active = true` to the base report-builder filter list.
- Helper decision: kept the existing shared On Hold predicate through `aliasedReportableDealFilterSql("d")`; added the missing active predicate inline because no existing helper combines active + non-test + not-held.

### 3. `POST /api/reports/execute`

- Location: `server/src/modules/reports/service.ts`, `executeCustomReport()`.
- Current query shape: custom report SQL with unaliased table names.
- Existing filters for `entity = deals`:
  - `reportableDealFilterSql()`, which expands to `COALESCE(on_hold, false) = false`.
  - Missing `is_active = true`.
  - Missing `COALESCE(is_test_data, false) = false`.
- Fix:
  - Added default `is_active = true`.
  - Added default `COALESCE(is_test_data, false) = false`.
  - Kept the existing shared On Hold predicate through `reportableDealFilterSql()`.

### 4. Rep Dashboard Signed-Contract YTD/MTD

- Location: `server/src/modules/dashboard/service.ts`, `getRepDashboard()` contracts-signed YTD/MTD query.
- Current query shape: tenant `deals` aggregate for the current rep, signed-date bounded to YTD/MTD.
- Existing filters:
  - `assigned_rep_id = userId`.
  - signed date present.
  - signed date not in the future.
  - Missing active/test/On Hold policy.
- Fix:
  - Added `is_active = true`.
  - Added `COALESCE(is_test_data, false) = false`.
  - Added existing shared On Hold predicate via `aliasedActiveDealCountFilterSql("deals")`, which expands to `COALESCE(deals.on_hold, false) = false`.

## Production Read-Only Verification

Verification was run in a `BEGIN READ ONLY` transaction against `DATABASE_PUBLIC_URL`; no data was modified.

### Dallas

- Cross-office active pipeline:
  - Current predicate: `$287,897,340.16`.
  - Fixed predicate: `$138,173,944.33`.
  - Reduction from excluding On Hold: `$149,723,395.83`.
- Cross-office awarded:
  - Current predicate: `$119,462,772.15`.
  - Fixed predicate: `$33,501,500.46`.
- `POST /api/reports/run` representative row population:
  - Current rows: `794`.
  - Fixed rows: `737`.
  - Removed inactive rows: `57`.
  - Inactive leaked value: `$1,285,345.22`.
- `POST /api/reports/execute` representative deal row population:
  - Current rows: `797`.
  - Fixed rows: `737`.
  - Removed inactive rows: `60`.
  - Test rows present in current population: `3`.
- Rep signed-contract YTD/MTD:
  - Current YTD: `$1,383,212.78`.
  - Fixed YTD: `$1,383,212.78`.
  - Current MTD: `$974,617.00`.
  - Fixed MTD: `$974,617.00`.
  - Current production impact remains `$0`, but the policy predicate is now in place.

### Atlanta / PWAuditOffice

- No affected rows or values were present in the verification query. The code path remains tenant-schema scoped and applies the same predicates per schema.

## Tests

- Passed: `TMPDIR=/private/tmp npx vitest run server/tests/modules/reports/report-builder.test.ts server/tests/modules/reports/service.test.ts server/tests/dashboard-rep-ytd-mtd.test.ts server/tests/modules/admin/cross-office-pipeline-report.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
  - 4 files, 36 tests passed.
- Broad suite command run: `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**' 2>&1 | tail -50`
  - Result: known existing failures, including sandbox/auth `listen EPERM` in `server/tests/modules/auth/dev-auth-production-routes.test.ts`, plus the existing broad-suite rot called out in the task prompt.
- Passed: `npm run typecheck --workspace=server`.
- Passed: `npm run typecheck --workspace=shared`.
- Passed: `npm run build --workspace=shared`.
- Passed: `npm run build --workspace=server`.

## Review Rounds

- Round 1 finding: signed-contract YTD/MTD initially only added the On Hold predicate. Fixed by adding explicit `is_active = true` and `COALESCE(is_test_data, false) = false`.
- Round 2 finding: cross-office pipeline still does not exclude test data. This was not changed because the requested endpoint-specific fix was On Hold value exclusion only, and the prompt explicitly said not to change any other aspect of that endpoint. Documented as residual follow-up risk.

## Scope Confirmation

- Deals-board pipeline code was not touched.
- No endpoint response shapes or parameters were changed.
- No data writes, migrations, or schema changes were introduced.
