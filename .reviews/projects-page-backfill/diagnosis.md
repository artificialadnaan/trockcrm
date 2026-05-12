# Diagnosis — Projects Page Backfill Fix

## Pre-flight collision check (CLEAR)

- Open PR #212 (`fix/project-number-uppercase`) touches `server/src/services/projectNumber.ts` and `server/src/modules/deals/service.ts` — NOT projects mirror code. Not a collision.
- Stale worktree `trockcrm-projects-tab` is post-merge of PR #243 (merged 33 min before track start). Branch is fully merged into `main`; the worktree only has an uncommitted `.reviews/projects-tab/FINAL.md` edit. Not active work.
- Stale branch `feat/project-type-backfill` is fully merged (`origin/main..origin/feat/project-type-backfill` is empty).
- Concurrent parallel track `trockcrm-reports-500-fix` (branch `fix/reports-500-regression`, commit `bdd11de`) is on isolated reports files. Not in `projects/*` paths. Will rebase before merge.

Proceeding.

## Test account credentials (verified live)

| Account | Email | Password | Result |
|---|---|---|---|
| Admin | `test-admin@trock.test` | `<redacted — test creds in ops vault>` | HTTP 200 (NB: the shared `<redacted — test creds in ops vault>` returns 401 for admin; admin uses a different value) |
| Director | `test-director@trock.test` | `<redacted — test creds in ops vault>` | HTTP 200 |
| Sales | `test-sales@trock.test` | `<redacted — test creds in ops vault>` | HTTP 200 |

Login endpoint: `POST /api/auth/local/login`. Sets `token` (JWT) and `csrf_token` cookies on `.trockcrm.com`.

POST endpoints require `Origin: https://trockcrm.com` and `x-csrf-token` header — bare API host hits return `Forbidden origin`.

## Production reproduction of backfill failure

```
POST https://<prod-api-host>/api/projects/backfill
Origin: https://trockcrm.com
Cookie: token=...; csrf_token=...
x-csrf-token: ...

→ HTTP 500 {"error":{"message":"Internal server error"}}  (~0.23s, far too fast for Procore round-trip)
```

Railway API logs around the failing request:

```
[ERROR] current transaction is aborted, commands ignored until end of transaction block error: current transaction is aborted, commands ignored until end of transaction block
    at pg client.js:<line> (node_modules)
    at process.processTicksAndRejections (node:internal/process/task_queues:<line>)
    at async tenantMiddleware (tenant.js:<line>)
```

The error fires from the FIRST query in tenantMiddleware — before BEGIN — which is impossible unless the pool client handed to us is already in an aborted-transaction state.

## Two distinct bugs identified

### Bug A — Upstream pool poisoning from broken reports SQL (out of my track scope)

Every tenant-scoped endpoint currently returns 500 in production, not only `/api/projects/backfill`:

| Endpoint | Result |
|---|---|
| `GET /api/auth/me` | 200 (no tenant middleware) |
| `GET /api/health` | 200 |
| `GET /api/leads` | 500 |
| `GET /api/companies` | 500 |
| `GET /api/users/me` | 500 |
| `GET /api/deals` | 500 |
| `GET /api/projects` | 500 |
| `POST /api/projects/backfill` | 500 |

API log shows a recent reports query with broken SQL — `COALESCE(u.display_name, 'Unassigned') AS owner_name,` injected into the middle of a `CASE` block (sales-tier 1 reports). When that query fails inside a transaction, the pool client is released back without `ROLLBACK`, so subsequent requests pulling that client from the pool fail on their very first query with `current transaction is aborted`.

This is fixed in the concurrent track `trockcrm-reports-500-fix` (commit `bdd11de fix(reports): resolve 500s in pipeline velocity, closed won revenue, lead conversion, director scorecard`). Their merge will resolve the root pool-poisoning. **Production smoke for the backfill must wait for that PR to land.**

### Bug B — Backfill has no per-row isolation, so one bad row aborts the entire run (in scope, this is what I fix)

`server/src/modules/projects/backfill-service.ts` iterates Procore project rows inside the request's tenant transaction. The for-loop has a try/catch (counts errored rows, continues), BUT once ANY single statement throws inside the transaction (constraint violation, type cast, deadlock), Postgres puts the transaction into aborted state. Every subsequent row's queries — `findExistingProjectSyncRow`, `findSourceDealIdForProcoreProject`, `upsertProjectMirror` — fails with `current transaction is aborted, commands ignored until end of transaction block`.

Effect:
- One bad project row poisons every later row.
- The catch block increments `errored` for hundreds of rows that would have backfilled fine.
- The final `COMMIT` (via `req.commitTransaction()`) fails, the client returns to the pool poisoned, and the next tenant request sees the same 500 we just diagnosed in Bug A (this is the same failure mode that the reports SQL bug is exhibiting today).

This is the actual backfill blocker. Even after the reports fix lands, the backfill will still be brittle the moment a single Procore row trips a constraint or cast.

## Fix design (scoped to this track)

1. Wrap each row's processing in a SAVEPOINT. On error inside one row, `ROLLBACK TO SAVEPOINT`, count it as errored, and continue with a clean transaction state. On success, `RELEASE SAVEPOINT`.
2. Outside-the-loop failures (Procore page fetch, response shape) still abort the whole run.
3. Add a regression test that injects a row triggering a Postgres error mid-batch and asserts subsequent rows still backfill.

This is the minimum, ship-safe correctness fix. It does not change the request transaction model, does not introduce a background worker, and is bounded to backfill-service.ts plus tests.

## UX comparison: Projects page vs Leads/Deals/Pipeline

`client/src/pages/projects/projects-page.tsx` already has both required elements:

- Kanban on top (lines 266-293): horizontally-scrolling column-per-phase board grouped by Procore phase, with project cards.
- Searchable list view below (lines 295-394): search input, sortable columns, pagination, filters by phase/owner/date range.

Structural match to Leads (`lead-list-page.tsx`) and Deals (`deal-list-page.tsx`): both follow the same kanban-on-top + list-below structure. Visual idiom differs — Leads/Deals use a stronger workflow-control eyebrow header, 3 MetricCards summary row, and the brand `font-black uppercase` h1. The Projects page uses a lighter header with no metric cards and integrated filter bar.

Decision: structure already satisfies the spec ("Kanban + searchable list view"). The `font-black uppercase` h1, MetricCards row, and ScopeToggle wiring would be a polish pass — non-essential to ship. Given the EOD-tomorrow deadline and the explicit "ship-safe, minimum-risk" standing order, I will NOT change the projects-page visual styling in this track. Reserved as a follow-up if production smoke surfaces a real usability gap.

## Scope summary

In scope (this PR):
- Per-row savepoint isolation in `runProjectsBackfill`.
- Regression test exercising a bad-row-followed-by-good-row scenario.
- Production smoke run after reports-500-regression deploys.

Out of scope (this PR):
- Reports SQL bug (different track, in flight).
- Tenant middleware defensive-rollback hardening (different concern; would mask bugs in other tracks).
- Projects-page visual polish to fully match Leads/Deals headers.

## Assumptions

1. The `tenantClient` exposed by `req.tenantClient!` supports `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT` SQL — true for any `pg.PoolClient` inside a `BEGIN`-wrapped transaction (which tenant middleware establishes).
2. Admin role bypass for the backfill endpoint is unchanged.
3. Production smoke for the backfill itself depends on the reports-500-regression PR landing first. If that track stalls past tomorrow morning, I will document this as a NEEDS INTERVENTION (we cannot prove the backfill works in prod while the pool is permanently poisoned).
