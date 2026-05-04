# Track B Smoke Log

Generated: 2026-05-04
Branch: fix/security-dependency-hotfixes

## B-11 — Drizzle

- Command: `npm install drizzle-orm@^0.45.2 --workspace=@trock-crm/server --workspace=@trock-crm/shared --workspace=@trock-crm/worker`
  - Exit code: 0
  - Result: `drizzle-orm` resolved to `0.45.2`.
- Command: `npm run build --workspace=shared`
  - Exit code: 0
- Command: `npm run typecheck --workspace=server`
  - Exit code: 0
- Command: `npm run typecheck --workspace=worker`
  - Exit code: 0
- Command: `npm run build --workspace=server`
  - Exit code: 0
- Command: `npm run build --workspace=worker`
  - Exit code: 0
- Command: `docker build -t trock-track-b-api:b11 .`
  - Exit code: 0
- Command: `docker run ... pgvector/pgvector:pg16`
  - Exit code: 0
  - Note: plain `postgres:16-alpine` failed because migration `0019_ai_copilot.sql` requires the `vector` extension.
- Command: `curl -i http://localhost:30011/api/health`
  - Exit code: 0
  - Response status: 200
  - Body snippet: `{"status":"ok",...}`
- Command: `curl -i -b /tmp/trock-track-b-cookie.txt http://localhost:30011/api/deals`
  - Exit code: 0
  - Response status: 200
  - Body snippet: `{"deals":[],"pagination":{"page":1,"limit":50,"total":0,"totalPages":0}}`
- Command: `docker logs trock-track-b-api`
  - Exit code: 0
  - Result: no Drizzle runtime errors after health and representative read.

Raw SQL / tenant interpolation audit:
- Reviewed `server/src/modules/tasks/rules/persistence.ts` schema interpolation paths called out by the plan. No code changed in B-11; hardening remains separately sequenced.
- Reviewed `server/src/modules/reports/report-builder-service.ts` `sql.identifier` usage. It remains limited to report-builder aliases.

## B-12 — Vite

- Command: `npm install vite@^7.3.0 @vitejs/plugin-react@^5.1.0 --workspace=@trock-crm/client`
  - Exit code: 0
  - Result: `vite` resolved to `7.3.2`; `@vitejs/plugin-react` resolved to `5.2.0`.
- Command: `npm run typecheck --workspace=client`
  - Exit code: 0
- Command: `npm run build --workspace=client`
  - Exit code: 0
  - Output snippet: `vite v7.3.2 building client environment for production...`
- Command: `docker build -t trock-track-b-api:b12 .`
  - Exit code: 0
- Command: `curl -i http://localhost:30011/`
  - Exit code: 0
  - Response status: 200
  - Body snippet: `<title>T Rock CRM</title>`
- Command: `curl -i http://localhost:30011/assets/lead-list-page-wyoEHGX-.js`
  - Exit code: 0
  - Response status: 200
  - Body snippet: JavaScript lazy chunk returned.

## B-09 — DEV_MODE Guard

- Command: `npm run typecheck --workspace=server`
  - Exit code: 0
- Command: `npm run build --workspace=server`
  - Exit code: 0
- Command: `npx vitest run tests/modules/auth/http-config.test.ts`
  - Exit code: 0
  - Result: 8 tests passed at B-09 checkpoint.
- Command: `docker build -t trock-track-b-api:b09 .`
  - Exit code: 0
- Command: development stack, `curl -i http://localhost:30011/api/auth/dev/users`
  - Exit code: 0
  - Response status: 200
  - Body snippet: `admin@trock.dev`, `director@trock.dev`, `rep@trock.dev`
- Command: production stack with `NODE_ENV=production DEV_MODE=true`, `node server/dist/index.js`
  - Exit code: 1
  - stderr snippet: `Unsafe auth configuration: DEV_MODE=true is not allowed when NODE_ENV=production`
- Command: production stack with `NODE_ENV=production DEV_MODE=false`, `curl -i http://localhost:30013/api/health`
  - Exit code: 0
  - Response status: 200
- Command: production stack with `NODE_ENV=production DEV_MODE=false`, `curl -i http://localhost:30013/api/auth/dev/users`
  - Exit code: 0
  - Response status: 404
  - Body snippet: `{"error":{"message":"Dev mode not available"}}`

## B-08 — CSRF / Origin Guard

- Command: `npm run typecheck --workspace=server`
  - Exit code: 0
- Command: `npm run typecheck --workspace=client`
  - Exit code: 0
- Command: `npx vitest run tests/modules/auth/http-config.test.ts`
  - Exit code: 0
  - Result: 11 tests passed.
- Command: `npm run build --workspace=server`
  - Exit code: 0
- Command: `npm run build --workspace=client`
  - Exit code: 0
- Command: `docker build -t trock-track-b-api:b08 .`
  - Exit code: 0
- Command: authenticated GET without CSRF header, `curl -i -b /tmp/trock-track-b-csrf-cookie.txt http://localhost:30011/api/auth/me`
  - Exit code: 0
  - Response status: 200
- Command: allowed-origin POST with valid CSRF, `curl -i -b ... -H 'Origin: http://localhost:30011' -H 'X-CSRF-Token: ...' -X POST /api/auth/logout`
  - Exit code: 0
  - Response status: 200
  - Body snippet: `{"success":true}`
- Command: disallowed-origin POST with valid CSRF, `curl -i -b ... -H 'Origin: http://evil.example.com' -H 'X-CSRF-Token: ...' -X POST /api/auth/logout`
  - Exit code: 0
  - Response status: 403
  - Body snippet: `{"error":{"message":"Forbidden origin"}}`
- Command: allowed-origin POST without CSRF, `curl -i -b ... -H 'Origin: http://localhost:30011' -X POST /api/auth/logout`
  - Exit code: 0
  - Response status: 403
  - Body snippet: `{"error":{"message":"Invalid CSRF token"}}`
- Command: Procore webhook valid signature, `curl -i -H 'X-Procore-Signature: sha256=d185...' -d '{"event_type":"track_b_smoke","resource_id":90801}' /api/webhooks/procore`
  - Exit code: 0
  - Response status: 200
  - Body snippet: `{"status":"accepted","logId":1}`
- Command: Procore webhook invalid signature, `curl -i -H 'X-Procore-Signature: sha256=000...' -d '{"event_type":"track_b_smoke_bad","resource_id":90802}' /api/webhooks/procore`
  - Exit code: 0
  - Response status: 401
  - Body snippet: `{"error":"Invalid signature"}`

## Playwright

- Command: `PLAYWRIGHT_BASE_URL=http://localhost:30011 ./node_modules/.bin/playwright test client/e2e/track-b-smoke.spec.ts`
  - Exit code: 0
  - Result: 6 passed.
- Command: `PLAYWRIGHT_BASE_URL=http://localhost:30011 ./node_modules/.bin/playwright test ...existing specs... --workers=1`
  - Exit code: 1
  - Result: 10 passed, 2 failed, 1 skipped, 4 did not run.
  - Existing failure 1: `client/e2e/dashboard-contracts-signed-cards.spec.ts:190` still calls `/api/pipeline/stages?workflowFamily=deal`; current API rejects that stale workflow family.
  - Existing failure 2: `client/e2e/lead-rep-persistence.spec.ts:37` strict locator resolves two `Hidden Sales Rep` elements.
  - Existing skip: `client/e2e/pipeline-workflow-alignment.spec.ts` skipped after the dashboard setup failure.

## Final Hygiene

- Command: `git diff --check`
  - Exit code: 0
