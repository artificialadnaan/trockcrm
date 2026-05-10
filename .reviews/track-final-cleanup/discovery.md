# Track Final Cleanup Discovery

Date: 2026-05-10
Worktree: `/Users/adnaaniqbal/projects/trockcrm-final-cleanup`
Branch: `fix/final-cleanup`

## Baseline Drift

- Prompt baseline expected `origin/main` at `0c6be74` after PR #223.
- After `git fetch origin`, `origin/main` is `bb64f06`, with PR #224 and PR #222 already merged:
  - `dba9732` Merge PR #224, removing embedded list section from `/deals`.
  - `bb64f06` Merge PR #222, pipeline terminal stage scoping follow-up.
- `gh pr close 222` and `gh pr close 224` both failed because GitHub reports they were already merged.

## App Routing

- `client/src/App.tsx` still defines `DealsToPipelineRedirect`, returning `<Navigate to={{ pathname: "/pipeline", search, hash }} replace />`.
- `/deals` still mounts `DealsToPipelineRedirect`.
- `/deals/:id`, `/deals/:id/photos`, `/deals/:id/edit`, `/deals/new`, and `/deals/stages/:stageId` remain separate routes.

## /deals Page

- `client/src/pages/deals/deal-list-page.tsx` renders:
  - Header and New Deal action.
  - KPI cards: Active pipeline, Won YTD, At risk.
  - Scope toggle from `scope` query param via `getScope`.
  - Kanban section using shared `KanbanScrollColumn` and `KanbanDealCard`.
- The embedded `DealsListSection` has already been removed by merged PR #224.
- No search input is currently rendered on `/deals`; prompt expects one in the final layout.
- Top scrollbar proxy `useLayoutEffect` sizes the spacer from `main.scrollWidth`, observes the main scroll container and current children, but only depends on `[columns.length]`. It can run while loading UI has no refs and not rerun reliably after the board mounts.

## Pipeline Service

- `server/src/modules/deals/service.ts` defines terminal alias constants:
  - Won: `won`, `sent_to_production`, `service_sent_to_production`, `closed_won`.
  - Lost: `lost`, `production_lost`, `service_lost`, `closed_lost`.
- `getDealsForPipeline` derives:
  - `canonicalWonStageId`: active stage with slug `won`.
  - `canonicalLostStageId`: active stage with slug `lost`.
- Current response stages hide aliases when canonical terminal stages exist.
- Current terminal queries use `eq(deals.stageId, canonicalWonStageId ?? stage.id)` and `eq(deals.stageId, canonicalLostStageId ?? stage.id)`.
- This undercounts legacy alias rows when canonical terminal stages exist.
- Existing tests currently assert the undercount behavior, so they need to be updated to the corrected contract.

## /pipeline Page

- `client/src/pages/pipeline/pipeline-page.tsx` renders full board and embedded `DealsListSection`.
- `DealsListSection` currently receives `visibleStages` from the rendered pipeline columns.
- Show DD changes board columns via request path, but no explicit list-section prop exists for excluding DD stage chips beyond whatever visible columns were passed.
- Pipeline re-exports list-section helpers for tests.

## DealsListSection

- `usePipelineStages()` is called with no workflow family, so lead-family stages can appear in filter chips when `visibleStages` is not supplied.
- Local `page` state is initialized once and not reset on parent `scope` prop changes.
- Stage chip options de-dupe by slug and keep only one stage ID per slug.
- Selecting a shared-slug chip sends one `stageIds` value, dropping matching stage IDs from alternate workflow families.
- `getPipelineListQueryState` disables the query whenever stages are loading or errored, even when a selected non-terminal stage ID can safely use `isActive=true`.

## Shared Kanban Components

- `client/src/components/deals/kanban-scroll-column.tsx` provides the vertical scroll cap and overflow fades. It is reused by both boards and should stay unchanged.
- `client/src/components/deals/kanban-deal-card.tsx` provides project-number display and card presentation. It is reused by both boards and should stay unchanged.

## Implementation Focus

- Remove `/deals` redirect and mount `DealListPage` directly.
- Keep `/deals` board-only; do not add a list view or terminal date filters.
- Fix top scrollbar proxy sizing to rerun after loading to board mount.
- Fix terminal service queries to use canonical plus alias stage IDs when canonical terminal stages exist, while preserving per-alias scoping when no canonical exists.
- Fix `DealsListSection` stage family, query enablement, pagination reset, DD exclusion, and shared-slug ID grouping.
