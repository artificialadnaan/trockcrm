# Review Round 1 - leads-kanban-truncation-bug

## Scope Reviewed

- Read `.reviews/leads-kanban-truncation-bug/DIAGNOSIS.md`.
- Reviewed the working diff against `main`, including the untracked diagnosis artifact relevant to this track.
- Diff reviewed:
  - `client/src/hooks/use-leads.ts`
  - `client/src/hooks/use-leads.test.ts`
  - `client/src/pages/leads/lead-list-page.test.tsx`
  - `server/src/modules/leads/routes.ts`
  - `server/src/modules/leads/service.ts`
  - `server/tests/modules/leads/board-service.test.ts`

## Findings

No findings.

The diff matches the diagnosis: the client stops requesting `previewLimit=8`, the route no longer forwards a preview cap, and the service no longer slices returned cards after computing the full column count. The existing leads column body already has internal vertical scrolling, and the added tests cover both the API request shape and count/cards parity for a busy column.

## Verification

- `git diff --check` passed.
- `npx vitest run client/src/hooks/use-leads.test.ts client/src/pages/leads/lead-list-page.test.tsx server/tests/modules/leads/board-service.test.ts` passed: 3 files, 23 tests.

## Residual Risk

- I did not run a real-browser visual smoke. Given this patch does not modify the production leads column markup and the diagnosis identifies the truncation as server-side, I do not consider that a blocking gap for this review round.
