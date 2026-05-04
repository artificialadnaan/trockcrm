# Summary

Implements Track B cutover blockers:

- B-11: upgraded `drizzle-orm` to `0.45.2` in `server`, `shared`, and `worker`.
- B-12: upgraded `vite` to `7.3.2` and `@vitejs/plugin-react` to `5.2.0` in `client`.
- B-09: hardened dev auth so `DEV_MODE=true` only works in local development/test hosts, and production startup fails when `DEV_MODE=true`.
- B-08: added exact-origin/referrer and double-submit CSRF protection for cookie-authenticated unsafe methods, while leaving raw Procore webhook routes outside the CSRF guard.

# Files changed

- `server/package.json`, `shared/package.json`, `worker/package.json`, `package-lock.json`
- `client/package.json`
- `server/src/modules/auth/http-config.ts`
- `server/src/index.ts`
- `server/src/app.ts`
- `client/src/lib/api.ts`
- `server/tests/modules/auth/http-config.test.ts`
- `client/e2e/track-b-smoke.spec.ts`
- `docs/track-b-smoke-log.md`
- `docs/track-b-pr-body.md`

# Validation

See `docs/track-b-smoke-log.md` for command output details.

Green:

- `npm run build --workspace=shared`
- `npm run typecheck --workspace=server`
- `npm run typecheck --workspace=worker`
- `npm run build --workspace=server`
- `npm run build --workspace=worker`
- `npm run typecheck --workspace=client`
- `npm run build --workspace=client`
- `npx vitest run tests/modules/auth/http-config.test.ts`
- Docker image builds for B-11/B-12/B-09/B-08
- Local Docker health/read smoke
- B-09 development, production-fail, and production-disabled Docker smoke
- B-08 CSRF/origin curl smoke
- Procore webhook valid and invalid signature smoke
- `PLAYWRIGHT_BASE_URL=http://localhost:30011 ./node_modules/.bin/playwright test client/e2e/track-b-smoke.spec.ts` — 6 passed
- `git diff --check`

Known existing Playwright issues:

- Existing suite is not fully green against a fresh local Docker stack:
  - `client/e2e/dashboard-contracts-signed-cards.spec.ts:190` calls `/api/pipeline/stages?workflowFamily=deal`; current API rejects that stale workflow family.
  - `client/e2e/lead-rep-persistence.spec.ts:37` has a strict locator collision for `Hidden Sales Rep`.

# Deployment

No production deployment performed. No production database, Railway environment, or webhook endpoint was touched.
