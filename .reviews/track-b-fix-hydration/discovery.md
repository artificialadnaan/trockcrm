# Track B Fix-Forward Discovery - Scope Tab Hydration and Banner

Date: 2026-05-10
Branch: fix/scope-tab-hydration-and-banner
Base: b629551, includes PR #205 merge 3cda068.

## Current State Model

Primary component: `client/src/components/deals/deal-scoping-workspace.tsx`.

State variables:
- `intake`: latest scoping intake returned by `GET /api/deals/:id/scoping-intake` or autosave.
- `readiness`: normalized readiness state returned by GET/PATCH.
- `resolvedFields`: source-lead/deal resolved fields returned by GET/PATCH.
- `sectionData`: editable workspace field values.
- `projectTypeId`: currently selected project type.
- `intendedProjectNumber`: derived intended project number from project type.
- `loading`: initial load spinner.
- `error`: one string used for initial load and autosave/property-change errors.
- `dismissedError`: suppresses the error banner.
- `saveState`: `"idle" | "saving" | "saved" | "error"`.
- `uploadingKey`, `activatingService`: attachment/service action states.
- `lastSavedFingerprintRef`: last persisted project type + section data fingerprint.
- `hydrationCompleteRef`: autosave gate; false before successful hydration, true only after successful `loadIntake`.

`setError()` call sites found:
- `loadIntake` catch: sets load error and resets `dismissedError`.
- autosave catch: sets autosave error but does not reset `dismissedError`.
- `handlePropertyChange` catch: sets property-change error but does not reset `dismissedError`.
- `updateField`: clears error and resets `dismissedError`.

`saveState` mutation:
- initial value `"idle"`.
- `loadIntake` success sets `"idle"`.
- autosave timeout sets `"saving"`, then `"saved"`, then schedules `"idle"`.
- autosave catch sets `"error"`.
- property change sets `"saving"`, then `"saved"` and schedules `"idle"`, or `"error"` on catch.

Status chip rendering:
- Fixed top-right chip maps `"idle"` to `"Saved"`.
- `"saving"` -> `"Saving..."`.
- `"saved"` -> `"Saved"`.
- `"error"` -> `"Save failed"`.
- No load-failure state is represented.

Hydration gate:
- `hydrationCompleteRef.current = false` on deal id change.
- `hydrationCompleteRef.current = true` only on successful `loadIntake`.
- Autosave effect returns early when `!hydrationCompleteRef.current`.
- Therefore, if initial GET fails, form controls can render but autosave cannot fire.

## Failure Scenarios

### A. Initial GET fails

After PR #205:
- `loading` becomes false.
- `error` contains the GET error message.
- `dismissedError` is false, so the banner renders.
- `hydrationCompleteRef.current` remains false.
- `saveState` remains `"idle"`.
- Form controls are editable.
- Autosave effect returns early because hydration never completed.
- Status chip displays `"Saved"` because idle maps to Saved.

This is the silent data loss path.

### B. Initial GET succeeds, autosave fails after dismissed banner

Current behavior:
- First autosave failure sets `error` but does not reset `dismissedError`.
- If the user previously dismissed a banner, subsequent autosave/property-change errors can be hidden.

### C. Initial GET fails, then network recovers

Current behavior:
- There is no retry button or explicit recovery path in the component.
- The only natural recovery is page refresh or remount.
- A successful future `loadIntake` would set hydration true, but the user cannot trigger it from the failed state.

## Strategy

Use the safest data-integrity approach requested in the prompt:

1. Add an explicit `initialLoadFailed` state.
   - Set true when `loadIntake` catch runs.
   - Set false only after successful `loadIntake`.
   - Reset false at the start of a new load attempt.

2. Keep the form visible but disable all inputs/actions while `initialLoadFailed` is true.
   - Banner dismissal must not re-enable editing.
   - Add retry button in the banner.
   - Retry calls `loadIntake` and only a successful load enables autosave-capable editing.

3. Make status chip honest.
   - If `initialLoadFailed`, show "Unable to load - retry".
   - Do not show "Saved" unless hydration completed and the latest state is not failed.

4. Centralize error display.
   - Add `showError(message)` helper that calls `setError(message)` and `setDismissedError(false)`.
   - Use it for initial load, autosave, and property-change errors.
   - Keep clear paths separate with `clearError()`.

5. Replace the Track B no-op test with persistence-oriented tests.
   - Load failure disables controls and prevents save calls.
   - Retry success hydrates and allows later autosave.
   - New autosave errors re-show a dismissed banner.
   - Load failure status chip is not "Saved".
