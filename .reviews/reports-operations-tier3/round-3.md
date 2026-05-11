# Reports Operations Tier 3 - Codex Round 3

Date: 2026-05-11
Branch: fix/reports-operations-codex-findings
PR: #240

## Findings Addressed

1. P2 rejected proposal classification
   - Added `rejected` to the active estimating proposal-status fallback list in `classifyReadinessStage`.
   - Added a regression test proving an ambiguous-stage deal with `proposal_status="rejected"` is counted as Estimating, not Kickoff.

2. P2 office ID validation in filter bar
   - Resolved `draft.office` through `useAccessibleOffices()` before passing it to `useSalesReps`.
   - Slug values such as `dallas` now resolve to the canonical office id before sending `x-office-id`.
   - Unknown office values fall back to no scoped header.
   - Added a regression test for URL state `office=dallas`.

## Verification

- `npm run typecheck` - PASS
- `npx vitest run server/src/modules/reports/ client/src/components/reports/` - PASS
- `npx vitest run server/tests/modules/reports/operations-tier3-service.test.ts` - PASS

