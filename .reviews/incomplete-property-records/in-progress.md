# In Progress: Incomplete Property Records

- Branch: `fix/incomplete-property-records`
- Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/fix-incomplete-property-records`
- Files expected to touch:
  - Lead form property dropdown component(s)
  - Deal scoping form property dropdown / property details component(s)
  - Property validation logic used by lead/deal form submission
  - Property update route/service/schema if reps cannot currently enrich partial addresses
  - `scripts/smoke-incomplete-property.ts`
- Migrations: POSSIBLE. Discovery will determine whether a persisted incomplete-address flag is needed; default assumption is no migration unless query performance or existing patterns require it.
- Permission-system changes: NONE expected. Discovery will confirm whether current property update authorization blocks reps and whether a narrow property-enrichment allowance is needed in existing policy.
- Coordination risk:
  - `fix/lead-form-field-batch` may touch surrounding lead form layout.
  - `fix/scoping-form-ux` may touch surrounding deal scoping form layout.
  - This branch should own only property selection, incomplete-property warning, inline address enrichment, and related validation.
- Estimated merge ETA: Same-day hotfix after discovery, focused tests, 2-3 review rounds, rebase, deploy, and production smoke.
