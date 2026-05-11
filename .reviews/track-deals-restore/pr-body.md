## Summary

- Restores `/deals` to the eight canonical deal columns: Opportunity, Estimating, Service Estimating, Estimate Under Review, Estimate Sent to Client, Contract, Won, Lost.
- Adds a `/deals`-only decorated kanban card with project/deal number, value, owner avatar, account line, SLA line, and location line.
- Adds the paginated `DealsListSection` below the `/deals` kanban with deal-family stages, export enabled, date filters disabled, page size 20, and the page-level Mine/Team/All scope passed through.
- Keeps the existing `/deals` direct route, KPI cards, scope toggle, board search, top scrollbar proxy, fixed-height kanban shell, and `/deals/:id` detail route.

## References

- `/tmp/deals-revert-discovery.md`
- `/tmp/preview-deals-discovery.md`
- `/tmp/deals-baseline.tsx`

## Not Included

- No Board/Map toggle.
- No DFW map view.
- No date filter chips on `/deals`.
- No backend changes.
- No `/pipeline` page changes.

## Verification

- `npx vitest run client/src/pages/deals/deal-list-page.test.tsx client/src/components/deals/deals-list-section.test.tsx`
- `npx vitest run client/src/pages/pipeline/pipeline-page.test.ts client/src/components/deals/deals-list-section.test.tsx client/src/pages/deals/deal-list-page.test.tsx`
- `npm run typecheck`
- `npm run test` was run both sandboxed and escalated; the sandboxed run hit `listen EPERM` on supertest, while the escalated run exposed existing unrelated server baseline failures in reports, estimating, tasks, and migrations.
