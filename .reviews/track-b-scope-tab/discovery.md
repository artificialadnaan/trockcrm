# Scope Tab GET Write Bug Discovery

Date: 2026-05-10
Branch: fix/scope-tab-get-write-bug

## GET path

- `server/src/modules/deals/routes.ts:398-406` registers `GET /api/deals/:id/scoping-intake`.
- The handler calls `getOrCreateDealScopingIntake(req.tenantDb!, req.params.id, req.user!.id)`.
- This is not a read-only fetch. It lazy-initializes a `deal_scoping_intake` row when one does not exist.

## Lazy initialization behavior

- `server/src/modules/deals/scoping-service.ts:337-372` checks for an existing intake.
- Existing intake path:
  - loads resolved deal
  - asserts scoping is editable
  - evaluates readiness
  - returns the existing intake
- Missing intake path:
  - loads resolved deal
  - asserts scoping is editable
  - calls `upsertDealScopingIntake(...)`
  - currently passes `projectTypeId: resolvedDeal.resolved.projectTypeId`
  - for legacy Opportunity deals this can be `null`

## Upsert call sites

- `server/src/modules/deals/scoping-service.ts:363` from `getOrCreateDealScopingIntake` lazy initialization.
- `server/src/modules/deals/routes.ts:415` from `PATCH /api/deals/:id/scoping-intake`.
- Tests call `upsertDealScopingIntake` directly in `server/tests/modules/deals/scoping-service.test.ts`.

## Validator path

- `server/src/modules/deals/scoping-service.ts:701-709` builds deal writebacks and calls `applyProjectTypeChange` only when:
  - the deal does not have a source lead, and
  - `sanitizedPatch.projectTypeId !== undefined`
- `undefined` means "do not change project type".
- `null` means "clear project type".
- `server/src/modules/deals/service.ts:298-304` correctly rejects clearing project type at/after Opportunity with `projectType cannot be cleared after Opportunity`.

Conclusion: the validator behavior is correct for PATCH/write paths. The bug is the GET lazy initializer passing `null` instead of omitting `projectTypeId`.

## Frontend error behavior

- `client/src/components/deals/deal-scoping-workspace.tsx:389-419` calls `getDealScopingIntake` on mount.
- The API helper surfaces errors as `err.message`; this component stores only the message string.
- `client/src/components/deals/deal-scoping-workspace.tsx:618-625` renders a Card containing only that error when `error && !readiness`.

Conclusion: the frontend currently turns a recoverable initial-load error into a full-tab dead end. There is no structured error code in this component path.
