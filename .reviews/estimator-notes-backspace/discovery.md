# Estimator Consultation Notes Backspace / Character Loss Discovery

Date: 2026-05-14  
Branch: `fix/estimator-notes-backspace`

## Summary

The deal scoping workspace autosave can overwrite newer local textarea input with an older server echo. The failure is consistent with the reported behavior: the field saves correctly once the user stops, but characters typed while an autosave request is in flight can disappear mid-word when that older response resolves and calls `setSectionData(...)`.

Assumption documented for the fix: local browser input must be authoritative while the user has typed changes newer than the autosave request that is currently resolving.

## Component and Field Locations

- Deal detail tab renders the scoping workspace:
  - `client/src/pages/deals/deal-detail-page.tsx`
  - `DealScopingWorkspace` is imported at line 49 and rendered under the `scoping` tab around line 867.
- Deal scoping form component:
  - `client/src/components/deals/deal-scoping-workspace.tsx`
- Estimator Consultation Notes field:
  - `client/src/components/deals/deal-scoping-workspace.tsx:1065-1080`
  - `Textarea` id: `estimatorConsultationNotes`
  - Value source: `getSectionValue(sectionData, "opportunity", "estimatorConsultationNotes")`
  - Change handler: `updateField("opportunity", "estimatorConsultationNotes", event.target.value)`
- Related textarea sharing the same root cause:
  - `client/src/components/deals/deal-scoping-workspace.tsx:1125-1134`
  - `Textarea` id: `scopeSummary`
  - Same `sectionData` state and autosave response merge.

## State Management

- The scoping workspace uses local React state, not react-hook-form:
  - `intake`: `client/src/components/deals/deal-scoping-workspace.tsx:358`
  - `readiness`: line 359
  - `resolvedFields`: line 360
  - `sectionData`: line 361
  - `projectTypeId`: line 362
  - `saveState`: line 370
- Field edits call `updateField`:
  - `client/src/components/deals/deal-scoping-workspace.tsx:635-646`
  - This merges the changed field into `sectionData` and clears any visible error.

## Autosave Mechanism

- Autosave effect:
  - `client/src/components/deals/deal-scoping-workspace.tsx:518-584`
- Debounce timing:
  - `window.setTimeout(..., 400)` at line 536 and cleared on dependency changes at line 583.
- Change detection:
  - Computes `fingerprint = JSON.stringify({ projectTypeId, sectionData })` at line 531.
  - Skips if equal to `lastSavedFingerprintRef.current` at lines 532-534.
- API calls:
  - For converted deals with source leads, lead-owned fields are saved through `patchResolvedDealFields(...)` at lines 539-553.
  - Scoping-owned data is saved through `patchDealScopingIntake(...)` at lines 555-565.
- Payload shape:
  - `buildScopingAutosavePatch(...)` at `client/src/components/deals/deal-scoping-workspace.tsx:267-284`
  - Non-converted deals send `{ projectTypeId, sectionData }`.
  - Converted deals send only `{ sectionData: { opportunity: ... } }` so source-lead fields are not shadow-written.
- Server route:
  - `server/src/modules/deals/routes.ts:800-840`
  - `PATCH /api/deals/:id/scoping-intake`
- Server save:
  - `server/src/modules/deals/scoping-service.ts:860-967`
  - Builds merged `nextSectionData`, persists `deal_scoping_intake`, and returns `{ intake, readiness, previousStatus, resolved }`.
- Timestamp storage:
  - `shared/src/schema/tenant/deal-scoping-intake.ts:25`
  - `lastAutosavedAt` drives the “Last saved …” detail text.

## Full Data Flow

1. User types in `Estimator Consultation Notes`.
2. `onChange` calls `updateField("opportunity", "estimatorConsultationNotes", value)`.
3. `sectionData` updates immediately, making the textarea controlled by the newest local value.
4. The autosave effect sees a new fingerprint and schedules a 400ms PATCH.
5. The timeout callback closes over the `sectionData` snapshot from the render that scheduled it.
6. The PATCH sends that snapshot to `/api/deals/:id/scoping-intake`.
7. If the user continues typing while the request is in flight, local `sectionData` becomes newer than the request payload.
8. When the older request resolves, current code rebuilds workspace data from the server echo and calls:
   - `setSectionData(nextSectionData)` at `client/src/components/deals/deal-scoping-workspace.tsx:570`
9. That overwrites any characters typed after the request was sent.

## Root Cause Confirmation

The root cause is the unconditional server echo merge after autosave:

- `client/src/components/deals/deal-scoping-workspace.tsx:566-570`
  - `const nextSectionData = buildWorkspaceSectionData(deal, result.intake, result.resolved);`
  - `setIntake(result.intake);`
  - `applyReadiness(result.readiness, true);`
  - `setResolvedFields(result.resolved);`
  - `setSectionData(nextSectionData);`

Because the autosave request is debounced and asynchronous, the response can be older than the current textarea value. There is no guard comparing the request fingerprint to the latest local fingerprint before applying `setSectionData`.

## Affected Fields and Components

Directly affected:

- `Estimator Consultation Notes` (`opportunity.estimatorConsultationNotes`) because it is a textarea on the autosaved deal scoping workspace.
- `Scope Summary` (`scopeSummary.summary`) because it shares the same `sectionData` state and same autosave echo merge.
- Any other editable scoping workspace inputs that write through `updateField` can be reverted by an older autosave echo if the user changes them while an earlier request is in flight, though the bug is most visible in free-text fields.

Related fields checked:

- Lead scoping workspace:
  - `client/src/components/leads/lead-scoping-workspace.tsx:62-251`
  - Uses local `sectionData` plus an explicit Save button. It does call `refetch()` after save, but it does not have the 400ms autosave loop that can repeatedly echo stale server values during natural typing.
- Lead Name:
  - `client/src/components/leads/lead-form.tsx:1560-1568`
  - Standard controlled `Input` backed by `formData.name` and `handleFieldChange`; no deal-scoping autosave echo path found.
- Life Safety on lead form:
  - The lead form uses ordinary controlled questionnaire/section inputs; no matching debounced server echo path was found in the lead form during discovery. If a parallel branch has converted this field to a dropdown, it is outside this root cause.

## Fix Direction

Smallest blast-radius fix:

1. Keep the server response for metadata (`intake`, `readiness`, `resolved`) only when the latest local fingerprint still equals the request fingerprint.
2. Skip `setSectionData(nextSectionData)` when local state changed while the request was in flight, so the browser-owned value wins.
3. Serialize scoping autosaves so a second PATCH cannot be sent while an older PATCH is still in flight. This prevents request B (newer text) from persisting first and request A (older text) from persisting last.
4. If local state changed during an in-flight save, schedule a follow-up autosave after the in-flight save completes.

This preserves initial hydration and explicit reload behavior while preventing both stale response rehydration and out-of-order server-side stale writes.
