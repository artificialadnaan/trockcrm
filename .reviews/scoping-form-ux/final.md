# Scoping Form UX Final

Date: 2026-05-14

## Deployment

- PR: `#308` - `https://github.com/artificialadnaan/trockcrm/pull/308`
- Branch commit: `8e1a879532cb0a2e84287fa150fb9d611fe7fb20`
- Merged main SHA: `71833355d65248dc05ca2799251e77c91f7e1135`
- Railway production status after merge:
  - `Frontend`: `38a911c0-9216-436a-89c5-7c2faa10b28a` - `SUCCESS`
  - `API`: `fd3b1da4-53cc-4cb1-a20e-f96a751b4451` - `SUCCESS`
  - `Worker`: `ac62f2fe-a2df-4b85-9658-7c788f160927` - `SUCCESS`
  - `trockcrm-field`: `ee054cce-61ce-4ef0-a299-4cc2e17a6142` - `SUCCESS`
  - `Postgres`: `93aa1a66-2a4a-41f7-ab15-016ba20750e0` - `SUCCESS`

## Local Verification

- `npx vitest run client/src/components/deals/deal-scoping-workspace.test.ts client/src/lib/scoping-intake.test.ts` - passed, 24 tests.
- `npx vitest run server/tests/modules/deals/scoping-rules.test.ts server/tests/modules/deals/scoping-service.test.ts server/tests/modules/deals/stage-gate.test.ts` - passed, 93 tests.
- `npm run typecheck --workspace=client` - passed.
- `npm run typecheck --workspace=server` - passed.
- `npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --types node scripts/smoke-scoping-form-ux.ts` - passed.
- `git diff --check` - passed.

## Production Smoke

- Command: `node --import tsx scripts/smoke-scoping-form-ux.ts --origin=https://trockcrm.com`
- Result: passed.
- Smoke fixture: synthetic `SMOKE TEST DELETE - Scoping Form UX ...` company, property, and deal.
- Cleanup: script completed with exit code 0 after deleting the synthetic deal, property, and company.
- Smoke output:

```text
[smoke] created SMOKE TEST DELETE - Scoping Form UX 2026-05-14T18:58:34.974Z (63b5872d-d8ce-43bd-8dbc-3386ad070275) using Roofing
[smoke] scoping form UX smoke passed
```

## Bug 1 - Sidebar Nav / Blocking Items

Before:

- Scoping Progress rows were static status rows.
- Blocking Items were static text.

After:

- Scoping Progress rows are buttons that smooth-scroll to section ids.
- Blocking Items rows are buttons that smooth-scroll to field ids.
- Production smoke clicked each section row and a specific `Scope: Selected Scope Items` blocking row and verified scroll target behavior without page navigation.

## Bug 2 - Scope Docs / Site Photos Optional

Before:

- `Scope docs` and `Site photos` were required readiness blockers and appeared in Blocking Items.

After:

- Both attachment types remain visible in the Attachments card as optional upload/link opportunities.
- Both are removed from hard readiness validation and from Blocking Items.
- Production smoke verified no `Required` badge for either attachment and readiness can become `ready` without those files.

## Bug 3 - Scope Section / Inline Save

Before:

- Scope selection was represented only by the smaller Project Type control.
- Autosave response rehydration could disrupt active editing.
- Server readiness did not require an explicit scope item.

After:

- Added a distinct required `Scope` card with instruction text: `Select at least one scope item that applies to this project. You can choose multiple.`
- Scope items are multi-select buttons backed by `sectionData.scope.selectedProjectTypeIds`.
- Legacy `projectTypeId` still seeds existing deals for compatibility.
- Reps at Opportunity can update Scope JSON without attempting blocked legacy `projectTypeId` writes.
- Server readiness requires at least one scope item, while still accepting legacy `projectTypeId` for existing rows.
- Production smoke selected a scope item and verified URL/scroll stability plus subtle save status.
- Production smoke verified zero selected scope items blocks RFP trigger with a scope validation error.

## Estimator Notes Coordination

- This branch did not change Estimator Consultation Notes field internals.
- Rebase picked up the parallel estimator-notes autosave stale-response guard from `origin/main`.
- Conflict resolution preserved that in-flight/stale-response guard and applied this branch's scope-save pattern on top: update local scope state immediately, persist through existing debounced autosave, update readiness metadata from the response, and do not replace local `sectionData` with an older autosave response.
- Rebased client tests include the estimator-notes stale-response regression and passed.

## Accepted Risks / Deferred Items

- No migrations were added.
- No permission-system changes were added.
- The production smoke uses the custom frontend origin `https://trockcrm.com`; the Railway frontend host alone is not the right smoke origin for browser auth.
- The smoke script was corrected after merge for production-origin cookie handling and fixture targeting. The production app code was already deployed before smoke; the script-only correction should be carried forward so future smoke runs use the same successful path.
