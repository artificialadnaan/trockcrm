# Login Redesign Discovery

Timestamp: 2026-05-12 America/Chicago

## Scope

Frontend-only cosmetic replacement of the unauthenticated CRM login page. Backend auth, cookie, CSRF, force-password-change, and cleanup/onboarding redirect logic stay unchanged.

## Findings

- Current login component: `client/src/components/auth/auth-entry-screen.tsx`.
- Current auth call: `localLogin(email, password, returnTo)` from `client/src/lib/auth.tsx`, which posts to `/auth/local/login`.
- Redirect handling:
  - `AuthEntryScreen` still honors `returnTo` from the query string when local login returns a redirect.
  - `client/src/App.tsx` handles `user.mustChangePassword` by rendering `ForcePasswordChangeScreen`.
  - `client/src/App.tsx` handles `user.requiresOnboarding` by routing to `/onboarding-required`, which redirects to the cleanup workspace.
- Brand asset: `client/public/logo.png`, referenced as `/logo.png`.
- Brand red: `brand.red` in `client/tailwind.config.ts` is `#CC0000`.
- Icon library: `lucide-react`; selected `Zap`, `Camera`, `ShieldCheck`, `ArrowRight`, and `Loader2`.
- Dev login UI was still present in the login component via `/auth/dev/users` and quick-login buttons. The redesign removes this unauthenticated UI path per prompt.

## Implementation Assumptions

- The username field continues using the existing `email` state and `type="email"` because production smoke credentials are email addresses and the backend contract is unchanged.
- Empty field handling uses native HTML `required` validation to preserve Enter-key form submission while preventing empty posts.
- No register, sign-up, forgot-password, dev-mode, or quick-login UI is added.
