# Track B-FIX2 Recovery Discovery

Date: 2026-05-10
Branch: fix/scope-tab-recovery-edge-cases

## Source Issue

Track B-FIX added `initialLoadFailed` to prevent editing unsaved scoping-intake data
after the first GET failed. Codex then flagged four recovery/race regressions:

1. Dismissing the initial-load error banner removes the only retry control.
2. Stale request failures can still mutate state after a newer successful load.
3. Refresh-load failures after hydration can incorrectly freeze the form as though
   the initial load failed.
4. Stale request successes can overwrite newer rendered state.

## Affected Component

Primary file: `client/src/components/deals/deal-scoping-workspace.tsx`

Current Track B-FIX state before this patch:

- `initialLoadFailed` gates editing and status-chip text.
- `hydrationCompleteRef` gates autosave until a successful initial load.
- `loadIntake()` has no request identity guard.
- `loadIntake()` always sets `initialLoadFailed=false` at start.
- `loadIntake()` always sets `hydrationCompleteRef=false` and
  `initialLoadFailed=true` in `catch`, regardless of whether the failure was an
  initial hydration failure or a refresh failure after hydration.
- The retry button is rendered only inside the dismissible error banner.

## Fix Strategy

1. Add `loadRequestIdRef` and increment it before every `await` in `loadIntake()`.
   Each request captures its own id. Success, catch, and finally paths return
   without mutating state when their id is stale.
2. Capture `wasInitialHydration = !hydrationCompleteRef.current` before the GET.
   Only initial hydration loads show the full loading skeleton and are allowed to
   set `initialLoadFailed=true` on failure.
3. Preserve Track B-FIX data-integrity behavior:
   - first-load failure still disables editing
   - status chip does not show "Saved" on failed initial load
   - autosave stays gated until hydration succeeds
   - new errors reset `dismissedError` and re-show the banner
4. Add a persistent retry button in the scoping progress card when
   `initialLoadFailed` is true. The banner may be dismissed, but recovery remains
   available outside the dismissible element.

## Tests Added

File: `client/src/components/deals/deal-scoping-workspace.test.ts`

- `keeps a retry control available after dismissing the initial load error banner`
- `ignores stale load failures after a newer request has hydrated successfully`
- `ignores stale load successes after a newer request has already rendered newer data`
- `keeps the hydrated form editable and autosave-capable after a refresh load fails`

The race tests use controlled deferred promises and explicit resolution/rejection
order; they do not depend on real network timing.
