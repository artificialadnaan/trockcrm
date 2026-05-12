# PR #274 CSRF Regression Diagnosis

Date: 2026-05-12
Branch: `fix/csrf-regression-pr274`
Base: `origin/main` at `9bd43d7b`

## Source Review

Reviewed:
- `client/src/lib/api.ts`
- `server/src/modules/auth/http-config.ts`
- `server/src/modules/auth/routes.ts`
- `server/src/app.ts`
- `server/tests/modules/auth/http-config.test.ts`
- `server/tests/app-password-change-cookie.test.ts`
- PR #274 merge commit `14f47e86`
- Live Railway API env origin settings via `railway variables --service API --environment production`

Codex review comments on PR #274:
- https://github.com/artificialadnaan/trockcrm/pull/274#discussion_r3228652671
- https://github.com/artificialadnaan/trockcrm/pull/274#discussion_r3228652677
- https://github.com/artificialadnaan/trockcrm/pull/274#discussion_r3228652683

## Production Host Situation

Canonical CRM entry point:
- `https://trockcrm.com`

Compatibility frontend entry points documented in `README.md`:
- `https://crm.trockconstruction.com`
- `https://frontend-production-bcab.up.railway.app`

Fallback API host used by the client for compatibility frontend hosts:
- `https://api-production-ad218.up.railway.app`

Live API env, non-secret findings:
- `AUTH_COOKIE_DOMAIN=.trockcrm.com`
- `NODE_ENV=production`
- `FRONTEND_URL=https://frontend-production-bcab.up.railway.app`
- `RAILWAY_PUBLIC_DOMAIN=trockcrm.com`
- `RAILWAY_STATIC_URL=trockcrm.com`
- `RAILWAY_SERVICE_FRONTEND_URL=crm.trockconstruction.com`
- `CORS_ALLOWED_ORIGINS` includes `https://crm.trockconstruction.com`, `https://trockcrm.com`, `https://frontend-production-bcab.up.railway.app`, and the field app production host. It does not include localhost in Railway env.

Important distinction: the live env does not list localhost, but `getAllowedCorsOrigins()` appends `http://localhost:5173`, `http://localhost:5174`, and `http://localhost:3000` in all environments, including production.

## Current Architecture From PR #274

PR #274 made auth cookies request-aware:
- Requests whose API host belongs to `.trockcrm.com` get shared-domain cookies on `.trockcrm.com`.
- Requests to fallback API host `api-production-ad218.up.railway.app` get host-only cookies so browsers accept them.

That cookie-domain fix is correct and should be preserved.

CSRF currently works as a double-submit token:
- `server/src/app.ts` creates or reuses `csrf_token`.
- `csrf_token` is readable (`HttpOnly=false`) and has `Max-Age=86400`.
- Unsafe authenticated requests must send `X-CSRF-Token` matching the cookie.

PR #274 added `res.locals.csrfToken` and `withCsrfToken()` so auth responses include `csrfToken` in JSON. This was added because fallback frontend hosts such as `https://frontend-production-bcab.up.railway.app` call `https://api-production-ad218.up.railway.app`; JavaScript on the frontend host cannot read the API host's `csrf_token` cookie.

## Findings

### Finding 1: stale client CSRF override

`client/src/lib/api.ts:getCsrfToken()` returns `csrfTokenOverride ?? readCookie("csrf_token")`.

Once any auth response caches a JSON `csrfToken`, every unsafe request prefers that cached value over the browser-readable cookie. If the cookie rotates after 24h, is cleared, or is replaced server-side, the client can send header token A while the browser sends cookie token B. The server rejects writes with `403 Invalid CSRF token` until another response refreshes the override.

Root cause: response-body token fallback became the primary source instead of a fallback for genuinely unreadable cookies.

### Finding 2: SameSite=None tied to broad CORS allowlist

`sameSiteForRequest()` returns `SameSite=None` for any cross-origin request whose origin passes `isAllowedCookieAuthOrigin()`.

`isAllowedCookieAuthOrigin()` uses `getAllowedCorsOrigins()`, and `getAllowedCorsOrigins()` adds localhost origins unconditionally. Therefore production code treats localhost as a credentialed cookie-auth origin even when Railway env does not list it.

Root cause: cross-site cookie eligibility reuses a broad CORS/dev allowlist instead of a strict production HTTPS auth-origin allowlist.

### Finding 3: CSRF token exposed from `/auth/me`

`server/src/modules/auth/routes.ts` wraps `/auth/me`, `/auth/local/login`, `/auth/dev/login`, and `/auth/local/change-password` with `withCsrfToken()`.

Because `/auth/me` is authenticated and readable by any credentialed CORS origin, the current production code can expose the API-host CSRF token to allowed localhost origins. Combined with Finding 2, a localhost page can learn the token and submit state-changing requests.

Root cause: JSON CSRF transport is not limited to the explicit fallback production origins that actually need it.

## Strategy Choice

Chosen strategy: **Strategy B - keep JSON CSRF token transport, but lock it down.**

Strategy A is clean for canonical `https://trockcrm.com`, because `/api` is same-origin there and the `.trockcrm.com` readable CSRF cookie is enough.

Strategy A is not sufficient for the go-live compatibility requirement from PR #274: `https://frontend-production-bcab.up.railway.app` calls `https://api-production-ad218.up.railway.app`. The API host cookie is intentionally host-only and cannot be read by JavaScript on the frontend host. Removing JSON CSRF from all responses would re-break the fallback-host password-change flow PR #274 fixed.

Implementation direction:
- Preserve request-aware cookie domain logic from PR #274.
- Make the client prefer a readable cookie before any response-body override.
- Restrict production credentialed CORS origins to HTTPS production origins only; keep localhost only outside production.
- Introduce `STRICT_CROSS_SITE_AUTH_ORIGINS` as the only source that can authorize `SameSite=None` and JSON CSRF token exposure for cross-site fallback flows. It defaults to empty; production must explicitly opt in the fallback frontend hosts that need cross-site auth.
- Only include `csrfToken` in JSON when the request origin is in that strict cross-site production set and is not same-origin with the API host.

## Assumptions

- `https://trockcrm.com` is canonical and should keep same-origin `/api` behavior.
- `https://frontend-production-bcab.up.railway.app` is still a real production fallback host because it is configured as `FRONTEND_URL` in Railway and is listed in the repo README.
- `https://crm.trockconstruction.com` remains a compatibility origin because it is listed in the README and in live CORS env, even though prior notes flagged DNS instability.
- Localhost must remain supported in development/test, but must not be a production credentialed CORS or cross-site auth origin.
