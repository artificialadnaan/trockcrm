# Track Final Cleanup Review - Round 2

## P2 Findings

- `client/src/components/deals/deals-list-section.tsx:295-312` still can misclassify a selected terminal chip as non-terminal while stage metadata is loading or errored. `/pipeline` now passes `isTerminal` through `visibleStages` (`client/src/pages/pipeline/pipeline-page.tsx:522-531`), but `terminalStageIds` is still derived only from the separately loaded `stages` array. In a metadata loading/error state, `stages` can be empty while `stageFilterOptions` still knows the selected visible chip is terminal. For a selected Won/Lost chip, `selectedStageStatusKnown` becomes `true`, `hasSelectedTerminalStage` remains `false`, and `getPipelineListQueryState` enables the query with `isActive: true`. That is the same active-only terminal undercount from round 1. The bypass needs to require the selected visible option to be known non-terminal, or `terminalStageIds` needs to include IDs from `stageFilterOptions` whose `isTerminal === true`.

## P1 Findings

- No P1 finding. `server/src/modules/deals/service.ts:1590-1661` now builds canonical Won/Lost ID sets from all deal-family terminal alias slugs without requiring `isActivePipeline`, while `responseStages` still hides inactive terminal aliases and collapses active aliases under canonical Won/Lost when canonical exists. The no-canonical path still renders active alias terminal columns and queries each column by its own `stage.id`.

## Rechecked Areas

- `/deals` now mounts `DealListPage` directly while `/deals/:id` and `/pipeline` remain separate routes.
- `/deals` remains board-only, filters to the expected five canonical deal stages, includes a search input, honors the `scope` query param, and does not embed `DealsListSection`.
- `/pipeline` still preserves the board plus embedded list/export/date-filter surface, and passes DD chip exclusion into `DealsListSection`.
- Stage-chip grouping now keeps multiple IDs for the same slug, and the list page resets pagination on scope changes.

## Verification Notes

- Reviewed the current uncommitted diff only.
- Did not rerun the already reported focused Vitest/typecheck commands.
- Did not investigate broad baseline failures.
