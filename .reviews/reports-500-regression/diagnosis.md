# Reports 500 Regression — Diagnosis

Date: 2026-05-11
Worktree: `/Users/adnaaniqbal/projects/trockcrm-reports-500-fix`
Branch: `fix/reports-500-regression`
Base: `origin/main` @ `afb5761`

## Reproduction

Production logs pulled from Railway API service confirm 500s on all four endpoints.
Underlying PostgreSQL errors were reproduced directly against
`DATABASE_PUBLIC_URL` (`postgresql://...@trolley.proxy.rlwy.net:30423/railway`)
with `search_path` set to `office_dallas, public`.

The earlier brief assumed Pipeline Velocity / Closed Won Revenue / Lead
Conversion were pre-existing Tier 1 reports. They are not: `sales-tier1-service.ts`
was first introduced by commit `5b54d12` (PR #241, sales tier 1 feature),
so these three endpoints have never returned a successful response in
production. Likewise, Director Scorecard's `risks` subquery was introduced
by commit `991efcb` (PR #239, performance tier 2) and was never exercised
by the post-merge smoke (the existing
`.reviews/reports-performance-tier2/` review folder has no `smoke.md`).
The label "regression" still fits — these endpoints currently 500 in
production — but the underlying defects landed on first-merge of #239 and
#241, not in a later shared-helper edit.

## Per-report root cause

### 1. Pipeline Velocity — `GET /api/reports/pipeline-velocity`

- Failing query: `getPipelineVelocityReport` stage rollup
  (`server/src/modules/reports/sales-tier1-service.ts:497-499`).
- PG error: `function max(uuid) does not exist`.
- Cause: the CTE selects `d.id` (uuid) into `id`, then the outer SELECT
  does `MAX(id) FILTER (WHERE rn = 1)::text AS "oldestDealId"`.
  PostgreSQL has no `max(uuid)` aggregate — the cast happens *after*
  aggregation, so `MAX` is called on a uuid argument.
- Reproduction:
```
  SET search_path TO office_dallas, public;
  ...WITH open_deals AS (SELECT d.id, ...), ranked AS (... ROW_NUMBER() ...)
  SELECT MAX(id) FILTER (WHERE rn = 1)::text AS "oldestDealId" FROM ranked;
  -- ERROR:  function max(uuid) does not exist
```
- Introduced by: `5b54d12` (PR #241).

### 2. Closed Won Revenue — `GET /api/reports/closed-won-revenue`

- Failing query: `getClosedWonRevenueReport` ownerRows aggregation
  (`server/src/modules/reports/sales-tier1-service.ts:595`).
- PG error: `function max(uuid) does not exist`.
- Cause: same pattern — CTE produces `d.id` (uuid), outer SELECT does
  `MAX(id) FILTER (WHERE rn = 1)::text AS "largestWonDealId"`.
- Introduced by: `5b54d12` (PR #241).

### 3. Lead Conversion — `GET /api/reports/lead-conversion`

- Failing query: `getLeadConversionReport` summaryRows + sourceRows
  (`server/src/modules/reports/sales-tier1-service.ts:682,700`).
- PG error: `invalid input value for enum lead_status: "qualified"`.
- Cause: the FILTER clause references `l.status IN ('qualified', 'converted')`,
  but the `lead_status` enum has exactly three labels:
  `open`, `converted`, `disqualified`. `'qualified'` is not a valid
  enum value, so the cast fails before any row is read.
- The intent — "qualified or converted" — is already captured by the
  preceding predicates (`l.converted_at IS NOT NULL OR
  l.qualification_completed_at IS NOT NULL`). The status check should
  simply drop the missing `'qualified'` literal and keep `'converted'`
  as a belt-and-suspenders signal.
- Introduced by: `5b54d12` (PR #241).

### 4. Director Scorecard — `GET /api/reports/director-scorecard`

- Failing query: `getDirectorScorecard` risks subquery (index 1 of the
  `Promise.all` — `server/src/modules/reports/performance-tier2-service.ts:339`).
- PG error: `column t.responsible_user_id does not exist`.
- Cause: the overdue-tasks subquery joins `tasks t` and then does
  `LEFT JOIN users u ON u.id = t.responsible_user_id`. The `tasks`
  table has no `responsible_user_id` column — the actual assignee
  column is `assigned_to`. (Compare with `activities`, which *does*
  have `responsible_user_id`; this looks like a column-name copy-paste
  from the activity-scope SQL.)
- Introduced by: `991efcb` (PR #239).

## Shared theme

These are four independent SQL defects in two service files, not a
single shared-helper regression. Each is reproducible directly against
the production database with the exact prepared statement Drizzle emits.
No data-state issue, no migration backfill issue — the SQL is wrong as
written.

## Proposed fix approach

1. **`MAX(uuid)` (Pipeline Velocity, Closed Won Revenue):**
   replace `MAX(id) FILTER (WHERE rn = 1)::text` with
   `(array_agg(id::text) FILTER (WHERE rn = 1))[1]`. This preserves the
   "pick the row where `rn = 1`" semantic exactly (rn = 1 per partition
   guarantees a single row, so the array has one element) without
   requiring a `max` aggregate. The same shape is applied to the deal
   name column for consistency.

2. **`lead_status` enum (Lead Conversion):** drop `'qualified'` from
   the IN list. The qualified-or-converted intent stays covered by
   `l.converted_at IS NOT NULL OR l.qualification_completed_at IS NOT NULL`,
   and `l.status = 'converted'` keeps the status-based half intact.

3. **`tasks.responsible_user_id` (Director Scorecard):** change the
   join to `LEFT JOIN users u ON u.id = t.assigned_to`. No other places
   in `performance-tier2-service.ts` reference this column on tasks.

## Regression test plan

One vitest test per failing endpoint, executing the actual SQL through
a Drizzle-compatible mock that captures the prepared statement and
parameters. Each test asserts:

- the generated SQL does **not** contain the broken token
  (`max(id)`, `'qualified'` in a `lead_status` context,
  `t.responsible_user_id`); and
- a positive marker for the fix (the `array_agg(... :: text)` form, or
  `t.assigned_to`).

Tests live next to the existing service tests
(`sales-tier1-service.test.ts`, `performance-tier2-service.test.ts`).
They would have caught all four defects: each is a static SQL property.

## Deploy / rollback

Code-only change in two service files plus their unit tests. No
migration. Rollback is a pure git revert.
