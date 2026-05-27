# Lost Terminal TotalValue Source Fix

## Investigation Findings

`GET /api/deals/pipeline` is routed in `server/src/modules/deals/routes.ts` and calls `getDealsForPipeline()` in `server/src/modules/deals/service.ts`.

The terminal-stage `totalValue` for the board summary is produced in `getDealsForPipeline()`:

- `dealPipelineValueSql(...)` builds the per-row value expression.
- The per-stage summary query computes `totalValue` with `COALESCE(SUM(...) FILTER (WHERE countedDealFilter), 0)`.
- `valueByStage` is mapped directly into `terminalStages[].totalValue`.

The stage drill-down endpoint `/api/deals/stages/:stageId` routes through `listDealStagePage()` in the same service. Its summary query computes `total_value` through `workspaceEffectiveDealValueSql(stage)`.

Before this PR, both terminal paths treated every terminal stage as awarded-first:

1. `awarded_amount`
2. `bid_board_total_sales`
3. `bid_estimate`
4. `dd_estimate`

That is correct for Won. The shared effective value logic confirms a genuine Won deal uses awarded-first semantics.

Lost is different. The correct Lost value source matches active-pipeline/current value precedence:

1. `bid_board_total_sales`
2. `bid_estimate`
3. `dd_estimate`
4. `awarded_amount`

This matches `dealBestEstimateSql(...)` on the server and `getEffectiveDealValue(...)` in `shared/src/types/deal-hold.ts` for non-won stages.

Production read-only verification was performed against a representative single-rep Lost view in one office schema. The row set behind the Lost count was already correct; the value source was wrong. Awarded-first produced a materially lower terminal total than the current-value chain, with an undercount in the roughly $5-6M range for that view.

## Implementation

Changed `server/src/modules/deals/service.ts` so both board and drill-down summaries choose the value source through shared helpers:

- `pipelineValueSourceForStageSlug(...)` maps Won terminal slugs to `won` and all other stages, including Lost, to `current`.
- `dealPipelineValueSql(...)` is used by the board summary path.
- `aliasedPipelineValueSql(...)` is used by the drill-down summary path.
- `buildStagePageOrder(...)` now uses that same value-source path for value-based stage-page sorting.
- `won` keeps awarded-first precedence.
- `current` uses active-pipeline/current value precedence.

Inside `getDealsForPipeline()`:

- Won terminal stages use `valueSource = "won"`.
- Lost terminal stages and non-terminal pipeline stages use `valueSource = "current"`.
- The existing `countedDealFilter` remains on the aggregate `FILTER`, so On Hold zeroing/reportable filtering is preserved.

Inside `listDealStagePage()`:

- `workspaceEffectiveDealValueSql(stage)` now calls the same stage-slug value-source helper.
- Lost drill-down totals now use the same current-value chain as the board.
- Won drill-down totals remain awarded-first.
- Lost `value_desc` drill-down sorting now uses the same current-value chain as the Lost drill-down total, with On Hold rows contributing zero to the sort key.
- Won `value_desc` drill-down sorting remains awarded-first and does not use the Lost On Hold zeroing path.

The row set, On Hold handling, date filters, office/rep scoping, and active/reportable count logic were left unchanged. The per-stage loop remains sequential; no `Promise.all` or parallel tenantDb queries were introduced.

## Edge Cases

Lost deals with null/zero current-value fields contribute zero through the existing `COALESCE(CASE WHEN value > 0 THEN value END..., 0)` expression.

Lost deals with no current value but a positive awarded fallback still use awarded as the final fallback, matching active-pipeline/current-value semantics.

On Hold Lost deals remain excluded from `totalValue` by the same active/reportable filters already used for the count.

## Tests

Focused tests:

- `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/board-service.test.ts server/tests/modules/deals/stage-page-service.test.ts server/tests/modules/shared/deal-value-sql.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
- Result: passed, 44 tests.

Added/updated coverage:

- Lost board and stage drill-down totals use the same current-value precedence for the same synthetic deal set.
- Lost stage drill-down `value_desc` sorting uses the current-value contribution order, not awarded-first order.
- The same synthetic Lost set now checks board total, stage summary total, sorted row order, and summed sorted-row contributions together.
- Won board totals remain awarded-first.
- Won drill-down totals remain awarded-first.
- Won stage drill-down `value_desc` sorting remains awarded-first.
- Lost null/zero values contribute zero.
- Lost awarded-only deals still use awarded as the final current-value fallback.
- On Hold Lost rows remain zeroed/excluded consistently.

Build/typecheck:

- `npm run build --workspace=shared`: passed.
- `npm run typecheck --workspace=server`: passed.
- `npm run build --workspace=server`: passed.

Full requested suite:

- `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'`
- Outside sandbox: failed with 22 failed files, 83 failed tests, 505 passed files, 3961 passed tests.

The outside-sandbox failed file/test count matches the current baseline: 22 failed files and 83 failed tests. The passed-test count increased because this fix adds targeted coverage. The failing buckets remain pre-existing/unrelated, including `deal-list-page.test.tsx`, `deal-scoping-workspace.test.ts`, `detail-page-shell.test.tsx`, `kanban-deal-card.test.tsx`, lead form/service mock-shape failures, properties list/detail consistency tests, sales-review service, report-builder SQL quoting expectations, password-change, and dashboard route expectations.

## Review Rounds

Round 1: Descartes reviewed the original service and board tests. No findings. Residual risk: SQL-shape/mock tests were not DB-backed.

Fix after Round 1: added shared JS value-semantics assertions in `server/tests/modules/shared/deal-value-sql.test.ts` for Lost current-value precedence, awarded fallback, null/zero value contribution, and On Hold zeroing.

Round 2: Rawls reviewed the expanded diff. No findings. Noted `/api/deals/stages/:stageId` had separate terminal value logic.

Round 3: Carver performed final scope/regression review on the original PR. No findings for the board path. The later Codex PR review correctly identified the stage drill-down value-source drift fixed here.

Fix-review round 1: James reviewed the second fix diff. No findings. Confirmed Lost board and drill-down route through the same value-source selector, Won stays awarded-first in both paths, null/zero and On Hold handling remain intact, and this report no longer contains the targeted named office schema, named rep, exact production totals, or exact production counts.

Fix-review round 2: Dewey reviewed the stage-page sort fix. No findings. Confirmed Lost `value_desc` routes through `workspaceEffectiveDealValueSql(stage)`, the drill-down total uses the same expression, Won `value_desc` remains awarded-first, the Lost sort-vs-total test would fail under the old awarded-first sort, and the report remains sanitized.

## Sanitization

This report no longer contains named office schemas, named reps, exact production counts, or exact production financial totals. The retained production note is limited to the technical shape of the bug and a coarse undercount magnitude.
