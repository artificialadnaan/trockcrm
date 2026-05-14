# New Service Opportunity - In Progress

- Branch: `feat/new-service-opportunity`
- Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/feat-new-service-opportunity`
- Base: `fix/pipeline-display` at `24f9c1c1bfd544af99620f79c87af377dd7ac12d`
- Started: 2026-05-14
- Files-touched list, expected:
  - Deals page header component: `client/src/pages/deals/deal-list-page.tsx`
  - New opportunity form component: to be confirmed during discovery
  - Opportunity creation API endpoint: to be confirmed during discovery
  - RFP eligibility logic: to be confirmed during discovery
  - Project type enum/options: read-only unless discovery proves an existing Service constant needs reuse
  - `scripts/smoke-new-service-opportunity.ts`
  - `.reviews/new-service-opportunity/discovery.md`
  - `.reviews/new-service-opportunity/final.md`
- Migrations: NONE expected
- Permission-system changes: NONE
- Estimated merge ETA: same working session after discovery, implementation, 3 review rounds, rebase, PR, self-merge, Railway deploy watch, and production smoke.

## Coordination Notes

- `fix/pipeline-display` owns removal of the visible `+ New Deal` Deals-page entry point and currently has uncommitted work in `/Users/adnaaniqbal/projects/trockcrm/.worktrees/fix-pipeline-display`.
- This branch is based on the committed `fix/pipeline-display` head because uncommitted changes cannot be safely used as a branch base. Before merge, this branch will rebase onto latest `origin/main`; if `fix/pipeline-display` is still unmerged, it will be rebased/stacked on that branch before self-merge.
- This branch must not remove the existing New Deal form, route, or underlying creation logic.
