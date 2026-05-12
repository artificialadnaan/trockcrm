# Final Report — projects-page-active-filter-and-ux

## Status

**PASS**

The Projects page now defaults to active-only (~330 of ~720), exposes the full ~720 behind an opt-in pill toggle, treats inactive rows with distinct visual styling, and updates the page header / metric cards to match the Leads/Deals visual language. The Procore-active flag is now durable across re-syncs.

## PR(s)

| PR | Branch | SHA | Note |
|---|---|---|---|
| **#254** | `feat/projects-active-filter-and-ux` | merge sha `22de855` | The track. Squash-merged. |
| **#256** | `hotfix/prepare-husky-prod-deploy` | merge sha `d942271` | Unblocked Railway deploys for #252, #253, **#254**. Squash-merged. |

## Deploy

- API service production deploy `5ccb15f4-620b-4dad-9fd5-3846c2de3a88` — **SUCCESS** @ 20:55.
- Worker deploy `d2f68a55-...` — SUCCESS.
- Frontend deploy `6d2f5729-d2fb-43e0-ad0f-9bded34aba11` — SUCCESS @ 20:55.
- `curl https://api-production-ad218.up.railway.app/api/health → 200`.

## Per-change root cause + fix

| Change | Root cause | Fix |
|---|---|---|
| Active-only filter on list/by-phase/exports | `buildWhere` had no `is_active` predicate; the UI showed everything. | Added `if (!filters.includeInactive) conditions.push("p.is_active = true")` in `buildWhere`, threaded `includeInactive` through `ProjectListFilters`, parsed `include_inactive` query param on both routes. |
| Soft-delete reversibility | The mirror skipped re-syncs of already-mirrored rows when they didn't match the office prefix and had no source deal, so `is_active` could go stale forever. | `processRow` now only applies the office-prefix gate to NEW inserts; existing rows always flow through `upsertProjectMirror`. |
| Counts | No counts endpoint existed. | Added `GET /api/projects/counts` → `{active, inactive, total}` via a single `COUNT(*) FILTER` query. |
| SyncHub webhook overwriting `is_active=true` (round-1 P0) | The relay snapshot is sparse (`{id, company_id, project_number, name}` only). The legacy mirror inference `snapshot.status_name !== "Inactive"` evaluated to `true` for `undefined`, force-flipping every webhook event back to active. | Extracted `deriveIsActive(snapshot) → null \| { isActive, reason }` as the single source of truth. `null` means "no signal". The upsert now uses `COALESCE($16::boolean, true)` on INSERT and `COALESCE($16::boolean, schema.projects.is_active)` on ON CONFLICT, preserving the existing CRM value when the snapshot is sparse. |
| Projects-page UX gap | Old page used a lighter sub-language; metric cards, eyebrow header, and the include-inactive toggle were missing. | Rebuilt the page header in `font-black uppercase` matching Leads/Deals, added `MetricCard` row (Active / Inactive / Contract value on page), pill toggle with URL state (`?include_inactive=true`), Active/Inactive badges on every card and table row, line-through + slate tint for inactive rows. |

## Test additions

- **`server/src/modules/projects/backfill-service.test.ts`** — six transition cases (new+active, existing+active, inactive→active, active→inactive, durability for already-mirrored rows without office prefix, new-inactive-no-prefix skip, already-inactive idempotent).
- **`server/src/modules/projects/service.test.ts`** — `deriveIsActive` (null / sparse / boolean / status_name), sparse-snapshot upsert (verifies `$16` is null + SQL contains both COALESCE patterns), `getProjectDetail` not filtered by `is_active`, `getProjectCounts` success + empty-row fallback, list + by-phase default filter and `includeInactive` opt-out.
- **`server/src/modules/projects/routes.test.ts`** — source-level checks for the `include_inactive` query param on `/` and `/by-phase`, `/counts` route existence.
- **`server/tests/scripts/backfill-projects-active-flag.test.ts`** — script unit tests + a parity fixture pinning that the script's `deriveIsActiveFromSnapshot` and the live mirror's `deriveIsActive` agree across 10 snapshot shapes (so they cannot drift).
- **`client/src/pages/projects/project-ui-source.test.tsx`** — counts API call, URL state toggle, `aria-pressed` controls, inactive visual treatment (`opacity-75`, `line-through`), bold-uppercase + MetricCard usage.

**Verification:**
- `npm run typecheck` exit 0 (shared, server, worker, client, client-field).
- `npx vitest run server/src/modules/projects/ server/tests/scripts/backfill-projects-active-flag.test.ts client/src/pages/projects/` → 7 files, 67 tests pass.

## Subagent review rounds

- **Round 1** — `.reviews/projects-page-active-filter-and-ux/review-round-1.md`. Found P0 (SyncHub sparse-snapshot overwrite), 3× P1 (asymmetric inference, counts UX, false-positive `.reviews` artifacts), 4× P2.
- **Round 2** — `.reviews/projects-page-active-filter-and-ux/review-round-2.md`. **CLEAN.** Round-1 P0 closed. Two LOWs accepted/deferred (no sort key for `status`, theoretical NULL handling in `getProjectCounts`).

## Smoke evidence

See `.reviews/projects-page-active-filter-and-ux/smoke.md` for the full transcript.

Key results:
- `/api/projects/counts` → `{"active":331,"inactive":392,"total":723}` for all three test roles.
- `/api/projects?perPage=1` → `pagination.total = 331`.
- `/api/projects?include_inactive=true&perPage=1` → `pagination.total = 723`.
- `/api/projects/by-phase` → 17 phases / 331 cards (active only).
- `/api/projects/by-phase?include_inactive=true` → 21 phases / 723 cards.
- Direct `GET /api/projects/<inactive-uuid>` → 200, `isActive: false`.

## Procore status field discovered

`active` (boolean) on the Procore project snapshot is the primary signal. `status_name` ("Active" / "Inactive") is the fallback. The mirror's `deriveIsActive` handles both; the live mirror, the backfill script, and the parity test all agree. The Procore company ID `598134325683880` (T Rock's) was reused via the existing `procoreClient`; no new credentials introduced.

## Counts before / after

| | Before deploy | After deploy |
|---|---|---|
| Default `/projects` view | 723 (no filter) | **331** (active only) |
| With `include_inactive=true` | n/a (no filter UI) | **723** |
| Database `is_active=true` count | 331 | 331 (unchanged) |
| Database `is_active=false` count | 392 | 392 (unchanged) |

**The 392 inactive rows were already in the table with `is_active=false`.** The earlier backfill (PRs #246–#250) had already captured the Procore `active` flag correctly; the gap was that the UI and API never filtered on it. No rows were modified by this PR. `scripts/backfill-projects-active-flag.ts` is in the repo as an idempotent safety net for any future drift.

## Migration SQL

**None.** The `is_active` column existed on the `projects` table (added with PR #243). No migration was added or required by this track.

## Assumptions made during autonomous operation

1. The `is_active` column was assumed to be already populated correctly from the earlier backfill. Verified during smoke by hitting `/api/projects/counts` — counts matched expectations exactly, so the soft-delete data backfill did not need to execute against prod.
2. Projects are intentionally NOT role-scoped (read-only Procore mirror). All three test accounts share the same view of the 331 / 392 / 723 numbers. This matches the structure inherited from PR #243.
3. The Active/Inactive pill toggle uses URL state so links stay shareable. Same pattern as the scope toggle on Leads/Deals.
4. The hotfix `husky || true` is the minimum-risk fix. It does not disable husky locally — git still installs hooks where the binary is present. The alternative (passing `HUSKY=0` in the Dockerfile env, or `--ignore-scripts`) would also have worked, but `|| true` is one character less risky and zero-config.
5. The reviewer's P1-3 / P2-4 (committed `.reviews/` and reports module changes in diff) were false positives caused by the rebase pulling in unrelated docs/reports commits from `origin/main`. Not addressed in this branch.

## Known issues / NEEDS INTERVENTION

- **None blocking.** Two LOWs from round-2 review accepted as future hardening:
  - `projects-page` sends `status` as a sort key but `SORT_COLUMNS` has no entry → silently falls back to phase sort. Pre-existing pattern, not a regression.
  - `getProjectCounts` would miss `is_active IS NULL` rows if the column ever drops NOT NULL. Currently NOT NULL is enforced by the schema, so this is theoretical.

## Worktree cleanup status

- `feat/projects-active-filter-and-ux` worktree at `/Users/adnaaniqbal/projects/trockcrm-projects-ux` — retained until the cleanup pass.
- `hotfix/prepare-husky-prod-deploy` worktree at `/Users/adnaaniqbal/projects/trockcrm-husky-fix` — retained until the user confirms acceptance.
- Both remote branches were auto-deleted on squash-merge.

## Hard-stop conditions checked

None tripped:
- Credentials worked for all three accounts.
- No PR revert needed — the earlier projects work (PRs #246–#250) was load-bearing and kept.
- No database migration ran. The schema already had `is_active`.
- No data corruption suspected; smoke counts match expectations exactly.
- Subagent review round 2 was CLEAN.
- Rebase resolved cleanly through two unrelated docs commits and the security commit.
- No SMOKE TEST DELETE fixtures touched.
- Procore API access was not needed at deploy time; the soft-delete signal was already in `procore_raw_snapshot`.
- SyncHub mirror change was in scope (CRM-side `procore-project-relay-service.ts` callers) — no foreign-repo access was needed.
