# Subagent Review Round 1

Reviewer: Jason
Date: 2026-05-11

## Findings

1. P1 - Cross-tenant cache key did not include tenant identity.
2. P2 - Filter URL exposed raw office/user UUID values.
3. P2 - Rep Activity route lacked an explicit frontend role gate.

## Fixes Applied

1. Added tenant key to all Tier 2 report cache keys. Routes now pass `req.officeSlug` (fallback active office id) into `getDirectorScorecard`, `getRepActivityReport`, and `getForecastAccuracyReport`.
2. Changed report filter URL persistence to use office slug and owner display names:
   - `office=dallas`
   - `ownerNames=Rep%20Name`
   Backend filters now use `offices.slug` and `users.display_name`, not visible UUID params.
3. Wrapped `/reports/performance/rep-activity` in `RequireRole` for `admin`, `director`, and `rep`.

## Verification

- `npx vitest run server/src/modules/reports/performance-tier2-service.test.ts client/src/pages/reports/performance-report-pages.test.tsx client/src/pages/reports/reports-page.test.tsx`
- `npm run typecheck`
