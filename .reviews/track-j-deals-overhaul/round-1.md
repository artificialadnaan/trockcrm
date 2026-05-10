# Track J Deals Overhaul Review Round 1

## Diff Under Review

- `client/src/pages/pipeline/pipeline-page.tsx`
  - `/pipeline` now uses a normal page layout with a fixed-height kanban section and a list section below.
  - Kanban cards display canonical `projectNumber` when present, otherwise muted `dealNumber`.
  - Added independent list filters: search, stage chips, owner dropdown, date dropdown, export button, sortable table.
- `client/src/components/pipeline/terminal-date-filter-control.tsx`
  - Replaced inline terminal preset pills with compact popover chip dropdown.
  - Options: Last 7 days, Last 30 days, Last 60 days, All time, Custom.
- `client/src/lib/pipeline-terminal-filters.ts`
  - Added 7d/all-time support and requested localStorage keys `deals.kanban.wonFilter` / `deals.kanban.lostFilter`.
- `server/src/modules/deals/service.ts` and `routes.ts`
  - Pipeline Won/Lost filters support all-time flags.
  - Won terminal filter now uses contract signed timestamp/date fallback before stage-entered fallback.
  - `/api/deals` supports updated date filters and company/account search via an EXISTS predicate.
- Tests updated/added around terminal filters, project-number display helper, list/filter request compatibility, and terminal backend filter behavior.

## Verification Results

- `npm run typecheck`: PASS.
- Focused affected suites: PASS.
  - `client/src/pages/pipeline/pipeline-page.test.ts`
  - `client/src/components/pipeline/terminal-date-filter-control.test.tsx`
  - `client/src/components/pipeline/pipeline-board.test.tsx`
  - `client/src/pages/deals/deal-list-page.test.tsx`
  - `server/tests/modules/deals/service.test.ts`
  - `server/tests/modules/deals/stage-page-service.test.ts`
  - `server/tests/modules/deals/list-deals-scope.test.ts`
  - `server/tests/deals-contract-signed-filter.test.ts`
- Broad `npm run test`: FAIL in sandbox. Dominant failure is supertest `listen EPERM: operation not permitted 0.0.0.0`; also unrelated pre-existing suite failures. Focused deal/pipeline suites pass after fixing compatibility regressions.

## Concerns To Review

- Does the `/pipeline` route selection match the user's "deals pipeline page" intent?
- Is the kanban height/capping behavior sufficient, or should card DOM virtualization be stricter for columns with 100+ deals?
- Do Won/Lost filters remain independent and persisted under the requested keys?
- Does the list view filter state stay independent from kanban filter state?
- Did any backend change risk widening visibility? `getDeals` still preserves existing scope conditions.
- Account search is supported in `/api/deals`, but list rows still only show company if the API already supplies `companyName`; otherwise they show property/city fallback.
