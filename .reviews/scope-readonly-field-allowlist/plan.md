# SCOPE_READ_ONLY_AFTER_RFP Field-Allowlist Hotfix Plan

Date: 2026-05-15
Branch: `hotfix/scope-readonly-field-allowlist`

## Assumptions

- The existing lock-state calculation in `server/src/modules/deals/scoping-service.ts` is correct and must remain unchanged.
- The hotfix should narrow **what** the post-RFP lock blocks, not **when** it activates.
- `description` and `bidDueDate` are operational metadata for this policy, even though they are edited inside the scoping workspace.
- File metadata edits on locked deals should remain allowed even for `scope_docs` / `site_photos`; only replacement, relink, upload, delete, restore, and new-version actions stay locked.

## Single source of truth

- Add a shared allowlist/guard helper under `shared/src/types/` so both server and client can consume the same scope-locked field definitions.
- The shared module will define:
  - locked direct deal patch fields
  - locked resolved-field names
  - locked scoping workspace sections/fields
  - locked file mutation categories/actions
  - helper predicates used by route and UI guards

## Planned changes by file

### 1. `shared/src/types/<new scope lock file>`

- Create one shared module for field/action allowlist decisions.
- Keep the locked set intentionally small:
  - direct patch: `companyId`, `sourceLeadId`, `workflowRoute`, `projectType`, `projectTypeId`, `propertyId`, `name`
  - resolved fields: `companyId`, `workflowRoute`, `projectTypeId`, `propertyId`, `propertyName`, `preBidMeetingCompleted`, `siteVisitDecision`, `siteVisitCompleted`, `estimatorConsultationNotes`
  - scoping workspace sections: `opportunity`, `scope`, `attachments`
  - file actions: upload/link/new version/delete/restore for submitted scoping attachments
- Leave all other fields implicitly editable.

### 2. `server/src/modules/deals/routes.ts`

- Replace the current hardcoded `SCOPING_BACKED_DEAL_PATCH_FIELDS` behavior with shared helper checks.
- `PATCH /api/deals/:id`:
  - only call `assertDealScopingWriteAllowed()` when the incoming payload contains a locked direct field.
  - allow `description`, `expectedCloseDate`, `primaryContactId`, address fields, and estimates to pass through on locked deals.
- `PATCH /api/deals/:id/resolved-fields`:
  - inspect the actual keys being written.
  - only enforce the lock when one of the patched resolved fields is in the locked set.
  - preserve admin `forceEditAfterRfp` override audit logging for locked-field writes.

### 3. `server/src/modules/files/routes.ts`

- Replace blanket file mutation lock checks with action/category-aware checks.
- Keep blocking:
  - uploading / confirming / linking files into `scope_docs` or `site_photos`
  - new-version, delete, restore for submitted scoping files
- Allow:
  - metadata updates
  - filename/description/tag/category/folder edits
  - photo address correction
- Preserve admin override logging for locked file actions only.

### 4. `client/src/components/deals/deal-scoping-workspace.tsx`

- Replace `editingDisabled` blanket behavior with field-level disable flags.
- Keep locked in readonly mode:
  - opportunity review section
  - scope item selector / project type
  - scope docs + site photos upload/link actions
- Unlock in readonly mode:
  - bid due date
  - property change
  - scope summary / description
- Keep force-edit UI behavior for admins on the truly locked controls.
- Update readonly helper text so it reflects partial lock behavior instead of whole-surface lock.

### 5. `client/src/pages/deals/deal-detail-page.tsx`

- Keep the existing readonly lock-state calculation.
- Continue passing readonly mode into the scoping workspace, but update any page-level copy/assertions as needed so the UI expectation is field-level rather than whole-form.

## TDD plan

1. Add failing route tests for:
   - locked deal direct patch allows `description`
   - locked deal direct patch still blocks `projectTypeId`
   - locked deal resolved-fields patch allows `assignedRepId`
   - locked deal resolved-fields patch still blocks `siteVisitDecision`
2. Add failing file-route tests for:
   - locked deal file metadata rename allowed
   - locked deal photo address correction allowed
   - locked deal new-version for submitted scoping file still blocked
3. Add failing workspace/UI tests for:
   - readonly workspace still disables scope item buttons
   - readonly workspace allows bid due date and scope summary inputs
   - readonly workspace allows property selector
4. Run focused tests to confirm red.

## Verification targets

- `npx vitest run server/tests/modules/deals/scoping-routes.test.ts server/tests/modules/files/audit-routes.test.ts client/src/components/deals/deal-scoping-workspace.test.ts client/src/pages/deals/deal-detail-page.test.tsx --testTimeout=15000`
- `npm run typecheck --workspace=server`
- `npm run typecheck --workspace=client`

## Scope control

- Do not modify `server/src/modules/deals/service.ts`.
- Do not change stage-transition logic except to confirm it remains outside this guard.
- Do not broaden the fix into unrelated ownership, lineage, or readiness logic.
