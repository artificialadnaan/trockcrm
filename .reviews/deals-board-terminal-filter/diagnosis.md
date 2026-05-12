# Deals Board Terminal Date Filter Diagnosis

Date: 2026-05-12
Branch: fix/deals-board-terminal-date-filter

## Assumptions

- `/deals/board` is an alias for `/deals`; route `BoardAliasRedirect` in `client/src/App.tsx` redirects `/deals/board` to `/deals` while preserving query params.
- The user-facing "deals board" change therefore belongs in `client/src/pages/deals/deal-list-page.tsx`.
- The backend terminal filter semantics are already authoritative and should not be reinterpreted in the client.

## Current Code Surface

- `/pipeline` page: `client/src/pages/pipeline/pipeline-page.tsx`
  - Renders terminal controls inside Won/Lost column headers via `TerminalDateFilterControl` from `client/src/components/pipeline/terminal-date-filter-control.tsx`.
  - Fetches `GET /api/deals/pipeline` through `buildPipelineRequestPath(showDd, terminalDateFilters)`.
  - Current preset options are 7d, 30d, 60d, All time, Custom. 90d is missing.
- Terminal filter helpers: `client/src/lib/pipeline-terminal-filters.ts`
  - Serializes filters as `won_since`, `won_until`, `won_all_time`, `lost_since`, `lost_until`, `lost_all_time`.
  - Current type supports `7 | 30 | 60 | all | custom`; 90d is missing.
  - Default helper currently returns 30d when no localStorage value exists.
- `/deals` / `/deals/board` page: `client/src/pages/deals/deal-list-page.tsx`
  - Calls `useDealBoard(scope, true, ytdTerminalFilters)`.
  - That means the board source request already applies terminal filters, but they are hard-coded to YTD and not user-controllable.
  - Column headers do not render terminal controls or terminal date labels.
- Shared board hook: `client/src/hooks/use-deals.ts`
  - `useDealBoard(scope, includeDd, terminalDateFilters?)` already appends terminal filter params to `/deals/pipeline` when filters are supplied.
- Backend endpoint: `server/src/modules/deals/routes.ts`
  - `GET /api/deals/pipeline` accepts `won_since`, `won_until`, `won_all_time`, `lost_since`, `lost_until`, `lost_all_time`.
- Backend query logic: `server/src/modules/deals/service.ts`
  - Won filters apply to `COALESCE(contract_signed_at, contract_signed_date, stage_entered_at)`.
  - Lost filters apply to `COALESCE(lost_at, stage_entered_at)`.
  - Non-terminal stage queries only constrain active rows by stage and are not affected by terminal date filters.

## Root Cause

`/deals/board` lacks a user-facing control even though the hook and API already support terminal date filtering. The page also currently injects a YTD terminal filter for the board request to power the "Won YTD" metric, which makes Won/Lost board contents date-scoped without exposing that state to users. `/pipeline` has the right reusable control but lacks the 90d preset and does not cap custom date inputs against future dates.

## Fix Plan

1. Extend the shared terminal filter model and control with the 90d preset and future-date max bounds for custom inputs.
2. Keep the backend unchanged because it already applies terminal filters to Won/Lost only using terminal business dates.
3. Add terminal date filter state to `/deals` from the same persisted defaults as `/pipeline`, pass it into `useDealBoard`, and render the same control on Won/Lost board columns.
4. Show a terminal date label and range empty-state text only for Won/Lost columns.
5. Preserve scope query params and add terminal filter URL state so `/deals/board?...` survives redirect/refresh.
6. Update focused tests before implementation to cover 90d serialization, default all-time behavior, `/deals` hook wiring, and visible terminal controls.
