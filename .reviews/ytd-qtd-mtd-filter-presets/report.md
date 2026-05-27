# YTD / QTD / MTD Deal-Pipeline Filter Presets

## Investigation

- Date filter control: `client/src/components/pipeline/terminal-date-filter-control.tsx`.
- Current preset list before this change: Last 7 days, Last 30 days, Last 60 days, Last 90 days, All time, Custom range.
- Current discrete preset behavior: click commits immediately through `onFilterChange`. Custom range opens local draft inputs and commits only on Enter/Apply.
- URL/search-param handling: `client/src/lib/pipeline-terminal-filters.ts`.
  - Terminal stages persist browser URL state as `won_preset` / `lost_preset` where possible.
  - API requests serialize to `won_since` / `won_until` and `lost_since` / `lost_until`, or `*_all_time=true`.
- Server expectation:
  - `server/src/modules/deals/service.ts` accepts arbitrary `since`/`until` params for terminal filters.
  - No server-side preset enum needed extension.
  - No server changes were made.
- Calendar convention:
  - Existing dashboard/director/report UI already uses MTD/QTD/YTD as calendar month/quarter/year.
  - No fiscal-year convention was found.

## Implementation

- Added presets:
  - `mtd`: first day of current local calendar month through today.
  - `qtd`: first day of current local calendar quarter through today.
  - `ytd`: January 1 of current local calendar year through today.
- Preset ordering: placed after Last 90 days and before All time.
- Shared date-range helper:
  - `toDatePresetRange()` in `client/src/lib/pipeline-terminal-filters.ts`.
  - Uses local `getFullYear()` / `getMonth()` / `getDate()` for the new to-date presets.
  - Existing rolling day presets keep the existing `daysAgo()` behavior.
- URL behavior:
  - Page URL keeps preset identity, e.g. `won_preset=mtd`.
  - API request path materializes preset into bounded date params, e.g. `won_since=2026-05-01&won_until=2026-05-15`.

## Consumers Covered

- Deals page terminal board columns: shared `TerminalDateFilterControl` + `useDealBoard()` request params.
- Pipeline page terminal board columns: shared `TerminalDateFilterControl` + `buildPipelineRequestPath()`.
- Shared pipeline board column component: receives the same `TerminalDateFilter` type and labels.
- Embedded `DealsListSection` date filter: maps MTD/QTD/YTD to concrete `from` / `to`.
- Deals page Estimate Sent to Client filter: accepts the new presets and maps them to `estimateSentFrom` / `estimateSentTo`.
- Stage-page Estimate Sent drilldown normalization: `client/src/lib/pipeline-stage-page.ts` materializes `estimate_sent_preset=mtd|qtd|ytd` into concrete stage-page filters.

## Tests

- Passed: `TMPDIR=/private/tmp npx vitest run client/src/components/pipeline/terminal-date-filter-control.test.tsx client/src/pages/pipeline/pipeline-page.test.ts client/src/components/deals/deals-list-section.test.tsx client/src/lib/pipeline-stage-page.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
  - 4 files, 68 tests passed.
- Full standard command run: `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**' 2>&1 | tail -50`
  - Result: known broad-suite failures, including sandbox/auth `listen EPERM` and the existing deal-list-page failures already called out as pre-existing.
- Passed: `npm run typecheck --workspace=client`.
- Passed: `npm run typecheck --workspace=shared`.
- Passed: `npm run build --workspace=shared`.
- Passed: `npm run build --workspace=client`.

## Review

- One subagent review round completed.
- Review focus: consumer coverage, URL/request params, local calendar behavior, and no server API changes.
- Result: no findings.

## Scope Confirmation

- Client-side filter preset change only.
- No server API changes.
- No database reads or writes were needed.
- No endpoint contracts changed.
