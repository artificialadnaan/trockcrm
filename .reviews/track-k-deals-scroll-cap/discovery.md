# Track K — /deals Page Scroll Cap + List View — Discovery

## Current State (post Track J merge, pre Track J-FIX)

### Routes
- `/deals` → `DealListPage` (`client/src/pages/deals/deal-list-page.tsx`, 384 lines)
- `/deals/board` → `BoardAliasRedirect entity="deals"` → `Navigate to /deals` (NOT to /pipeline; it's a same-route alias)
- `/deals/stages/:stageId` → `DealStagePage` (separate stage workspace)
- `/pipeline` → `PipelinePage` (`client/src/pages/pipeline/pipeline-page.tsx`, 1023 lines)

### /deals (current)
- Renders inline `BoardColumn` + `DealCard` components (defined in deal-list-page.tsx).
- Cards show `dealNumber` (HS-…) in monospace, NO project_number.
- Columns have `min-h-[32rem]` + `overflow-y-auto` body — already partially scroll-capped, but no sticky header behavior, no overflow fades, no max-height (so they grow with content rather than capping at ~10 cards).
- The page has no full list view — only a "Recent deal movement" section showing `deals.slice(0, 6)`.
- Outer board container uses `overflow-x-auto p-4` with no max-height — page itself can scroll.

### /pipeline (post Track J)
- Inline `DroppableColumn` (~75 lines) — sticky header, internal `overflow-y-auto` cards body, top/bottom overflow fades, terminal date filter UI when stage is won/lost.
- Inline `PipelineCard` (~65 lines) — DnD draggable, project_number prominent (red text) with dealNumber muted fallback via `getDealDisplayNumber`.
- `PipelineStageTable` (already extracted to `client/src/components/pipeline/pipeline-stage-table.tsx`) — paginated table.
- Has full list view section with search, owner select, date filter (TerminalDateFilterControl), stage chips, sortable columns, pagination.

### Hook & Type
- `Deal.projectNumber?: string | null` — already on Deal type (line 90 of `client/src/hooks/use-deals.ts`).
- `Deal.companyName?: string | null` — already on Deal type (line 98).
- `useDeals` returns paginated deals via `/deals` API with `page` + `limit` + `total` + `totalPages`.

## Component Extraction Plan

Create three reusable components in `client/src/components/deals/`:

1. **`kanban-deal-card.tsx`** — Pure visual card with project_number prominent + fallback styling.
   - Props: `deal`, `onClick`, `dragHandle?: ReactNode`, `isDragging?: boolean`, `className?`.
   - Used by /pipeline (wrapped in `useDraggable`) and /deals (plain click-through).

2. **`kanban-scroll-column.tsx`** — Pure visual column shell.
   - Sticky header slot + scrollable body slot with top/bottom overflow fades.
   - Props: `header: ReactNode`, `children`, `className?`, `bodyClassName?`, `outerRef?`.
   - Used by /pipeline (wrapped in `useDroppable` + terminal date filter UI inside header) and /deals (plain header).

3. **`deals-list-section.tsx`** — Self-contained paginated list section.
   - Encapsulates search, stage chips, owner select, optional global date filter, sortable columns, pagination, optional CSV export.
   - Props: `scope?`, `enableDateFilter?: boolean` (default false), `enableExport?: boolean` (default false), `title?`, `eyebrow?`.
   - Internally uses `useDeals` + `useTaskAssignees` + `usePipelineStages` (or computes stage list from board, but cleaner to use config hook). Renders via `PipelineStageTable`.

## /pipeline Refactor (regression risk)
- Replace `DroppableColumn` body with `KanbanScrollColumn` (keep DnD wrapper around it for `setNodeRef`/`isOver`).
- Replace `PipelineCard` visual chunk with `KanbanDealCard` (keep DnD draggable wrapper).
- Replace inline list section JSX with `<DealsListSection enableDateFilter enableExport />`.
- Keep terminal date filter chips inside the column header slot.

## /deals Refactor
- Remove inline `DealCard` and `BoardColumn` definitions.
- Replace board with `KanbanScrollColumn` + `KanbanDealCard` per stage column.
- Wrap kanban in fixed-height container (`h-[min(72vh,56rem)] min-h-[42rem]`) so kanban content doesn't scroll the page.
- Replace "Recent deal movement" with `<DealsListSection />` (no date filter, no export).
- Do NOT add terminal date filter chips on columns.
- Do NOT add a redirect.

## Backend
- `getDeals` already returns `projectNumber`, `companyName` (Track J added). No backend changes needed.
- `deals/pipeline` (board) already returns deals with `projectNumber` (used by /deals via `useDealBoard`).

## Track J-FIX Coordination
- `fix/deals-pipeline-consistency` worktree at `4eeef51` — same SHA as main; no commits yet. Likely still in flight.
- Pre-push: `git fetch origin && git rebase origin/main` and resolve any conflicts on `pipeline-page.tsx` / `service.ts`.

## Files To Modify
- `client/src/components/deals/kanban-deal-card.tsx` (new)
- `client/src/components/deals/kanban-scroll-column.tsx` (new)
- `client/src/components/deals/deals-list-section.tsx` (new)
- `client/src/pages/pipeline/pipeline-page.tsx` (refactor to use shared)
- `client/src/pages/deals/deal-list-page.tsx` (replace inline + add list section)
- Tests: `kanban-deal-card.test.tsx`, `kanban-scroll-column.test.tsx`, `deals-list-section.test.tsx`
