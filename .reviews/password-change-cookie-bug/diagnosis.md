# Password Change Cookie Bug Diagnosis

Generated: 2026-05-12 11:52 America/Chicago

## Assumptions

- The reported "invalid cookie" error came from users hitting one of the still-supported production frontend aliases, not the canonical same-origin `https://trockcrm.com` host.
- `https://trockcrm.com` remains the intended canonical CRM host, but `client/src/lib/api.ts` explicitly supports `frontend-production-bcab.up.railway.app` and `crm.trockconstruction.com` as production frontend fallback hosts.
- A fix must preserve CSRF protection. Disabling CSRF for `/api/auth/local/change-password` is not acceptable.

## Reproduction User

Created a throwaway production user with `must_change_password = true`:

- Email: `smoke-test-delete-password-change-1778604547966@trock.test`
- Display name: `SMOKE TEST DELETE Password Change`
- Role: `rep`
- Office: Dallas
- Local auth: enabled, invite unexpired, must-change-password required

## Canonical Host Result

Browser flow through `https://trockcrm.com/login` succeeded.

Observed request chain:

```text
GET  https://trockcrm.com/api/auth/me                         -> 401 before login
POST https://trockcrm.com/api/auth/local/login                -> 200, mustChangePassword=true
POST https://trockcrm.com/api/auth/local/change-password      -> 200, mustChangePassword=false
Final URL: https://trockcrm.com/
```

The password-change request included `X-CSRF-Token`, and cookies were valid for `trockcrm.com`.

## Alternate Production Host Result

Browser flow through `https://frontend-production-bcab.up.railway.app/login` reproduced the failure.

Observed request chain:

```text
GET  https://<prod-api-host>/api/auth/me                    -> 401 before login
POST https://<prod-api-host>/api/auth/local/login           -> 200, mustChangePassword=true
POST https://<prod-api-host>/api/auth/local/change-password -> 401 Authentication required
```

The login response body was valid and rendered the force-password-change screen, but the browser did not retain a usable API auth cookie for the next request. The change-password request had no `Cookie` header and no `X-CSRF-Token` header.

## Code Map

- Backend login/password routes: `server/src/modules/auth/routes.ts`
  - `/api/auth/local/login` sets `token` with `getTokenCookieOptions(process.env)`.
  - `/api/auth/local/change-password` runs through `authMiddleware`, then `changeLocalPassword()`.
- Backend CSRF middleware: `server/src/app.ts`
  - Always issues `csrf_token` using `getCsrfCookieOptions(process.env)`.
  - Unsafe requests with a `token` cookie must send `X-CSRF-Token` matching `csrf_token`.
- Cookie options: `server/src/modules/auth/http-config.ts`
  - Production defaults to `Domain=.trockcrm.com` whenever `AUTH_COOKIE_DOMAIN` is set.
  - The function does not consider the actual API request host.
- Frontend auth calls: `client/src/lib/auth.tsx`
  - `changePassword()` uses `api("/auth/local/change-password")`.
- Frontend API helper: `client/src/lib/api.ts`
  - Uses `credentials: "include"`.
  - Reads CSRF only from `document.cookie`.
  - On fallback production hosts, API calls go to `https://<prod-api-host>/api`; cookies set on that API host are not readable by frontend JavaScript.

## Root Cause

The server computes auth and CSRF cookie options from environment only. In production, `AUTH_COOKIE_DOMAIN=.trockcrm.com` is correct for `https://trockcrm.com`, but invalid when the API is reached as `https://<prod-api-host>`.

That invalid domain prevents the fallback-host browser flow from retaining the JWT cookie after login. Even if the token cookie is made valid as a host-only API cookie, the double-submit CSRF cookie is on the API host and cannot be read by JavaScript running on the separate frontend host. The frontend therefore needs a trusted response-body CSRF token for cross-origin fallback hosts while the server still validates the token against the cookie.

## Fix Direction

- Make auth/CSRF cookie options request-aware:
  - Use `.trockcrm.com` only when the request hostname belongs to that domain.
  - Omit `Domain` for Railway/API fallback hosts.
  - Use `SameSite=None; Secure` for allowed cross-origin production requests so `credentials: "include"` can carry API-host cookies.
- Return the current CSRF token in trusted auth responses (`local/login`, `dev/login`, `/auth/me`, and field auth responses as applicable).
- Let the frontend API helper cache a response-body CSRF token and use it as the header fallback when `document.cookie` cannot expose the API-host cookie.
- Keep `/api/auth/local/change-password` CSRF-protected; do not exempt it.
