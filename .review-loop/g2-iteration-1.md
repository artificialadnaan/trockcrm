# Track G2 Internal Review - Iteration 1

## Diff Summary
- Added `GET /api/commissions/dashboard?period=...` for the sales-rep commissions page.
- Added tenant migration `0107_commission_deal_snapshots.sql` for persisted per-deal commission snapshot deltas.
- Rebuilt `client/src/pages/commissions/rep-commissions-page.tsx` to match the screenshot structure: header, period tabs, KPI strip, stage bar, goal progress, grouped project table, CSV export, and deal links.
- Added client behavior tests, backend reporting tests, and a migration test.

## Test Results
- `npm run typecheck`: pass
- `npx vitest run client/src/pages/commissions/rep-commissions-page.test.tsx server/tests/modules/commissions/reporting.test.ts server/tests/modules/migration/commission-deal-snapshots-migration.test.ts`: 16 tests pass

## Structural Decisions
- `/commissions` consumes one richer endpoint instead of stitching together the old summary/potential/earned endpoints.
- Rep scoping is enforced server-side. Rep users ignore any supplied `repId` and use `req.user.id`.
- Pipeline commission now follows the requested rule: deal value times rep commission rate. It no longer uses estimated margin on the new dashboard endpoint.
- Delta tracking uses persisted tenant `commission_deal_snapshots`: current computed amount is compared to the last snapshot, then the snapshot is refreshed.
- No director/team aggregate commission dollars were added to `/commissions`. The team toggle is present only as disabled/hidden UI, with My commissions functional.

## Concerns To Review
- Goal storage does not appear to exist. The endpoint currently returns no goal and the UI renders `No goal set`.
- The dashboard endpoint refreshes snapshots during a GET so deltas persist across sessions without another write path.
- Existing legacy `/commissions/summary`, `/potential`, `/earned` endpoints are preserved for compatibility.
