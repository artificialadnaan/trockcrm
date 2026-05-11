# Review Round 3

Reviewer: subagent `Hooke`
Date: 2026-05-11

## Findings Addressed

1. P2 Pipeline Velocity date filters were accepted but not applied
   - Pipeline Velocity now calls `buildDealFilterSql(filters, "created_at")`, so the shared date range changes the active-deal cohort.

2. P2 Owner display-name filtering was not unique
   - `/api/users/sales-reps` now returns owner email along with id and display name.
   - The URL still avoids raw UUIDs, but includes `owners` for readable labels and `ownerEmails` for unique filtering.
   - Backend filters by lowercase `users.email` when `ownerEmails` are present, with display-name fallback for older bookmarked URLs.

## Verification After Fixes

- `npm run typecheck` exited 0.
- `npx vitest run server/src/modules/reports/ client/src/pages/reports/ client/src/components/reports/analytics-sections.test.tsx` exited 0 with 22 tests passing.
