# leads-kanban-truncation-bug

## Summary

- Removes the leads board `previewLimit=8` request that caused each kanban column to receive only the first eight cards.
- Removes the leads board service card slice so each column returns every card while preserving the accurate column count.
- Keeps the existing leads column internal scroll behavior and adds regression coverage for busy columns.

## Diagnosis

The production symptom was server-side truncation triggered by the client. The leads board hook requested:

`/leads/board?scope=<scope>&previewLimit=8`

The server computed the full column `count`, then sliced returned cards with `cards.slice(0, previewLimit)`. That made headers like `New Lead: 24` accurate while only eight cards existed in the response, so the remaining cards could not be reached by scrolling.

## Verification

- `npm run typecheck` passed.
- Focused regression suite passed:
  - `npx vitest run client/src/hooks/use-leads.test.ts client/src/pages/leads/lead-list-page.test.tsx server/tests/modules/leads/board-service.test.ts`
  - 3 files, 23 tests passed.
- Review round 1 found no issues.
- `git diff --check` passed.
- No files under `client/src/pages/deals/` or `client/src/components/deals/` are modified.

## Known Baseline Failures Out Of Scope

Full `npm run test` still fails on current `origin/main` baseline failures that are unrelated to this lead board fix. These are not addressed in this PR:

- Missing migration file: `server/migrations/0107_commission_deal_snapshots.sql`.
- `rbac.js` mocks missing `requireAnyRole`.
- Missing estimating workflow routes in existing tests.
- `listDealBoard is not a function` in the existing deals board-service test.

A separate issue will track repairing the pre-existing test baseline.
