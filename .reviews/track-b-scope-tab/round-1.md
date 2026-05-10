# Round 1 Review - Track B Scope Tab GET/Write Fix

Date: 2026-05-10
Branch: `fix/scope-tab-get-write-bug`

## Findings

No blocking findings.

## Scope Checks

- Backend GET lazy initialization now builds an `initialPatch` with seeded `sectionData` and only includes `projectTypeId` when `resolvedDeal.resolved.projectTypeId != null` (`server/src/modules/deals/scoping-service.ts:362-367`). This keeps legacy Opportunity deals with null project type from entering the write validator as an explicit clear.
- PATCH/write validation remains intact. `upsertDealScopingIntake` still calls `applyProjectTypeChange` whenever `sanitizedPatch.projectTypeId !== undefined` for non-lead deals (`server/src/modules/deals/scoping-service.ts:704-712`), so an explicit `projectTypeId: null` still reaches the existing Opportunity-stage guard and throws `projectType cannot be cleared after Opportunity`.
- Frontend initial GET failure no longer short-circuits the tab. The previous `error && !readiness` full-card return was removed, and the error now renders inline above the Scoping Workspace card (`client/src/components/deals/deal-scoping-workspace.tsx:619-723`).
- Caller sweep did not show unintended production changes to other `upsertDealScopingIntake` callers. Production callers remain the GET lazy initializer in `scoping-service.ts` and the PATCH route in `server/src/modules/deals/routes.ts:410-415`; tests call it directly.

## Test Coverage Reviewed

- Added server regression coverage for legacy Opportunity GET/lazy initialization with `projectTypeId: null`, asserting the intake is created and the deal project type remains null.
- Added server regression coverage that direct write/PATCH semantics still reject explicit `projectTypeId: null` after Opportunity with the exact message `projectType cannot be cleared after Opportunity`.
- Added frontend regression coverage that a failed initial intake request still renders `Scoping Workspace`, `Project Type`, and `Scope Summary`, while surfacing the error message inline.

## Verification

- `npm run test --workspace=server -- tests/modules/deals/scoping-service.test.ts`
  - Passed: 1 file, 15 tests.
- `npx vitest run client/src/components/deals/deal-scoping-workspace.test.ts`
  - Passed: 1 file, 6 tests.
