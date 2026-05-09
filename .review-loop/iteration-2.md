# Track F1 Internal Review - Iteration 2

## Diff Since Iteration 1

- Restored OAuth callback feedback for `?connected=true` and `?error=...`.
- Wired the preview-style Microsoft 365 header button to the existing `useGraphAuth().startConsent` flow.
- Added test coverage for callback feedback and the Microsoft connect action.
- Removed React act warnings from the new page tests.

## Test Results

- `npx vitest run client/src/pages/email/email-inbox-page.test.tsx`: 7 passed.
- `npm run typecheck`: passed after iteration 1 fixes.
- `ls client/src/pages/email/*.test.tsx client/src/components/email/*.test.tsx 2>/dev/null | xargs -r npx vitest run`: 12 passed after iteration 1 fixes.

## Remaining Concerns

- The email API does not expose true read/unread state, so the preview's unread indicator is backed by the available attention/unassigned signal instead of a persisted read flag.
- Thread assignment tools are preserved behind a reader action rather than being the default reader view.
