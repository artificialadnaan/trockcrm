# Track F1 Internal Review - Review 1

## Findings

1. **P2 - OAuth callback messages were dropped.**
   The previous page read `connected=true` and `error` from the URL and displayed success/failure messages after the Microsoft OAuth redirect. The new page removed `useSearchParams`, so users lose immediate feedback after connecting or failing to connect email.

2. **P2 - Header Microsoft 365 button is decorative.**
   The preview-style header includes a Microsoft 365 button, but the implementation does not call the existing Graph consent flow. A visible command must either do the real action or be removed.

3. **P3 - Thread assignment remains available but lower-discoverability.**
   The existing `EmailThreadView` is still reachable via `Thread tools`, which preserves functionality. This is acceptable for the polish pass, but production smoke should click it once if a threaded message is available.

## Required Fixes

- Restore OAuth callback success/error messages.
- Wire the Microsoft 365 header action to the existing `useGraphAuth().startConsent` flow, with disabled/connected state.
