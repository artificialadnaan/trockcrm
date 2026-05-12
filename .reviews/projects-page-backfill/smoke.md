# Smoke — Projects Backfill PRs #246 / #247 / #248 / #249

## Iteration 1 (after PR #246 deploy, API `8d6bb295`) — FAIL

- Admin login: 200; Director login: 200; Sales login: 200.
- `POST /api/projects/backfill`: HTTP 500.
- Railway log: `SAVEPOINT can only be used in transaction blocks` at `runProjectsBackfill` (compiled `backfill-service.js:<line>`) — request tenant transaction killed by Postgres `idle_in_transaction_session_timeout` during Procore HTTPS fetch.

## Iteration 2 (after PR #247 deploy, API `f642ad84`) — PARTIAL

- All tenant GET endpoints return 200 (pool poisoning cleared by redeploy).
- `POST /api/projects/backfill`: curl --max-time 300 → HTTP 000 (no response within 5 min).
- DB direct check: `office_dallas.projects` count = 0, `office_dallas.project_sync_state` count = 0.
- The SAVEPOINT crash was fixed but the function appeared to hang or silently skip every row. Insufficient visibility to determine which without runtime logs.

## Iteration 3 (after PR #248 deploy, API `602c0747`) — DIAGNOSIS

Observability logs revealed:
- Backfill is reaching the route handler and acquiring its connection.
- Procore `/projects` query is returning ~723 rows per page despite `per_page=200`.
- The loop runs past page=28 with `skipped=20,244`, `backfilled=0`, `errored=0`.
- Diagnosis: two latent bugs in PR #243's design — pagination break condition `rows.length < perPage` never fires when Procore ignores `per_page`, and the office-prefix gate (`DFW-`, `ATL-`) skips every actual Procore project_number.

## Iteration 4 (after PR #249 deploy, API `9c420020`) — PASS

### Run 1 — initial seed

```
POST /api/projects/backfill?mirror_all_projects=true
Authorization: cookies for test-admin@trock.test (password `<redacted — test creds in ops vault>`)
Origin: https://trockcrm.com
```

- Triggered 2026-05-11T23:23:55Z; response not captured by curl (--max-time 8s) but server completed the run in under 60s based on DB state.
- Pre-run row count: 0
- Post-run row count (via `GET /api/projects?perPage=1`): **723**
- `office_dallas.projects` count via psql: **723**
- `office_dallas.project_sync_state` count: **723** (exact match)
- `office_dallas.project_phase_history` count: **702** (one per project that has a phase; 21 projects with NULL phase did not generate initial history, which matches the upsert contract)
- 723 distinct `procore_project_id` values — no duplicates from cycle re-processing.

### Run 2 — idempotency

```
POST /api/projects/backfill?mirror_all_projects=true (same admin)
```

- Triggered 2026-05-11T23:25:29Z; completed within 45s.
- Row count unchanged: 723.
- `office_dallas.projects.updated_at` MAX advanced from 23:23:57 to 23:25:38 (upserts touched `last_synced_at` / `updated_at` via `ON CONFLICT DO UPDATE`) — expected.
- No new INSERTs (distinct ID count is still 723). Idempotent ✓.

### Run 3 — director role

```
GET /api/projects/by-phase
Cookies for test-director@trock.test (password `<redacted — test creds in ops vault>`)
```

- HTTP 200.
- Phase columns returned: **21**.
- Sample distribution (top 8 by count):
  - Bidding: 24
  - Buy Out: 48
  - Closed: 207
  - Close Out: 2
  - Close Out - Final Invoice: 25
  - Contract Executed: 3
  - Estimating: 51
  - Estimating - Canceled: 39
- Phase distribution matches DB ground truth.

### Run 4 — sales role

```
GET /api/projects?perPage=1
Cookies for test-sales@trock.test (password `<redacted — test creds in ops vault>`)
```

- HTTP 200, projects visible. (Project read access is intentionally tenant-wide for read-only mirror; per the original spec, projects scope is not per-rep.)

### Cross-check Procore sources

The 723 mirrored rows match what `procoreClient.get('/rest/v1.0/companies/598134325683880/projects')` returns. The active Procore portfolio for T Rock (the 598134325683880 company) is now fully reflected in `office_dallas.projects`.

## Production environment confirmed during smoke

- `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`, `PROCORE_COMPANY_ID=598134325683880` all set on the API service.
- `public.procore_oauth_tokens.status = 'active'`, `token_expires_at = 2026-05-11 23:41:39+00` (refreshed automatically during smoke).
- Concurrent reports SQL bug (`fix/reports-500-regression`, PR #245) was still open during smoke but did not affect the backfill — the dedicated pool client used by `runProjectsBackfill` is isolated from request-tenant pool poisoning.

## Test account credentials

| Account | Email | Password |
|---|---|---|
| Admin | `test-admin@trock.test` | `<redacted — test creds in ops vault>` |
| Director | `test-director@trock.test` | `<redacted — test creds in ops vault>` |
| Sales | `test-sales@trock.test` | `<redacted — test creds in ops vault>` |

## Result

PASS. The Projects page backfill is functional end-to-end as of API deploy `9c420020`. Future scheduled reruns can use the default (`mirror_all_projects=false`) once the office-prefix routing is reconciled with how T Rock's Procore project_number scheme will look post go-live; for now, admin operators should pass `?mirror_all_projects=true` explicitly when seeding a tenant.
