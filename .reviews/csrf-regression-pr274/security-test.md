# CSRF Regression Security Test

Date: 2026-05-12

## Attack Model

Attacker controls a page on `http://localhost:5173` while the victim has an active production CRM session.

The PR #274 regression made this dangerous because:
- production code unconditionally added localhost origins to the credentialed CORS allowlist;
- `sameSiteForRequest()` returned `SameSite=None` for any allowed CORS origin;
- `/api/auth/me` returned `csrfToken` in JSON to every allowed origin.

That combination allowed a localhost page to:
1. call `GET /api/auth/me` with credentials;
2. read `csrfToken` from JSON;
3. submit a state-changing request with the stolen token.

## Local Regression Test

Automated test:
- `server/tests/app-password-change-cookie.test.ts`
- case: `rejects a simulated localhost state-changing attack against production`

The test creates a valid fallback-host login from `https://frontend-production-bcab.up.railway.app`, captures the returned production fallback CSRF token and cookies, then attempts:

```http
POST /api/auth/local/change-password
Host: api-production-ad218.up.railway.app
Origin: http://localhost:5173
Cookie: token=<valid>; csrf_token=<valid>
X-CSRF-Token: <valid stolen token>
```

Expected result:

```json
{ "error": { "message": "Forbidden origin" } }
```

Observed in local verification:
- `403 Forbidden origin`
- `changeLocalPassword()` was not called.

## CORS and Token Exposure Tests

Automated tests:
- `server/tests/modules/auth/http-config.test.ts`
  - production `getAllowedCorsOrigins()` removes localhost and all `http://` origins.
  - localhost is still included for development/test workflows.
  - production localhost origin gets `SameSite=Lax`, not `SameSite=None`.
  - explicit fallback HTTPS production frontend gets `SameSite=None`.
  - `shouldExposeCsrfTokenInResponse()` returns true only for strict production cross-site auth origins.
- `server/tests/app-password-change-cookie.test.ts`
  - canonical same-origin auth responses do not include `csrfToken`.
  - localhost-origin `/api/auth/me` does not include `csrfToken`.

## Verification Commands

```bash
npx vitest run client/src/lib/api.test.ts server/tests/modules/auth/http-config.test.ts server/tests/app-password-change-cookie.test.ts
npx vitest run server/tests/app-csrf-public-auth.test.ts server/tests/app-csrf-field-cross-origin.test.ts server/tests/modules/auth/local-auth-routes.test.ts server/tests/modules/field-users/routes.test.ts client/src/hooks/use-leads.transition.test.ts client/src/hooks/use-files.upload.test.ts
npm run typecheck
```

## Live Post-Deploy Checks To Run

After merge/deploy, run against production:

```bash
curl -sSI -H 'Origin: http://localhost:5173' https://trockcrm.com/api/auth/me
curl -sSI -H 'Origin: http://localhost:5173' https://api-production-ad218.up.railway.app/api/auth/me
```

Expected:
- no `Access-Control-Allow-Origin: http://localhost:5173`;
- no production `Set-Cookie` with `SameSite=None` for localhost-origin requests;
- authenticated localhost-origin `/api/auth/me`, if directly requested outside browser CORS, must not include `csrfToken`;
- localhost-origin state-changing requests must fail with `403 Forbidden origin`.

Production fallback-host prerequisite:
- set `STRICT_CROSS_SITE_AUTH_ORIGINS=https://frontend-production-bcab.up.railway.app,https://crm.trockconstruction.com` for the API service before relying on fallback frontend password-change flows.
