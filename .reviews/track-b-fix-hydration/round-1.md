# Round 1 Review - Track B Hydration Fix

## Findings

No blocking findings.

## Review Notes

- P1 hydration/data-loss path is fixed. `initialLoadFailed` is set on `loadIntake` failure, `hydrationCompleteRef.current` is forced false, and `editingDisabled` disables mutation-capable UI while the failed state is active. `updateField`, property changes, file upload/linking, and service activation also have handler-level guards, so programmatic events do not bypass the disabled UI.
- P1 saved-badge path is fixed. The status chip shows `Unable to load - retry` when `initialLoadFailed` is true, and the non-failed `Saved` label is gated by `hydrationCompleteRef.current`. The refreshed red failed-state styling is present on the chip.
- P2 hidden-error path is fixed. All current `setError` calls are centralized through `showError` for new errors or `clearError` for clears; `showError` always resets `dismissedError` to false. Autosave and property-change failures now re-show the banner after a prior dismissal.
- Form controls/actions are disabled during `initialLoadFailed`: project type select, bid due date input, opportunity selects, estimator notes textarea, property selector, scope summary textarea, file input, existing-file `Link` buttons, and service handoff button. Retry and dismiss remain intentionally available because they are recovery/banner controls rather than data mutations.
- Normal post-hydration save behavior is preserved. After a successful retry load, the test edits the scope summary and observes `patchDealScopingIntake` being called.
- Retry does not create an infinite loop on persistent failure. The only automatic `loadIntake` remains the `deal.id` effect; retry is invoked by the banner button, and a failed retry returns to `initialLoadFailed` without scheduling another retry.

## Test Coverage

The revised tests would fail for the original regressions:

- Initial load failure now asserts the form is disabled, the failed status is shown, `Saved` is absent, and no patch calls happen after an attempted edit.
- Retry success asserts editing is re-enabled only after hydration and later edits autosave.
- Dismissed autosave error coverage asserts a second autosave failure re-renders the banner.
- The old no-op test was replaced with persistence/blocking assertions.

Verification run:

```text
npx vitest run client/src/components/deals/deal-scoping-workspace.test.ts
PASS: 1 file, 9 tests

npm run typecheck --workspace=client
PASS
```
