# Track J Deals Pipeline Overhaul Discovery

Date: 2026-05-10
Branch: feat/deals-pipeline-overhaul
Worktree: /Users/adnaaniqbal/projects/trockcrm-deals-overhaul
Base: 3672631 Merge pull request #216 from artificialadnaan/fix/trigger-rfp-races-and-ux

## Preflight

- `origin/main` was fetched and local `main` was fast-forwarded from b95b78c to 3672631.
- Requested worktree was created at `/Users/adnaaniqbal/projects/trockcrm-deals-overhaul`.
- Worktree status is clean on `feat/deals-pipeline-overhaul`.
- `/mnt/skills`, `/mnt/skills/public`, `/mnt/skills/private`, and `/mnt/skills/user` are not present on this machine.
- Repo-local `impeccable` exists at `.agents/skills/impeccable/SKILL.md` and was read.
- `impeccable` context loader passed with product/design context from `PRODUCT.md` and `DESIGN.md`.
- Design principles to apply: dense operational tables/lists, compact controls, brand red only for action/selection, white panels with steel borders, no decorative gradients/glass.

IMPECCABLE_PREFLIGHT: context=pass product=pass command_reference=pass shape=not_required image_gate=skipped:no new imagery requested mutation=open

## Which Surface Is The Target

There are two related routes:

- `/pipeline` -> `client/src/pages/pipeline/pipeline-page.tsx`
  - This is the full-screen kanban surface with drag/drop, per-column internal scroll, terminal Won/Lost filters, and no secondary list below the board.
  - It matches the reported current-state issues: kanban-only surface, all cards rendered in normal columns, HubSpot-style `dealNumber` shown on cards, no embedded list view below.
- `/deals` -> `client/src/pages/deals/deal-list-page.tsx`
  - This is already a newer redesign surface with a board and a small "Recent deal movement" section.
  - It already requests `previewLimit=8` through `useDealBoard`, so it is less likely to be the "every deal rendered" surface.

Decision: implement the overhaul on `/pipeline`, and keep `/deals` intact except for shared data/utility changes if needed. This matches the nav route and the user wording "whatever route hosts the kanban view."

## Current Kanban Implementation

Primary files:

- `client/src/pages/pipeline/pipeline-page.tsx`
  - Fetches `/api/deals/pipeline` through `buildPipelineRequestPath(showDd, terminalDateFilters)`.
  - Maintains its own drag/drop implementation with local `PipelineCard` and `DroppableColumn`.
  - `DroppableColumn` uses a full-height column with an internal absolute scroll area.
  - Column header is sticky and outside the scrollable card body.
  - For normal columns, every deal in `column.deals` is mapped/rendered.
  - Page wrapper is `h-[calc(100vh-4rem)] -m-4 md:-m-6`, so there is no room for below-board content without changing page layout.
- `client/src/components/pipeline/pipeline-board.tsx`
  - Shared board used by dashboard shells, not by `/pipeline`.
  - Already has a fixed-height board container and virtualization threshold, but terminal controls are inline preset pills, not the requested chip dropdown.
- `client/src/components/pipeline/pipeline-record-card.tsx`
  - Shared dashboard card, not used by `/pipeline`.
  - Also displays `dealNumber`; should be updated only if dashboard cards need the same project-number rule.

Scroll findings:

- `/pipeline` currently prevents page-level vertical scrolling by forcing a viewport-height layout.
- Each column has an internal scroll body, but normal columns render all deals.
- The header is already outside the column scroll body, so it can remain visible once the body is capped.
- The implementation needs to cap rendered visible cards or use CSS/virtualization so only 8-10 cards are visible by default, while preserving internal scroll.

## Existing Won/Lost Date Filters

Frontend files:

- `client/src/lib/pipeline-terminal-filters.ts`
  - Type currently supports presets `"30" | "60" | "90"` and custom start/end.
  - Storage keys currently are `pipeline_terminal_filter_won` and `pipeline_terminal_filter_lost`.
  - Default is `{ preset: "30" }`.
  - Request params are `won_since`, `won_until`, `lost_since`, `lost_until`.
- `client/src/components/pipeline/terminal-date-filter-control.tsx`
  - Existing control is a row of small buttons: 30d, 60d, 90d, Custom.
  - Custom uses native `<input type="date">` start/end fields.
  - This does not meet the requested chip dropdown shape, lacks 7d and All time, and uses old storage keys.

Backend files:

- `server/src/modules/deals/routes.ts`
  - `GET /api/deals/pipeline` accepts `won_since`, `won_until`, `lost_since`, `lost_until`.
- `server/src/modules/deals/service.ts`
  - `getDealsForPipeline` applies terminal filters server-side.
  - Won terminal rows currently use stage-history timestamp, falling back to `actual_close_date`, then `stage_entered_at`.
  - Lost terminal rows use stage-history timestamp, falling back to `lost_at`, then `stage_entered_at`.

Gap vs requested behavior:

- Requested Won filter date field is `deal.contractSignedAt`, falling back to `stageEnteredAt`.
- Schema has `contractSignedAt` (`contract_signed_at`) and `contractSignedDate` (`contract_signed_date`), but client `Deal` type currently lacks `contractSignedAt`.
- Backend should use `contract_signed_at` / `contract_signed_date` for Won rather than `actual_close_date`.
- "All time" needs no since bound. Current type always emits a since bound for preset filters.

Implementation direction:

- Extend `TerminalDateFilter` to support `"7" | "30" | "60" | "all" | "custom"`.
- Change storage keys to requested `deals.kanban.wonFilter` and `deals.kanban.lostFilter`.
- Keep backward read compatibility with old keys if cheap, but write the requested keys.
- Replace the existing terminal control UI on `/pipeline` with a compact chip dropdown using existing `Popover` and native date inputs for custom range.
- Update backend terminal filter resolver to allow All time by omitting the since condition.
- Update Won fallback SQL to use contract signed date/time before stage-entered fallback.

## Existing List View / Reuse Strategy

Existing `/deals` list route:

- `client/src/pages/deals/deal-list-page.tsx`
  - Despite the name, this page currently renders a redesigned board plus a small "Recent deal movement" section.
  - It uses `useDeals({ limit: 200, isActive: true, sortBy: "updated_at", sortDir: "desc", scope })`.
  - It is not a reusable full table component.
- `client/src/components/pipeline/pipeline-stage-table.tsx`
  - Reusable table/pagination shell used by stage workspaces.
  - Good candidate for the embedded list table.
- `client/src/hooks/use-deals.ts`
  - `useDeals` supports search, stageIds, assignedRepId, contract signed range, sort, page, limit, scope.
  - It does not currently support updated/last-touch date range filters.
- `server/src/modules/deals/service.ts`
  - `getDeals` returns raw deal rows only; it does not join company/user/stage names.
  - Search covers deal name, deal number, description, property address, but not company/account name.

Needed for requested list:

- A new embedded list section on `/pipeline` owning independent filter state.
- Use `useDeals` for pagination and sorting.
- Reuse `PipelineStageTable` for the table shell rather than duplicating table/pagination behavior.
- Add backend/list-hook support for:
  - `updatedFrom` / `updatedTo` (global date filter; "Last Touch" column will use `lastActivityAt ?? updatedAt` visually, but API date filtering will use `updatedAt` unless broadened later).
  - Joined `companyName`, `assignedRepName`, and stage name/slug metadata if practical.
  - Company/account search if practical by joining companies.
- Use `usePipelineStages` for stage chip ids and `useTaskAssignees` for owner dropdown options.

## Project Number Display

Current behavior:

- `/pipeline` local `PipelineCard` constructs `metaParts = [\`TR-${deal.dealNumber}\`]`, which prominently shows the HubSpot-derived deal number with an extra `TR-` prefix.
- `/deals` local `DealCard` also displays `deal.dealNumber`.
- Shared `PipelineRecordCard` displays `record.dealNumber`.
- `Deal` type already has `projectNumber?: string | null`.

Implementation direction:

- On `/pipeline` cards, display `deal.projectNumber ?? deal.dealNumber`.
- If using fallback `dealNumber`, render with muted styling.
- Remove the hardcoded `TR-` prefix.
- Add the same project-number/fallback display in the new embedded list row.
- Consider updating shared `PipelineRecordCardData` with `projectNumber?: string | null` and display logic so dashboard board cards are consistent without changing backend behavior.

## Backend Needs

Backend change is needed for exact spec compliance:

- `GET /api/deals/pipeline` already supports terminal date params, so no new endpoint is needed.
- Change Won terminal filter date source from `actual_close_date` fallback to `contract_signed_at` / `contract_signed_date` fallback.
- Allow All time terminal filters by making since optional.
- `GET /api/deals` should be extended for the embedded list if the list must filter by updated date, search account/company names, and display owner/company/stage without client-side guesswork.

## Tests To Add / Update

Frontend:

- Terminal/column date filter renders the chip, opens dropdown, selects 7/30/60/all/custom, and persists to `deals.kanban.{won|lost}Filter`.
- `/pipeline` card shows `projectNumber` when present and muted `dealNumber` fallback when missing.
- `/pipeline` board column caps visible height and uses internal column scroll.
- Won column default 30d filter is passed to `/api/deals/pipeline`; All time omits the since param.
- Embedded list filters do not mutate kanban terminal filters.

Backend:

- Pipeline terminal filters default to 30d, support 7/60/all/custom, and Won uses contract-signed fallback semantics.
- `GET /deals` list filters/search extensions if implemented.

## Risks

- Low disk space: initial `git fetch` failed with `No space left on device`. Clearing npm cache brought free space to about 1.0 GiB, still tight. New worktree has no `node_modules`; verification may require `npm install` or reusing another checkout's dependency install carefully.
- There are two kanban implementations. The PR should clearly state that `/pipeline` is the overhauled operational board, while `/deals` remains the existing redesigned deal index unless tests reveal a routing mismatch.
- "Date filter" for the embedded list is not explicitly tied to a backend field. Current conservative choice is updated date / last movement semantics.
