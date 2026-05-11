# Deals Restore Discovery

Date: 2026-05-10 very late
Branch: `feat/deals-restore-decorated-layout`

## Inputs Read

- `/tmp/deals-revert-discovery.md`
- `/tmp/preview-deals-discovery.md`
- `/tmp/deals-baseline.tsx`
- `client/src/pages/deals/deal-list-page.tsx`
- `client/src/preview/deals-preview.tsx`
- `client/src/components/deals/kanban-deal-card.tsx`
- `client/src/components/deals/kanban-scroll-column.tsx`
- `client/src/components/deals/deals-list-section.tsx`
- `client/src/lib/canonical-deal-board.ts`
- `client/src/pages/pipeline/pipeline-page.tsx` for `DealsListSection` usage only

## Confirmed Current State

- `/deals` route is already direct-mounted through `DealListPage`; no `App.tsx` change is needed.
- `deal-list-page.tsx` currently hard-filters `buildCanonicalDealBoardColumns(...)` down to five slugs via `DEAL_BOARD_STAGE_SLUGS`.
- Current `/deals` cards use the compact shared `KanbanDealCard`.
- Current `/deals` keeps a fixed-height board shell, top scrollbar proxy, board search input, `useDealBoard`, and `usePipelineStages("deal")`.
- Current `/deals` has no list below the kanban.
- `buildCanonicalDealBoardColumns` already returns eight canonical deal stages by default through `getDealBoardStageSlugs()`.
- `DealsListSection` is page-based and already handles deal-family stages internally with `usePipelineStages("deal")`; it has no `workflowFamily` or `searchPlaceholder` prop today.

## Implementation Plan

1. Add failing page tests for the locked spec:
   - eight canonical columns appear
   - decorated card content appears, including project-number/fallback, avatar/company, SLA, location
   - `DealsListSection` is rendered below the board with export enabled, date filters disabled, scope/page size passed
   - no Board/Map toggle or `/deals` date filter UI
2. Add minimal `DealsListSection` props needed for the locked `/deals` call:
   - optional `workflowFamily` defaulting to `"deal"` so existing `/pipeline` behavior is unchanged
   - optional `searchPlaceholder` defaulting to the current placeholder
3. Create a `/deals`-only `DecoratedKanbanCard` component rather than changing the compact `KanbanDealCard` used by `/pipeline`.
4. Remove the five-column filter in `deal-list-page.tsx` and let canonical columns render all eight stages.
5. Use `DecoratedKanbanCard` inside the existing `KanbanScrollColumn` shell so the column scroll cap and top scrollbar proxy are preserved.
6. Add `DealsListSection` below the fixed-height kanban shell with:
   - `workflowFamily="deal"`
   - `scope={scope}`
   - `enableExport`
   - `enableDateFilter={false}`
   - `pageSize={20}`
   - `searchPlaceholder="Search deals or accounts"`
7. Leave `/pipeline`, backend, route config, sidebar, and shared kanban scroll behavior untouched.
