# Autonomous Production Smoke - 2026-05-08

## Status

Smoke executed against `https://trockcrm.com` after the user provided local-password test credentials.

## Worktree Preflight

- Worktree: `/Users/adnaaniqbal/projects/trockcrm-autonomous-smoke`
- Branch: `hotfix/autonomous-smoke`
- Base commit: `d63d711 fix: let invites proceed directly to cleanup`
- Initial status: clean
- Worktree exclusivity: confirmed `hotfix/autonomous-smoke` is only checked out at `/Users/adnaaniqbal/projects/trockcrm-autonomous-smoke`

## Credential Findings

- Dev auth remains unusable for this smoke path: `/api/auth/dev/users` returned `{"users":[]}` and `admin@trock.dev` returned `404 User not found`.
- Local auth succeeded for `test-admin@trock.test`, `test-director@trock.test`, and `test-sales@trock.test`.
  See `docs/smoke-credentials.md` for the current test-only credential matrix; admin intentionally uses a different password than rep/director.

## Smoke Coverage

Automated Playwright smoke covered:

- `/dashboard`
- `/deals`
- `/deals/board`
- `/deals/:id`
- `/leads`
- `/leads/board`
- `/leads/:id`
- `/companies`
- `/companies/:id`
- `/contacts`
- `/properties`
- `/properties/:id`
- `/tasks`
- `/reports`
- `/email`
- `/files`
- `/pipeline/my-cleanup`
- `/onboarding-required`

Raw route/API capture: `docs/autonomous-smoke-results-2026-05-08.json`.

## Bugs Found

- P0/P1: `/api/contacts` returns 500. This breaks `/contacts` and also causes contact-backed errors on `/files`.
- P2/data-state: `test-sales@trock.test` has zero rows in `office_dallas.tasks`; `/api/tasks` and `/api/tasks/counts` correctly return empty task buckets for that account.
- P2/data-state: `test-sales@trock.test` does have cleanup work. `/pipeline/my-cleanup` rendered 8 open cleanup items, including the expected `SMOKE TEST DELETE` records.
- P3/ignored: Commissions is still the old page, as expected per prompt.

## Bugs Fixed

- Extracted contact association SQL into named helpers:
  - `buildContactIsPrimarySql()`
  - `buildContactLinkedDealsCountSql()`
- Reused those helpers from both `getContacts` and `getContactById`.
- Added regression coverage that renders the helpers through Drizzle's Postgres dialect and asserts the primary-contact expression contains `EXISTS` with `SELECT 1`, preventing the malformed `EXISTS ( FROM ...)` shape.
- Cycle 2: first deploy still returned 500. Railway logs showed Drizzle rendered correlated subquery references as unqualified `"id"` inside `contact_deal_associations` subqueries. The fix now uses explicit `"contacts"."id"` references for association counts and last-touch subqueries.
- Fixed the local contacts sort test harness aliases so the focused contacts suite runs reliably.

## Verification

- Production smoke before fix:
  - `PLAYWRIGHT_BASE_URL=https://trockcrm.com PLAYWRIGHT_TEST_PASSWORD=... npx playwright test client/e2e/autonomous-production-smoke.spec.ts --reporter=list`
  - Result: 2 passed; route report showed `/contacts` and `/files` broken by `/api/contacts` 500.
- Focused contacts tests:
  - `npx vitest run server/tests/modules/contacts/contact-association-sql.test.ts server/tests/modules/contacts/contacts-sort-last-touch-at.test.ts server/tests/modules/contacts/contacts-sort-last-touch-nulls-last.test.ts server/tests/modules/contacts/service.test.ts`
  - Result after cycle 2: 4 files passed, 35 tests passed.
- Typecheck:
  - `npm run typecheck`
  - Result: exit 0.
- First deployment:
  - PR #190 merged and Railway deployment `663ef89c-3808-444f-91c4-bd970f9d496d` reached `SUCCESS`.
  - Post-deploy `/api/contacts` still returned 500, triggering cycle 2.

## Deferred / Follow-Up

- Re-run production smoke after deploy and confirm `/api/contacts` returns 200.
- If the user expects CRM task rows for `test-sales@trock.test`, seed or restore non-destructive test tasks for that account. Current production data has cleanup assignments, not task rows.
- Keep Track G/commissions redesign out of this hotfix.

## Production State Assessment

Amber pre-deploy. The main redesigned surfaces render, but `/api/contacts` 500 is live and affects contacts plus files. The task report is not currently a task-service failure based on read-only production checks.
