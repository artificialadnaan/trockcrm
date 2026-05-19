# Hotfix Mine Scope Comprehensive V2

## Status

- Branch: `hotfix/mine-scope-pipeline-500-complete`
- Head commit: `850e8737a95c19319a73d806e75ee144cf8c807f`
- PR: `#406`
- PR URL: `https://github.com/artificialadnaan/trockcrm/pull/406`
- Merge status: `NOT MERGED YET`
- Codex re-review: requested via `@codex review`

## Findings addressed

1. `POST /api/deals/:id/rfp-retry` authorization restored before privileged read.
2. `assertDealOwnerAccess` / `assertLeadOwnerAccess` now honor `allowAdmin: true` before collaborator gating.
3. Assignee office access check now compares the assignee against the viewer office directly instead of picking an arbitrary first `user_office_access` row.
4. Legacy unassigned records with no `office_code` and no assignee remain accessible within the tenant schema.
5. Default route fallback is `scope=mine` for deal and lead list routes.
6. Active-office deal visibility falls back to assigned-rep office when `deals.office_code` is null.
7. Deal stage workspace queries no longer hard-drop unassigned Mine deals via inner assignee join.
8. Lead board/stage workspace queries no longer hard-drop unassigned Mine leads via inner assignee join.
9. Dashboard director-scope Mine subqueries now receive the same Mine schema-fallback flags as the main Mine query path.

## Additional production bug coverage included

- Mine-scope schema probing now checks not just subscription-table existence, but also:
  - `deals.created_by_user_id`
  - `leads.created_by_user_id`
  - `deal_subscriptions.deleted_at`
  - `lead_subscriptions.deleted_at`
- Deal, lead, and dashboard Mine filters now omit only the unavailable clauses instead of crashing.
- `/api/deals/pipeline` now normalizes missing `scope` to `mine` server-side before calling the service.

## Files changed

- `server/src/lib/collaboration-access.ts`
- `server/src/modules/shared/mine-visibility.ts`
- `server/src/modules/deals/routes.ts`
- `server/src/modules/deals/service.ts`
- `server/src/modules/leads/routes.ts`
- `server/src/modules/leads/service.ts`
- `server/src/modules/dashboard/service.ts`
- `server/tests/lib/collaboration-access.test.ts`
- `server/tests/modules/deals/routes-scope.test.ts`
- `server/tests/modules/deals/rfp-retry-route.test.ts`
- `server/tests/modules/deals/board-service.test.ts`
- `server/tests/modules/deals/stage-page-service.test.ts`
- `server/tests/modules/deals/list-deals-scope.test.ts`
- `server/tests/modules/leads/board-service.test.ts`
- `server/tests/modules/leads/list-leads-scope.test.ts`
- `server/tests/modules/leads/routes.test.ts`
- `server/tests/modules/dashboard/service.test.ts`

## Focused verification

Passed:

- `server/tests/lib/collaboration-access.test.ts`
- `server/tests/modules/deals/routes-scope.test.ts`
- `server/tests/modules/deals/rfp-retry-route.test.ts`
- `server/tests/modules/deals/list-deals-scope.test.ts`
- `server/tests/modules/deals/stage-page-service.test.ts`
- `server/tests/modules/deals/board-service.test.ts`
- `server/tests/modules/leads/routes.test.ts`
- `server/tests/modules/leads/list-leads-scope.test.ts`
- `server/tests/modules/leads/board-service.test.ts`
- `server/tests/modules/dashboard/service.test.ts`

Result:

- `82/82` targeted tests passed
- `git diff --check` passed

Broader repo debt still present and documented in `/private/tmp/preexisting-failures.md`:

- broad `server/tests/` has unrelated baseline failures in `ai-copilot`, `admin-routes`, `email/routes`, `files/audit-routes`, `reports/analytics-cycle`, and existing scoping-route debt
- `npm run typecheck --workspace=server` still fails on pre-existing `server/src/modules/field/pdf-layout.ts` `pdfkit` typing errors

## Review rounds

1. P1 auth/security review:
   - Restored `rfp-retry` guard
   - Fixed cross-office admin override ordering
   - Fixed office-access false-denial logic
2. P2/default/fallback review:
   - Restored `scope=mine` default
   - Restored legacy office fallback
   - Restored unassigned Mine workspace visibility
3. Dashboard/query-path review:
   - Propagated Mine fallback flags through director-scope dashboard subqueries
   - Added dedicated route/service regressions for Mine fallback and auth

## Current stop condition

PR `#406` is open and review-requested. No fresh Codex review has posted yet on the latest head, so merge/deploy observation is intentionally not done yet.

## User verification after merge

1. Refresh `trockcrm.com` Deals.
2. Verify Mine scope loads without 500s.
3. Verify Team and All scopes load.
4. Verify drilldowns load (`At Risk`, `Stale`, etc.).
5. Verify Reports still work.
6. Verify a deal detail page loads.
7. Confirm everything before authorizing any further actions.
