# Review Round 2

Reviewer: subagent `Newton`
Date: 2026-05-11

## Findings Addressed

1. P2 Owner filters silently ignored
   - `useReportFilters()` now includes `ownerNames` in the report query.
   - `use-reports.ts` sends friendly `owners` query params.
   - Backend normalizes `owners` and filters by `users.display_name`.
   - Rep role still ignores URL owners and forces the current user ID.

2. P2 Office URL exposed raw IDs and stale invalid params could cause UUID casts
   - Filter URL now persists office slug rather than office UUID.
   - Backend normalizes `office` as `officeSlug` and filters through `offices.slug`.
   - Removed UUID casts for public URL office filters.

## Verification After Fixes

- `npm run typecheck` exited 0.
- `npx vitest run server/src/modules/reports/ client/src/pages/reports/ client/src/components/reports/analytics-sections.test.tsx` exited 0 with 22 tests passing.
