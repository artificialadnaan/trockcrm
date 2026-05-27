# Pipeline Terminal Total Fix Report

## Investigation

Endpoint: `GET /api/deals/pipeline`, routed in `server/src/modules/deals/routes.ts`, calls `getDealsForPipeline()` in `server/src/modules/deals/service.ts`.

For each stage, `getDealsForPipeline()` builds one shared `where` clause from:

- stage membership
- terminal-stage date filters (`won_*` / `lost_*`)
- rep/team/mine scope filters
- tenant-scoped `tenantDb`
- estimate-sent filters where applicable

Before this fix, terminal summary fields were computed as:

- `totalCount`: `count(*)` over the shared `where` row set.
- `activeCount`: `count(*) filter (where aliasedActiveDealCountFilterSql("deals"))`, currently reportable means `on_hold = false`.
- returned `count`: mapped from `activeCount`.
- `totalValue`: `SUM(effectiveDealValueSql(isTerminalStage))`, where `effectiveDealValueSql` used a `CASE WHEN deals.on_hold THEN 0 ELSE raw_value END`.

That meant `activeCount`/`count` and `totalValue` did not mechanically share the exact same aggregate predicate. `totalValue` zeroed held rows inside the expression, while `activeCount` filtered the aggregate to reportable rows. With the current reportable rule these are numerically close in simple cases, but they can drift if the reportable predicate expands beyond `on_hold`, and the query shape made the count/value pairing harder to reason about.

Production read-only check for the reported Derek Barr Lost shape in `office_dallas` confirmed:

- `totalCount`: 47
- `activeCount` / returned `count`: 19
- effective value under the pre-fix value expression: `$10,024,067.57`
- raw value without hold zeroing: `$15,832,158.55`

`totalCount` is intentionally broader: it remains the all-time row count for the terminal stage under the stage/scope filters. The matched pair that must agree is `count`/`activeCount` and `totalValue`.

## Fix

`totalValue` now uses the same reportable predicate as `activeCount`:

- `activeCount`: `count(*) filter (where countedDealFilter)`
- `totalValue`: `COALESCE(SUM(raw_pipeline_value) FILTER (WHERE countedDealFilter), 0)`

The raw pipeline value still preserves the prior terminal/non-terminal value source:

- terminal stages: awarded-first value with bid-estimate fallback
- non-terminal stages: best-estimate value

The terminal date filters remain in the shared `where` clause, so the value aggregation is constrained by the same terminal date range as `count`/`activeCount`. `totalCount` semantics were left unchanged.

This applies to all terminal stages, including Won and Lost. Non-terminal totals are behaviorally equivalent for the current reportable predicate, but now use the same aggregate-filter style for consistency.

## Tests

Targeted:

- `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/board-service.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
- Result: passed, 17 tests.

Added/updated coverage:

- Lost terminal summary SQL applies the same on-hold/reportable filter to `activeCount` and `totalValue`.
- Won terminal summary SQL applies the same on-hold/reportable filter to `activeCount` and `totalValue`.
- Terminal `totalValue` changes when the terminal date range changes.
- Existing on-hold-aware pipeline total test updated for aggregate `FILTER` SQL shape.

Full requested suite:

- `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**' 2>&1 | tail -50`
- Result: failed in the known broad-suite environment failure class. Tail showed `listen EPERM: operation not permitted 0.0.0.0` from auth/dev-server tests, with many cascading failures. Treated as pre-existing/non-regression per task instructions.

Typecheck/build:

- `npm run typecheck --workspace=server && npm run typecheck --workspace=shared`: passed.
- `npm run typecheck --workspace=client`: passed.
- `npm run build --workspace=server && npm run build --workspace=shared`: passed.
- `npm run build --workspace=client`: passed, with existing Vite chunk/dynamic-import warnings only.

## Reviews

Three subagent review rounds completed:

1. Round 1: no findings. Verified `activeCount` and `totalValue` share `countedDealFilter`, terminal date predicates remain in the summary `WHERE`, and non-terminal behavior is equivalent under the current reportable predicate.
2. Round 2: no findings. Verified `totalCount` stays unchanged, count/value semantics are aligned, and tests cover the intended SQL shape/date behavior at unit level.
3. Round 3: no findings. Verified scope is limited to the pipeline aggregate and tests, no `Promise.all` was introduced on tenantDb, and no unrelated surfaces were changed.

Residual risk: coverage is unit/mock SQL-shape based rather than a DB-backed integration aggregate over mixed terminal rows. The generated query shape is now explicit and simpler: the same reportable predicate drives both the counted rows and the value sum.
