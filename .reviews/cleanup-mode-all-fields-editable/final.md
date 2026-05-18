# Cleanup Mode All Fields Editable - Final

## What Changed

- Cleanup detection now requires all of the following:
  - legacy deal (`sourceLeadId` is missing)
  - at least one missing relationship (`companyId` or `propertyId`)
  - an actual repair value-change for the missing relationship
- When that cleanup condition is met, both `PATCH /deals/:id` and `PATCH /deals/:id/resolved-fields` bypass the post-RFP scope-readonly guard.
- Non-cleanup edits still go through the existing post-RFP lock behavior.
- Cleanup-mode scope edits now emit an audit-log row with `action='legacy_cleanup_scope_change'`.
- Property/company mismatch validation still runs when relationship ids are changed.

## Review Rounds

- Round 1: found and fixed parity gaps between the direct patch route and resolved-fields route.
- Round 2: no findings on cleanup audit logging, actual-repair gating, or mismatch validation.
- Round 3: found and fixed missing regression coverage for non-legacy lock behavior and unchanged-relationship resolved-field payloads.

## Verification

- Focused cleanup regressions:
  - `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/patch-route.test.ts server/tests/modules/deals/scoping-routes.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
  - Result: pass
- Server typecheck:
  - `npm run typecheck --workspace=server`
  - Result: pass
- Broader deals suite:
  - `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/ --testTimeout=15000 --exclude '.worktrees/**'`
  - Result: unrelated pre-existing failures remain in `post-conversion-enrichment.test.ts` (shared schema mock missing `contacts`) and `contract-signed-date-route.test.ts` (expectations outdated vs current `auditContext` route signature)

## User Smoke Test

1. Open the cleanup queue.
2. Pick a legacy deal that needs scope, region, or project type cleanup.
3. Open the cleanup modal.
4. Edit company and region and project type.
5. Save and confirm all changes persist.
6. Verify `audit_log` has an entry tagged `legacy_cleanup_scope_change`.
7. Open a non-legacy RFP'd deal and try to edit scope; confirm it is still blocked.

## Release Status

- PR: `#380`
- Merge status: blocked pending either Codex review feedback or explicit approval to merge without that review response
