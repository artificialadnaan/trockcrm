## Findings

### P1 - Required decorated card component is still untracked

`client/src/pages/deals/deal-list-page.tsx:23` imports `@/components/deals/decorated-kanban-card`, and `client/src/components/deals/decorated-kanban-card.tsx` exists, but it is still reported by `git ls-files --others --exclude-standard` / `git status --short` as untracked. The file is ready to be included by a normal `git add`, but the current tracked diff does not include it, so a PR made without adding untracked files would omit the import target and break module resolution for `/deals`.

## Verification Notes

- Owner avatar initials now derive only from `assignedRepName` and fall back to `TR` when missing in `client/src/components/deals/decorated-kanban-card.tsx:7-16`; there is no `companyName` fallback in that path.
- `/deals` now uses `buildCanonicalDealBoardColumns(board?.columns, stages)` without the prior five-stage local filter, so the eight canonical columns come from `getDealBoardStageSlugs()` in `client/src/lib/pipeline-ownership.ts:44-53`: Opportunity, Estimating, Service Estimating, Estimate Under Review, Estimate Sent to Client, Contract, Won, Lost.
- Decorated cards are rendered through `DecoratedKanbanCard` and include display number, value, owner avatar, company/account fallback, SLA line, and location when available.
- `DealsListSection` is rendered below the kanban with `workflowFamily="deal"`, `scope={scope}`, `enableExport`, `enableDateFilter={false}`, `showFilterButton`, `pageSize={20}`, and visible search placeholder text.
- No `/pipeline`, backend, shared, or route files are modified in the current diff; only `/deals` page/list component tests and frontend deal components are changed.
- Focused tests passed: `npx vitest run client/src/pages/deals/deal-list-page.test.tsx client/src/components/deals/deals-list-section.test.tsx` reported 2 files passed, 28 tests passed.
