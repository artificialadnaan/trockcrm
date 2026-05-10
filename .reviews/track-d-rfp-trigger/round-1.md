# Review Round 1

Reviewer: subagent
Date: 2026-05-10

## Verdict

No P1 findings.

Manual-only behavior is functionally intact:
- Stage change no longer calls the RFP enqueue helper.
- Lead conversion no longer calls the RFP enqueue helper.
- The only production enqueue path found is `POST /api/deals/:id/trigger-rfp`.
- The backend route enforces authorization, Opportunity stage, not already triggered, not Bid Board owned, and scoping readiness.
- The UI button requires readiness and `window.confirm` before posting.

Focused verification before review:
- `npx vitest run server/tests/modules/deals/manual-rfp-trigger-route.test.ts server/tests/modules/deals/stage-change.test.ts server/tests/modules/leads/conversion-service.test.ts client/src/pages/deals/deal-detail-page.test.tsx`
- Result: 4 files passed, 108 tests passed.
- `npm run typecheck`
- Result: passed.

## P2 Findings

1. `server/tests/modules/leads/conversion-service.test.ts`
   - A test title still said "enqueues an RFP request when lead conversion creates an Opportunity deal", while the assertions now verify no RFP status and no `rfp_request_delivery` job.

2. `server/src/modules/deals/rfp-enqueue.ts`
   - The helper comment still said the function is safe from stage changes and lead conversion, which contradicts the new manual-only rule.

## Fix Plan

- Rename the stale test title to state that conversion does not auto-enqueue.
- Update the enqueue helper comment to identify the manual trigger endpoint as the intended caller.
