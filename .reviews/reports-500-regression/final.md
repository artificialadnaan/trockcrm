# Reports 500 Regression — Final Report

## Outcome

All four production report endpoints — **Pipeline Velocity**, **Closed Won
Revenue**, **Lead Conversion**, **Director Scorecard** — were returning HTTP
500. They now return HTTP 200 with valid, populated data in production.

## Links

- PR: [#245 fix(reports): resolve 500 errors in Pipeline Velocity, Closed Won Revenue, Lead Conversion, Director Scorecard](https://github.com/artificialadnaan/trockcrm/pull/245)
- Merge SHA: `32340748ba811372a74ff7706950342e2b153493`
- Merged: 2026-05-12T00:51:46Z
- API deploy: `db1db135` — SUCCESS
- Frontend deploy: `783994cf` — SUCCESS

## Per-report root cause + fix

| Report | Defect | Fix | Introduced in |
|---|---|---|---|
| Pipeline Velocity | `MAX(id) FILTER (WHERE rn = 1)::text` on a uuid column — `function max(uuid) does not exist` (the `::text` cast applies after aggregation) | `(array_agg(id::text) FILTER (WHERE rn = 1))[1]` (same for `name` and `days_in_stage`) | `5b54d12` (PR #241) |
| Closed Won Revenue | Same `MAX(uuid)` pattern in the `ownerRows` query | Same `array_agg(...)[1]` replacement | `5b54d12` (PR #241) |
| Lead Conversion | `l.status IN ('qualified', 'converted')` — `'qualified'` is not a valid `lead_status` enum label (the enum is `open` / `converted` / `disqualified`) | `l.status = 'converted'` (qualified-but-not-yet-converted leads stay covered by `l.qualification_completed_at IS NOT NULL`) | `5b54d12` (PR #241) |
| Director Scorecard | `LEFT JOIN users u ON u.id = t.responsible_user_id` — that column does not exist on `tasks` (the assignee column is `t.assigned_to`; this looks like a copy-paste from the `activities.responsible_user_id` activity-scope SQL) | `LEFT JOIN users u ON u.id = t.assigned_to` | `991efcb` (PR #239) |

The brief hypothesized a shared-helper regression from #240/#242. That hypothesis
did not hold — these were launch-day defects in the original #239 and #241
service files. The four reports never returned a 200 in production prior to
this PR.

## Test additions

Three new server-side regression tests in `sales-tier1-service.test.ts`, plus two
new assertions on the existing director-scorecard test in
`performance-tier2-service.test.ts`. Each pins a static SQL property:

- Pipeline Velocity: `array_agg(id::text) FILTER (WHERE rn = 1)` present, `MAX(id) FILTER (WHERE rn = 1)` absent.
- Closed Won Revenue: same pair on the ownerRows query.
- Lead Conversion: no SQL contains the literal `'qualified'`, summary SQL contains `l.status = 'converted'`.
- Director Scorecard: risks SQL contains `u.id = t.assigned_to`, does not contain `t.responsible_user_id`.

All four assertions would fail on `origin/main` and pass after this PR.

## Verification before merge

- `npm run typecheck` — clean across all workspaces
- `npx vitest run server/src/modules/reports/` — 28 / 28
- `npx vitest run client/src/pages/reports/ client/src/components/reports/` — 32 / 32
- Each fixed SQL executed directly against `DATABASE_PUBLIC_URL` with
  `search_path = office_dallas, public` — all four returned data
- After rebase on `origin/main` (which had moved by 5 commits, all in the
  `projects` module — no file overlap), tests re-run green

## Smoke evidence (production, post-deploy)

Full evidence in `.reviews/reports-500-regression/smoke.md`.
Run as `test-admin@trock.test` via `https://trockcrm.com/api/...` with
`dateFrom=2026-02-10&dateTo=2026-05-11`:

| Endpoint | Status | Bytes | Headline |
|---|---|---|---|
| `/api/reports/pipeline-velocity` | **200** | 4160 | 281 open deals · $107M open value |
| `/api/reports/closed-won-revenue` | **200** | 4778 | 184 won · $7.24M booked · 64.6% win rate |
| `/api/reports/lead-conversion` | **200** | 796 | 28 leads · funnel returned |
| `/api/reports/director-scorecard` | **200** | 2837 | $108.8M pipeline · 64.2% win rate · 198 at risk |

## Review state

- **Codex** (auto + triggered): clean — `+1` reaction and explicit "Codex Review:
  Didn't find any major issues" comment on PR #245.
- **Subagent code-reviewer (Opus)**: **APPROVE**. One MEDIUM defensive-hardening
  note: add explicit `ORDER BY` inside `array_agg(...)` to harden against a
  future refactor (e.g., `RANK` instead of `ROW_NUMBER`). Not addressing in
  this PR because `ROW_NUMBER` already guarantees a single row per partition,
  so pick-order is moot today; a separate hardening PR can cover it.

## NEEDS INTERVENTION

None. The fix is merged, deployed, and smoked.

## Notes for future tracks

- The brief noted `test-admin@trock.test` was "known broken". That was because
  the previous track tried it with the shared smoke password. The working
  password for admin is the dev-mode local value (`<redacted — test creds in
  ops vault>`), and the admin role satisfies `requireDirector`. Worth
  correcting in `.reviews/projects-tab/BACKFILL-BLOCKER.md` so the next
  track does not get blocked by the same stale advice.
- `test-director@trock.test` does **not** accept the admin's dev-mode value
  (`<redacted — test creds in ops vault>`). If a director-only smoke is
  required in a future track, the director-specific credential needs to be
  sourced separately.
