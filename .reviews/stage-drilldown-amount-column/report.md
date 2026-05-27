# Stage Drill-Down Amount Column

## Investigation

Stage drill-down page:

- Component: `client/src/pages/deals/deal-stage-page.tsx`
- Data hook: `useDealStagePage()` in `client/src/hooks/use-deals.ts`
- API consumed: `/api/deals/stages/:stageId`
- Row renderer: `PipelineStageTable` in `client/src/components/pipeline/pipeline-stage-table.tsx`
- Current columns before this change: Deal, Number, Sales rep, Workflow, Age, Updated

Value-source confirmation:

- The page header total is returned by `listDealStagePage()` in `server/src/modules/deals/service.ts`.
- The header total uses `workspaceEffectiveDealValueSql(stage)`, which applies the same stage-aware value precedence and on-hold zeroing used by the board/drill-down consistency work.
- The row payload does not expose a dedicated `value` field, but it already includes the fields needed to compute the same value client-side: `awardedAmount`, `bidBoardTotalSales`, `bidEstimate`, `ddEstimate`, `onHold`, `stageSlug`, and `workflowRoute`.
- No API response shape or server value-source logic was changed.

Formatting helper:

- Reused `formatCurrency()` from `client/src/lib/deal-utils.ts`.
- Reused `getEffectiveDealValue()` from `@trock-crm/shared/types` so the rendered row amount follows the same client value semantics used elsewhere in deal cards and lists.

## Change

Added an `Amount` column to `DealStagePage`:

- Positioned on the right side of the row set, between Workflow and Age.
- Header and cells are right-aligned.
- Cells use tabular numerals and stronger font weight for scanability.
- Value is computed from the existing row object with `getEffectiveDealValue(row)` and formatted with `formatCurrency(...)`.
- `PipelineStageTable` already renders semantic table headers through `TableHead` (`th`) and horizontal overflow through the shared table wrapper, so no custom ARIA or mobile wrapper was needed.

## Sorting

No sort logic was changed.

The existing route/query path still passes `sort=value_desc` through `useNormalizedStageRoute()` and `useDealStagePage()`, and the server still owns row ordering. The new column renders rows in the API-provided order.

## Tests

Updated `client/src/pages/deals/deal-stage-page.test.tsx`:

- Asserts the `Amount` column renders.
- Asserts each row renders the expected formatted amount.
- Covers current-value precedence for active/open rows.
- Covers won-stage awarded-first precedence.
- Covers null/no-value rows rendering as `$0`.
- Checks right-aligned header/cell classes.
- Checks `value_desc` route sort is passed through and API row order is preserved.

## Review

One subagent code review completed.

- Finding: no blocking issues.
- Residual note: add explicit won-stage awarded-first coverage.
- Fix applied: added a won-stage test where `awardedAmount` wins over a larger `bidBoardTotalSales`.

## Verification

- `npm run build --workspace=shared`: passed immediately after pulling and again after changes.
- `TMPDIR=/private/tmp npx vitest run client/src/pages/deals/deal-stage-page.test.tsx --testTimeout=15000 --exclude '.worktrees/**'`: passed, 7 tests.
- `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**' 2>&1 | tail -50`: broad suite still reports known existing rot; tail showed sandbox `listen EPERM: operation not permitted 0.0.0.0` in `server/tests/modules/auth/dev-auth-production-routes.test.ts`, with 47 failed files / 324 failed tests.
- `npm run typecheck --workspace=client`: passed.
- `npm run typecheck --workspace=server`: passed.
- `npm run typecheck --workspace=shared`: passed.
- `npm run build --workspace=server`: passed.
- `npm run build --workspace=client`: passed with existing Vite chunk/dynamic-import warnings.
