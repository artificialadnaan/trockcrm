# Track B-FIX2 Recovery Review - Round 1

Verdict: clean

No blocking issues found.

## Findings Verification

1. Retry control accessible after banner dismissal: fixed.
   - The persistent `Retry loading scope` button is rendered in the Scoping Progress card when `initialLoadFailed` is true, outside the dismissible error banner: `client/src/components/deals/deal-scoping-workspace.tsx:728`.
   - The dismissible banner still has its own retry button, but it is no longer the only retry path: `client/src/components/deals/deal-scoping-workspace.tsx:771`.
   - Test coverage dismisses the banner, verifies the failure message is hidden, then finds and clicks the remaining retry button: `client/src/components/deals/deal-scoping-workspace.test.ts:556`.

2. Stale failures cannot mutate state: fixed.
   - `loadRequestIdRef` is incremented before the awaited GET: `client/src/components/deals/deal-scoping-workspace.tsx:424`.
   - The catch path checks `requestId !== loadRequestIdRef.current` and returns before mutating hydration, initial-load, save, or error state: `client/src/components/deals/deal-scoping-workspace.tsx:454`.
   - Test coverage resolves the second request first, rejects the first request later, and verifies the stale error does not render or disable the form: `client/src/components/deals/deal-scoping-workspace.test.ts:603`.

3. Refresh-load failures do not freeze the form: fixed.
   - `wasInitialHydration` is captured before the await: `client/src/components/deals/deal-scoping-workspace.tsx:427`.
   - The catch path only sets `initialLoadFailed=true` and resets hydration when `wasInitialHydration` is true; refresh failures after hydration force `initialLoadFailed=false`: `client/src/components/deals/deal-scoping-workspace.tsx:458`.
   - Test coverage hydrates the form, triggers a refresh failure, verifies the initial-load failure chip is absent, and confirms the form remains editable/autosave-capable: `client/src/components/deals/deal-scoping-workspace.test.ts:705`.

4. Stale successes cannot mutate state: fixed.
   - The success path checks `requestId !== loadRequestIdRef.current` immediately after the awaited GET and returns before setting intake, readiness, resolved fields, section data, project type, fingerprint, hydration, or save state: `client/src/components/deals/deal-scoping-workspace.tsx:433`.
   - Test coverage resolves the newer request with `NEW`, then resolves the stale request with `OLD`, and verifies `OLD` never replaces the rendered value: `client/src/components/deals/deal-scoping-workspace.test.ts:652`.

## Track B-FIX Behavior Preservation

- First-load failure still disables form: `editingDisabled` is still derived only from `initialLoadFailed`, and form controls use it for disabled state: `client/src/components/deals/deal-scoping-workspace.tsx:392`, `client/src/components/deals/deal-scoping-workspace.tsx:1028`. The existing regression test verifies the summary field is disabled and autosave endpoints are not called after initial load failure: `client/src/components/deals/deal-scoping-workspace.test.ts:397`.
- Status chip still does not show `Saved` on failed initial load: `saveStatusLabel` prioritizes `initialLoadFailed` before checking hydration state: `client/src/components/deals/deal-scoping-workspace.tsx:393`. Tests assert `Unable to load - retry` and not `Saved`: `client/src/components/deals/deal-scoping-workspace.test.ts:397`, `client/src/components/deals/deal-scoping-workspace.test.ts:536`.
- Dismissed banner still re-shows on new errors: `showError()` sets `setDismissedError(false)`: `client/src/components/deals/deal-scoping-workspace.tsx:414`. Existing test coverage dismisses the first autosave error, triggers a second error, and verifies the second message appears: `client/src/components/deals/deal-scoping-workspace.test.ts:486`.
- No silent data loss / autosave gate preserved: autosave still returns until `hydrationCompleteRef.current` is true, then still applies the lineage safety gate through `canAutosaveScopingWorkspace`: `client/src/components/deals/deal-scoping-workspace.tsx:478`. Initial-load failure leaves hydration false and disables edits; refresh failure after hydration keeps the existing hydrated state editable and autosave-capable without setting `initialLoadFailed`: `client/src/components/deals/deal-scoping-workspace.tsx:458`.

## Test Quality

- The new tests map directly to the four original regressions: retry-after-dismissal at `client/src/components/deals/deal-scoping-workspace.test.ts:556`, stale failure at `client/src/components/deals/deal-scoping-workspace.test.ts:603`, stale success at `client/src/components/deals/deal-scoping-workspace.test.ts:652`, and refresh failure after hydration at `client/src/components/deals/deal-scoping-workspace.test.ts:705`.
- Race tests are deterministic. They use explicit deferred promises and controlled resolve/reject ordering rather than timing assumptions for the races: `client/src/components/deals/deal-scoping-workspace.test.ts:197`, `client/src/components/deals/deal-scoping-workspace.test.ts:621`, `client/src/components/deals/deal-scoping-workspace.test.ts:638`, `client/src/components/deals/deal-scoping-workspace.test.ts:670`, `client/src/components/deals/deal-scoping-workspace.test.ts:686`.
- No new state variable creates a consistency issue. The only added component state primitive is a ref (`loadRequestIdRef`), used solely as a monotonic request identity and guarded in success, catch, and finally: `client/src/components/deals/deal-scoping-workspace.tsx:367`, `client/src/components/deals/deal-scoping-workspace.tsx:424`, `client/src/components/deals/deal-scoping-workspace.tsx:435`, `client/src/components/deals/deal-scoping-workspace.tsx:455`, `client/src/components/deals/deal-scoping-workspace.tsx:467`.
- `loadRequestIdRef` is incremented before the await, not after: `client/src/components/deals/deal-scoping-workspace.tsx:424`.

## Verification

Focused test run passed:

```bash
npx vitest run client/src/components/deals/deal-scoping-workspace.test.ts
```

Result: 1 test file passed, 13 tests passed.
