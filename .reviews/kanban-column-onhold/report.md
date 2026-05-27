# Kanban Column On-Hold Total Guard Report

## Server-side finding

- Deals page board data comes from `GET /api/deals/pipeline` in `server/src/modules/deals/routes.ts`, which calls `getDealsForPipeline()` in `server/src/modules/deals/service.ts`.
- `getDealsForPipeline()` computes each column summary in sequential per-stage tenant queries. This preserves the production tenantDb single-client transaction constraint; no parallel query fan-out was introduced.
- The server-provided `column.totalValue` already excludes On Hold deals. The summary query uses `COALESCE(SUM(${effectiveDealValueSql(isTerminalStage)}), 0)`, and `effectiveDealValueSql()` returns `CASE WHEN deals.on_hold THEN 0 ELSE <effective value> END`.
- Existing server coverage in `server/tests/modules/deals/board-service.test.ts` verifies that the filtered board total SQL is On-Hold-aware and includes the expected effective-value sources.

## Client fixes

- `client/src/pages/deals/deal-list-page.tsx`
  - Added `sumNonOnHoldDealValues()` to make the value filter explicit and shared.
  - Updated the `DealsBoardColumn` fallback from `column.cards.reduce(...)` to `sumNonOnHoldDealValues(column.cards)`.
  - Updated the at-risk, search-filtered, and unsearched at-risk `totalValue` recomputations to use the same `!deal.onHold` filter basis as the visible count.
- `client/src/lib/canonical-deal-board.ts`
  - Updated the missing-backend-aggregate fallback to filter out `deal.onHold` before summing card values. This protects the canonical board projection path before `deal-list-page.tsx` renders columns.
- No changes were made to card display, `totalCount`, terminal date filters, server read behavior, or migration/script paths.

## Test results

- Required initial build:
  - `npm run build --workspace=shared`
  - Passed.
- Focused On-Hold verification:
  - `TMPDIR=/private/tmp npx vitest run client/src/lib/canonical-deal-board.test.ts server/tests/modules/deals/board-service.test.ts client/src/pages/deals/deal-list-page.test.tsx -t "excludes on-hold|on-hold-aware value SQL|sums only non-on-hold" --testTimeout=15000 --exclude '.worktrees/**'`
  - Passed: 3 files, 5 tests.
- Relevant full file verification:
  - `TMPDIR=/private/tmp npx vitest run client/src/lib/canonical-deal-board.test.ts server/tests/modules/deals/board-service.test.ts client/src/pages/deals/deal-list-page.test.tsx --testTimeout=15000 --exclude '.worktrees/**'`
  - `canonical-deal-board.test.ts` passed.
  - `board-service.test.ts` passed.
  - `deal-list-page.test.tsx` still has the known pre-existing failures in that file; the new On-Hold tests passed.
- Required broad command:
  - `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'`
  - Failed with the known broad-suite failure surface: 51 failed files, 331 failed tests, 251 errors. Output included the sandbox/auth `listen EPERM` failures and the known pre-existing deal-list-page failure file, plus unrelated existing server/client failure groups outside this change. The focused On-Hold tests remained passing separately.

## Review rounds

- Round 1: subagent reviewed current diff for server/client On-Hold total correctness and tenantDb constraints. No findings.
- Round 2: subagent reviewed test strength and fallback coverage. Findings fixed:
  - The at-risk test could pass from a card value rather than the column header.
  - The negative assertion used `$550K` while the formatter emits `$550.0K`.
  - The component fallback helper and search-filtered recompute path needed stronger coverage.
- Round 3: subagent reviewed the updated diff, helper export, test reliability, and server finding. No findings.
