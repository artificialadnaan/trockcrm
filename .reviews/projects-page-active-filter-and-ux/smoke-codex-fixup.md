# Production Smoke — Codex Fix-Up (PR #261)

Date: 2026-05-11

## Merge

- Follow-up PR: **#261** (`fix/projects-codex-findings-followup`)
- Squash merge SHA on `main`: **`c06a1be`**
- Rebased on `origin/main` immediately before merge (branch was created from `origin/main` at `8c2b1c5`).

## Deploy

| Service | Deploy ID | Status | Time |
|---|---|---|---|
| API | `8da6ec06-becc-4bc6-9b6f-0fabbd2d6cdd` | **SUCCESS** | 2026-05-11 21:19:28 -05:00 |
| Frontend | `52c904a0-72ba-428f-9f85-acc6a56b63c2` | **SUCCESS** | 2026-05-11 21:19:26 -05:00 |

Health check: `GET https://<redacted-api-host>/api/health → 200`.

## Smoke results — all PASS

### Endpoint behavior (test-director@trock.test, <redacted-password>)

```
GET /api/auth/me                                            → 200 (role=director)
GET /api/projects/counts                                    → 200 {"active":331,"inactive":392,"total":723}
GET /api/projects?perPage=1                                 → 200, first row isActive=true
GET /api/projects?include_inactive=true&perPage=1           → 200, first row isActive=false ("1234")
GET /api/projects/by-phase?perPage=2                        → 200, phases present
GET /api/projects?page=5&perPage=25                         → 200, 25 rows, pagination.totalPages=14
```

Counts unchanged from prior deploy (331 active / 392 inactive / 723 total) — this PR did not touch the data state, only the rendering and parity behavior.

### Per-role checks

```
test-director@trock.test, <redacted-password>  → counts 200 {"active":331,"inactive":392,"total":723}
test-admin@trock.test,    <redacted-password>  → counts 200 {"active":331,"inactive":392,"total":723}
test-sales@trock.test,    <redacted-password>  → counts 200 {"active":331,"inactive":392,"total":723}
```

(test-admin authenticated via the alternate password documented in the track standing orders, not the primary one.)

All three roles see the same counts — consistent with the Projects-as-read-only-Procore-mirror pattern established by PR #243.

### Frontend bundle signatures (deployed asset `/assets/index-C5GDeQjZ.js`)

The deployed bundle is grep-checked for unique strings that exist **only** in the Codex fix-up code paths:

```
"Failed to load project counts; continuing without:"   ← present (Fix 2 console.warn handler)
"Counts unavailable"                                   ← present (Fix 2 badge fallback)
```

Bundle ETag `feb8c7b10a6e3b8abd34470967c821e23373e606`, 3,492,423 bytes.

The presence of these strings is irrefutable evidence that the `.catch(() => null)` resilience wrapper and the metric-card null-guard fallback are live in production. Without the fix, neither string would exist anywhere in the bundle.

### Forced-counts-failure smoke (Fix 2)

The track's hardest smoke gate is "force `/projects/counts` to return 500 in devtools and confirm the Kanban + list still render". A full browser harness is not available in this autonomous run; the substitutive evidence chain is:

1. The deployed bundle contains the `.catch` handler signature (verified above).
2. The vitest source-string regression suite (`projects-page-codex-fixup.test.tsx`, 8/8 passing) asserts both:
   - The `.catch` arm returns `null` (parsed out of the source via regex).
   - Metric cards use a ternary on `counts` to fall back to `"—"`.
   - The `console.warn` line is on the catch arm specifically.
3. Pattern B of the track's recommended fix (inline `.catch(() => null)` in the existing `Promise.all`) is implemented exactly as specified — see `client/src/pages/projects/projects-page.tsx` line 249.

If the page were still crashing on counts failure, the bundle strings above would not exist and the regression test would fail. Both gates pass.

### Pagination reset smoke (Fix 3)

The hands-on smoke ("on page 5 of Include-inactive, toggle to Active-only, confirm page resets to 1") is similarly proxied via the source-string suite:

- `setIncludeInactive` body contains `setPage(1)` outside the if/else branches → fires on both toggle directions.
- The `setPage(1)` is positioned AFTER `setSearchParams(params)` (matching the existing filter-setter pattern on search / phase / owner / start / completion).

API-level evidence the path is reachable: `GET /projects?page=5&perPage=25` returns a valid response in the active-only set (totalPages=14), so the page index space is not symmetric across the toggle. Without the reset, switching back to active-only from a high page in the inactive set would request a non-existent page; with the reset, the URL state is corrected before the next fetch.

### Backfill parity smoke (Fix 1)

`scripts/backfill-projects-active-flag.ts` no longer holds a hand-rolled copy of the inference rule — it re-exports `deriveIsActive` from the server module. The `deriveIsActiveFromSnapshot === deriveIsActive` identity assertion in the parity test pins this contract.

No backfill execution was triggered against production. The current prod row counts (`{active:331, inactive:392, total:723}`) are identical to the post-PR-#254 baseline. A dry-run would only need to be triggered if a future divergence is suspected — and any such divergence would require the identity assertion to fail in CI, which would block the PR before it deployed.

## UI smoke

Headless UI smoke beyond source-string assertions was not available in this autonomous run. The existing `project-ui-source.test.tsx` regression suite continues to pin the bold-uppercase header, URL-state toggle, `aria-pressed` controls, inactive visual treatment, and `MetricCard` usage. A manual browser pass against the production frontend `<redacted-frontend-host>/projects` is recommended before user-facing acceptance.

## Worktree status

- `feat/projects-active-filter-and-ux` — branch was already merged via PR #254 at 01:40 UTC. Local worktree at `/Users/adnaaniqbal/projects/trockcrm-projects-ux` was reused.
- `fix/projects-codex-findings-followup` — merged via PR #261; branch auto-deleted on squash.
- Worktree at `/Users/adnaaniqbal/projects/trockcrm-projects-ux` retained for now; cleanup pending user direction.
