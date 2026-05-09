# Track G2 Internal Review - Iteration 3

## Security Trace
- Request enters `server/src/modules/commissions/routes.ts` through `/dashboard`.
- `filtersFromQuery` includes authenticated `req.user.role` and `req.user.id`.
- `getRepCommissionDashboard` calls `effectiveRepForRepDashboard`.
- If role is `rep`, the effective rep is always `filters.userId`; supplied `repId` is ignored.
- Earned SQL filters `dsc.rep_user_id = effectiveRep`.
- Pipeline SQL filters `d.assigned_rep_id = effectiveRep`.
- UI exposes no rep selector and no team aggregate dollars.

## Privacy Result
- A rep cannot query another rep's dashboard through the `repId` query parameter.
- The table rows returned to the page are limited to the authenticated rep's signed commission rows and assigned unsigned pipeline deals.

## Remaining Access Note
- The existing app route still allows admin/director roles to mount `RepCommissionsPage`; that predates this track. The page no longer offers admin/director rep selection. Changing sidebar/app role exposure would touch shared layout/navigation and is outside the hard-rule scope.

## Verification To Rerun
- Typecheck
- Focused client/server/migration vitest
- All commission-named tests
