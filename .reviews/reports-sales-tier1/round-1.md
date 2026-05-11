# Review Round 1

Reviewer: subagent `Euler`
Date: 2026-05-11

## Findings Addressed

1. P1 Lead Conversion SQL grouping risk
   - Changed lead-source aggregate queries from `GROUP BY source` to `GROUP BY 1`.

2. P2 Empty states did not trigger for successful empty payloads
   - Added per-report `hasRows` checks based on meaningful counts/rows rather than `Boolean(data)`.

3. P2 Mobile table overflow at 375px
   - Wrapped `DataTable` in horizontal overflow and set a stable minimum table width.

4. P2 Raw owner UUIDs in URL state
   - Changed URL persistence to store owner display names in `owners`.
   - The filter bar resolves those names back to owner IDs after loading `/users/sales-reps`.
   - Removed stale `ownerIds` from search params on apply.

5. P3 Invalid fallback office values
   - Removed hardcoded `dallas` / `atlanta` fallback values that could be submitted as non-UUID office filters.

## Verification After Fixes

- `npm run typecheck` exited 0.
- `npx vitest run server/src/modules/reports/ client/src/pages/reports/ client/src/components/reports/analytics-sections.test.tsx` exited 0 with 21 tests passing.
