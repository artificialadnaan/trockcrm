# Won Summary KPI Fix Report

Worktree: `/Users/adnaaniqbal/Developer/trockcrm/.worktrees/fix-won-summary-card-65m`

Branch: `fix/won-summary-card-65m`

## Diagnosis Re-confirmed

I read the prior discovery report at:

`/Users/adnaaniqbal/Developer/trockcrm/.worktrees/disco-won-summary-card-65m/.reviews/won-summary-card-65m/report.md`

Current `origin/main` still matched the diagnosis:

- `/deals` uses `useDealBoard()` to fetch `/api/deals/pipeline`.
- The Kanban columns render from canonicalized `pipelineColumns` through `buildCanonicalDealBoardColumns()`.
- The top Won KPI card was reading `board.terminalStages` instead of the same canonical column the Kanban renders.

Current `origin/main` no longer has a separate top-level Lost KPI card in `client/src/pages/deals/deal-list-page.tsx`. Lost exists as a Kanban terminal column and date-filtered stage, not as one of the three top summary cards. I added the reusable terminal metric helper for both `won` and `lost`, and covered both in tests, but only the existing Won KPI render path required a UI data-source change.

## Code Change

File: `client/src/pages/deals/deal-list-page.tsx`

Added a canonical terminal metric helper at lines `594-602`:

```ts
export function getCanonicalTerminalMetric(columns: DealBoardColumn[], stageSlug: TerminalOutcome) {
  const column = columns.find((item) => item.stage.slug === stageSlug);

  return {
    count: column?.count ?? 0,
    totalCount: column?.totalCount ?? column?.count ?? 0,
    totalValue: column?.totalValue ?? 0,
  };
}
```

Before, the Won KPI value summed `board.terminalStages`:

```ts
const wonValue =
  board?.terminalStages
    ?.filter((terminal) => terminal.stage.slug === "won")
    .reduce((sum, terminal) => sum + (terminal.totalValue ?? 0), 0) ?? 0;
```

After, the Won KPI reads the canonical Won column from `boardColumns`, the same source family used by the Kanban:

```ts
const wonMetric = getCanonicalTerminalMetric(boardColumns, "won");
const wonValue = wonMetric.totalValue;
```

This is client-only. No server endpoint, API contract, or response shape changed.

## Kanban Path Mirrored

`client/src/lib/canonical-deal-board.ts` canonicalizes backend columns:

- It maps raw columns by canonical stage slug.
- For each canonical stage, it exposes `count` and `totalValue`.
- The `/deals` Kanban column renders those fields.

The summary helper now reads the same fields:

| Summary field | Canonical column source |
| --- | --- |
| `count` | `column.count` |
| `totalCount` | `column.totalCount ?? column.count` |
| `totalValue` | `column.totalValue` |

## Multi-tenant Safety

The fix does not introduce office/schema logic. It consumes the already-scoped `/api/deals/pipeline` response after the existing client canonicalization step:

1. Server applies tenant/scope/office filtering.
2. Client `useDealBoard()` receives `pipelineColumns`.
3. `buildCanonicalDealBoardColumns()` canonicalizes those scoped columns.
4. The Won KPI now reads the canonical Won column from that same scoped result.

Therefore it follows the same behavior as the Kanban column for one office, all-office views, and filtered scopes. It no longer separately sums `terminalStages`, which was the divergent path behind the 3x display.

## Test Coverage

Updated `client/src/pages/deals/deal-list-page.test.tsx`:

- Added a regression test where `terminalStages` contains three duplicated Won aggregates but the canonical Won column contains the correct single aggregate. The Won KPI renders `$21.7M` and not `$65.1M`.
- Added direct coverage that `getCanonicalTerminalMetric()` maps both `won` and `lost` from canonical columns.
- Updated existing Won KPI tests so they include canonical Won columns and verify the KPI no longer trusts aggregate-only `terminalStages`.
- Preserved the date-filter behavior test: the Won card still keeps its link and caption behavior, while the board request receives the same effective won date range.

## Verification

Passed:

```bash
npm run build --workspace=shared
npm run typecheck --workspace=client
npm run build --workspace=client
git diff --check
TMPDIR=/private/tmp npx vitest run client/src/pages/deals/deal-list-page.test.tsx --testNamePattern 'canonical|aggregate-only terminal|effective won date' --testTimeout=15000 --exclude '.worktrees/**'
```

Targeted full file:

```bash
TMPDIR=/private/tmp npx vitest run client/src/pages/deals/deal-list-page.test.tsx --testTimeout=15000 --exclude '.worktrees/**'
```

Result: new/changed tests passed. The file still has two existing unrelated failures:

- `excludes terminal-stage cards from the Active Pipeline value and count`
- `passes dashboard active-pipeline drill-down props into the embedded deals list`

Requested broad command:

```bash
TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**' 2>&1 | tail -50
```

Result: failed in the known unrelated suite areas, including sandbox/auth `listen EPERM` in `server/tests/modules/auth/dev-auth-production-routes.test.ts`. The prompt listed these broad-suite failures as pre-existing and unrelated.

## Review

One subagent code review pass completed. Result: no findings.

## Deployment Verification

After deployment, open `/deals?scope=all`. The Won summary card should match the Won Kanban column from the same `/api/deals/pipeline` response. Based on recent production data, that should be about `294 / $21.7M`, not the previous 3x `882 / $65.1M`.

