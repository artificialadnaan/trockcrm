# Reports Performance Tier 2 Discovery

Date: 2026-05-11

## Routing Pattern

- App routes live in `client/src/App.tsx` under the authenticated `<AppShell />` route tree.
- Report catalog page is `client/src/pages/reports/reports-page.tsx`.
- Existing report hooks are centralized in `client/src/hooks/use-reports.ts`.
- Backend report endpoints are appended in `server/src/modules/reports/routes.ts`.

## Chart Library And Visual Tokens

- Chart library: `recharts` is already used by report/chart components.
- Brand token: `brand-red` / `#CC0000`.
- Existing report pages use compact cards, white/slate surfaces, and uppercase labels.

## Tier 1 Parallel Work

The Tier 1 worktree at `/Users/adnaaniqbal/projects/trockcrm-reports-sales` exists and currently has uncommitted report work:

- `client/src/components/reports/report-filter-bar.tsx`
- `server/src/modules/reports/sales-tier1-service.ts`
- Sales report pages and tests

Tier 2 will reuse the same filter-bar API shape (`dateFrom`, `dateTo`, `office`, `ownerIds`) to reduce conflict risk. Because Tier 1 is not merged yet, this branch will add a local `report-filter-bar.tsx`; if Tier 1 merges first, conflict resolution should keep a single compatible component.

## Backend Service Naming

- Tier 1 uses `sales-tier1-service.ts`.
- Tier 2 will add `server/src/modules/reports/performance-tier2-service.ts` to avoid shared-service conflicts.
- A local 5-minute in-memory cache will be used in the Tier 2 service, keyed by report name, user scope, tenant scope, and filters.

## Data Sources

- `deals` tenant table for pipeline, win rate, at-risk rows, expected close dates.
- `activities` tenant table for touchpoints and last activity.
- `tasks` tenant table for overdue/follow-up counts.
- `users` public table for display names and office filtering.
- `pipeline_stage_config` public table for stage display names.
- `offices` public table for office comparison display names.

## Existing Hooks

- `useAccessibleOffices` loads `/api/auth/accessible-offices`.
- `useSalesReps` loads `/api/users/sales-reps`.
- Existing API helper uses `/api` on production host and credentials.

## Role Policy

- Director Scorecard: admin/director only.
- Forecast Accuracy: admin/director only.
- Rep Activity: all roles; reps are constrained to their own user id server-side.

## Conflict Notes

Expected conflict files when other tiers merge:

- `client/src/pages/reports/reports-page.tsx`
- `client/src/App.tsx`
- `server/src/modules/reports/routes.ts`

Resolution policy: preserve both sides. Tier 2 only owns the three Performance cards/routes/endpoints.
