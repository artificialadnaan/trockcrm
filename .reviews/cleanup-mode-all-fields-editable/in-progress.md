# Cleanup Mode All Fields Editable - In Progress

- Branch: `feat/cleanup-mode-all-fields-editable`
- Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/feat-cleanup-mode-all-fields-editable`
- Scope:
  - Allow cleanup-mode edits to bypass the post-RFP scope-readonly guard in both `PATCH /api/deals/:id` and `PATCH /api/deals/:id/resolved-fields`
  - Preserve the existing cleanup trigger requirements: legacy deal, missing relationship, and actual value-change repair
  - Add `legacy_cleanup_scope_change` audit rows for cleanup-mode edits that touch scope-locked fields
  - Add focused regression coverage only; no broad `server/src/modules/deals/service.ts` lineage changes
- Coordination notes:
  - Do not touch unrelated `.reviews/*/in-progress.md` scopes
  - Keep mismatch validation for `propertyId`/`companyId` intact
