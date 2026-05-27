# Deals Date Filter Refresh Fix Report

## Current Flow

`TerminalDateFilterControl` previously called `onFilterChange` from every preset click and every custom date input `onChange`. On `/deals`, `DealListPageContent` wired that callback to `updateTerminalDateFilter` or `updateEstimateSentDateFilter`.

For terminal Won/Lost filters, `updateTerminalDateFilter` wrote local state, persisted terminal filter storage, and called `setSearchParams` through `setTerminalDateFilterSearchParams`. For the Estimate Sent filter, `updateEstimateSentDateFilter` wrote local state and called `setSearchParams` through `setEstimateSentDateFilterSearchParams`.

`DealListPageContent` also has an effect watching `searchParams`, and `useDealBoard()` depends on the committed terminal filter state and Estimate Sent date range. That meant every custom date keystroke or date picker change wrote URL params and caused the board hook to rerun.

## Fix

`TerminalDateFilterControl` now keeps a local `draftFilter` for custom editing. Selecting `Custom range` opens the editor and seeds a 30-day draft without calling `onFilterChange`. Typing in either custom date input updates only the draft. The parent callback is invoked only when the user presses Enter in a custom date input or clicks the new Apply action.

Discrete presets (`7`, `30`, `60`, `90`, `All`) still call `onFilterChange` immediately, preserving the previous explicit-preset behavior. The committed filter value still comes from the parent `filter` prop, so URL params, local storage, `useDealBoard()`, and downstream consumers continue to receive only committed values.

This applies consistently to all `TerminalDateFilterControl` consumers, including `/deals` Won/Lost column filters, the `/deals` Estimate Sent filter, pipeline page/board filters, and the deals list date filter.

## Tests

Passed:

- `npm run build --workspace=shared`
- `npm run typecheck`
- `TMPDIR=/private/tmp npx vitest run client/src/components/pipeline/terminal-date-filter-control.test.tsx --testTimeout=15000 --exclude '.worktrees/**'`: 4 tests passed.
- `TMPDIR=/private/tmp npx vitest run client/src/pages/deals/deal-list-page.test.tsx -t "does not refetch|commits a terminal preset" --testTimeout=15000 --exclude '.worktrees/**'`: 4 tests passed.

Focused full files:

- `TMPDIR=/private/tmp npx vitest run client/src/components/pipeline/terminal-date-filter-control.test.tsx client/src/pages/deals/deal-list-page.test.tsx --testTimeout=15000 --exclude '.worktrees/**'`: the component tests and all new date-filter tests passed; `deal-list-page.test.tsx` still has 6 pre-existing unrelated failures around KPI currency formatting and `paginationCountSummary`.

Required full suite:

- Sandbox run of `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'` failed with sandbox `listen EPERM`/null-port Supertest failures and existing broad-suite failures.
- Rerun outside sandbox failed with 23 failed files, 504 passed files, 84 failed tests, and 3951 passed tests. Observed unrelated buckets include `detail-page-shell.test.tsx`, `kanban-deal-card.test.tsx`, known `deal-list-page.test.tsx` KPI assertions, `deal-detail-page.test.tsx` KPI visual assertion, lead form tests, lead service mock-shape failures, property consistency tests, report builder SQL quoting expectation, and sales-review service expectations.

## Review Rounds

Round 1, Harvey: found two coverage gaps: no `/deals` integration coverage for Lost custom date editing and no page-level proof that discrete presets still commit immediately. Fixes applied with Lost custom Apply coverage and a terminal preset immediate-commit test.

Round 2, Linnaeus: no findings. Confirmed new Won, Lost, Estimate Sent, and preset commit coverage passed. Noted existing `deal-list-page.test.tsx` unrelated failures.

Round 3, Fermat: no findings. Reviewed all `TerminalDateFilterControl` consumers and confirmed custom edits stay local until Enter/Apply while presets remain immediate commits. Noted residual UX behavior that an unapplied custom draft may remain visible if the popover is reopened, which is consistent with local draft editing and does not affect committed filters.
