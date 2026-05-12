# Production Smoke — projects-page-active-filter-and-ux

Date: 2026-05-11

## Deploy timeline

| Deploy ID | Status | Note |
|---|---|---|
| `4836d35e-...` | SUCCESS @ 20:00 | Last green build before this track started. |
| `54886bfb-...` | FAILED @ 20:27 | PR #252 security commit — Husky lifecycle script `husky` not found in runtime image. |
| `b3a8d906-...` | FAILED @ 20:40 | PR #253 reports fixes — same root cause. |
| `2a562870-...` | FAILED @ 20:46 | PR #254 (this track) — same root cause. |
| `5ccb15f4-620b-4dad-9fd5-3846c2de3a88` | **SUCCESS** @ 20:55 | PR #257 hotfix(deploy) — landed all 4 PRs to prod. **This is the deploy serving the new code.** |

## Hotfix root cause

The runtime image stage runs `npm ci --omit=dev --workspaces`, which excludes the `husky` devDependency but still executes the `prepare` lifecycle script. PR #257 changed `package.json` `"prepare"` from `"husky"` to `"husky || true"` so the script exits 0 whether or not the binary is installed.

## Smoke results — all PASS

### Endpoint behavior (test-admin@trock.test, <redacted-password>)

```
GET /api/projects/counts
→ {"active":331,"inactive":392,"total":723}

GET /api/projects?perPage=1   (active-only default)
→ pagination.total = 331

GET /api/projects?include_inactive=true&perPage=1
→ pagination.total = 723

GET /api/projects/by-phase
→ phases=17, total cards=331

GET /api/projects/by-phase?include_inactive=true
→ phases=21, total cards=723

GET /api/projects/<inactive_uuid>   (sample id 3db3d2af-...)
→ 200, isActive=false, name="1234"
```

### Per-role checks

```
test-director@trock.test, <redacted-password>
→ counts identical, default 331, include_inactive 723.

test-sales@trock.test, <redacted-password>
→ counts identical, default 331, include_inactive 723.
```

Projects are a Procore-mirror, read-only resource and intentionally not role-scoped (matching the pattern established by PR #243). All three roles share the same view.

### Sample active rows

```
- 1 Park Central                       | phase=In Production
- 1 Park Central                       | phase=Service - Close Out Final Invoice
- 2305 at Killearn                     | phase=Estimating - Sent to Client
```

### Inactive detail page

Confirmed `GET /api/projects/<inactive_uuid>` returns 200 with `isActive: false`. Direct links continue to work after soft-delete — pinned by the new `getProjectDetail` regression test.

## Data state observation

Prod data **already had `is_active` populated correctly** before this PR landed. The earlier backfill (PRs #246–#250) passed the full Procore snapshot through `buildProjectMirrorFields`, which mapped `snapshot.active` and `snapshot.status_name` to the column. The 392 inactive rows have been in the table all along — the bug was only that the UI and API never filtered on them.

That means **the one-off `scripts/backfill-projects-active-flag.ts` did not need to run against prod**. It is still in the repo as a safety net: if a future drift puts any row's `is_active` out of sync with its `procore_raw_snapshot`, run it with `--dry-run` first to see the delta.

## Final counts before / after

- **Before deploy** (UI view): all 723 projects visible by default. No filter UI.
- **After deploy** (UI view): 331 active by default. Toggle exposes the full 723.
- **Database**: 331 active / 392 inactive / 723 total (unchanged — no rows touched by this PR).

## UI smoke

The Kanban + searchable list + Active-only/Include-inactive toggle is built against the same API endpoints verified above. The `project-ui-source.test.tsx` regression suite pins the bold-uppercase header, the URL-state toggle, the `aria-pressed` controls, the inactive visual treatment (`opacity-75` cards, `line-through` rows), and the `MetricCard` usage. A manual browser pass against the production frontend `<redacted-frontend-host>/projects` reproduces the expected behavior.

## Health checks

```
GET https://<redacted-api-host>/api/health
→ 200
```

## Worktree status

- `feat/projects-active-filter-and-ux` worktree at `/Users/adnaaniqbal/projects/trockcrm-projects-ux` — retained until cleanup pass.
- `hotfix/prepare-husky-prod-deploy` worktree at `/Users/adnaaniqbal/projects/trockcrm-husky-fix` — to be removed after smoke is confirmed by the user.
