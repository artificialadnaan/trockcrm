# Follow-up — Backfill Architectural Fix

## Context

PR #246 merged (savepoint isolation) and deployed. First production run of `POST /api/projects/backfill` reproduced a different, deeper failure:

```
[ERROR] SAVEPOINT can only be used in transaction blocks
    at /app/node_modules/pg/lib/client.js:631:17
    at async runProjectsBackfill (file:///app/server/dist/modules/projects/backfill-service.js:84:13)
```

## Root cause

The backfill was running on the request's tenant transaction (set up by `tenantMiddleware` with `BEGIN` plus `SET LOCAL statement_timeout = '30s'`). Inside the loop, the very first action per page is a Procore HTTPS fetch (`procoreClient.get(...)` listing 200 projects). With a real Procore round-trip taking multiple seconds, the connection is held **idle inside a transaction** while the HTTPS call is in flight. Railway Postgres terminates that transaction via `idle_in_transaction_session_timeout`. When control returns and the loop issues `SAVEPOINT projects_backfill_p1_i0`, there is no active transaction, so the statement fails.

Symptoms before this fix:
- HTTP 500 from the route handler.
- First backfill of a clean office sees zero rows mirrored.
- The savepoint logic added in #246 is correct in isolation but architecturally cannot run because the transaction it relies on no longer exists.

## Fix

Detach the backfill from the request transaction. `runProjectsBackfill` now:

1. Accepts `pool: Pool` and acquires its own `PoolClient` from `db.pool`.
2. Issues a session-level `SET search_path TO <schema>, public` (no transaction needed).
3. Iterates Procore pages with **no transaction open during the HTTP fetch**.
4. For each row, runs a short-lived per-row transaction: `BEGIN ... COMMIT` (or `ROLLBACK` on error). One row's failure cannot affect another, and savepoints are no longer needed.
5. Releases the client in a `finally` so a thrown error from Procore still returns the client cleanly to the pool.

`routes.ts` was updated to:
- Resolve `schemaName` and `officeSlug` from the request before any HTTP work.
- Call `req.commitTransaction!()` immediately to release the request's tenant transaction.
- Then invoke `runProjectsBackfill(pool, schemaName, officeSlug)`.

This makes the backfill independent of the request's transaction lifecycle.

## Tests

`server/src/modules/projects/backfill-service.test.ts` rewritten to mock a pg `Pool` (`pool.connect()` returning a mock client). Four tests, all passing:

1. Idempotency when Procore `updated_at` matches local mirror.
2. Bad-row isolation: a failing row's transaction rolls back, the next row's transaction begins fresh, asserted via `BEGIN/COMMIT/ROLLBACK` counts.
3. Office-prefix gating for unmatched projects.
4. Pool client is released when Procore throws mid-pagination.

The aborted-transaction simulator in test #2 now mirrors real Postgres semantics: any statement issued inside an aborted txn throws 25P02 until `ROLLBACK` clears it.

## Verification gates

- `npm run typecheck` — exit 0.
- `npx vitest run server/src/modules/projects/ server/src/modules/synchub/procore-project-relay-service.test.ts client/src/pages/projects/` — 7 files, 22 tests passed.

## Why this didn't show up in the unit tests for #246

The original unit tests used a single mock client and exercised the savepoint code with an already-active mock transaction. They never modelled the real production sequence where a long HTTPS call sits inside a Postgres transaction long enough to trip `idle_in_transaction_session_timeout`. New test #4 covers the Procore-throws path and the new release-on-error guarantee; the design itself eliminates the idle-in-transaction class of failure.
