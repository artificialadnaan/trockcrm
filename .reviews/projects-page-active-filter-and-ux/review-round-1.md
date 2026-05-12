# Subagent Review Round 1 — PR #254

Reviewer: oh-my-claudecode:code-reviewer
Date: 2026-05-11

## Findings

### P0
1. **SyncHub webhook relay does not pass `active` field in snapshot.** `server/src/modules/synchub/procore-project-relay-service.ts:82-88` builds `{ id, company_id, project_number, name }` only. `buildProjectMirrorFields` then evaluated `snapshot.status_name !== "Inactive"` against `undefined`, which is `true`. Result: every webhook-mirrored row was forced to `is_active = true` regardless of Procore state.

### P1
1. **Asymmetric handling of missing-both-fields between the live mirror and the backfill script.** Live mirror defaulted to truthy active; backfill script returned `null` and skipped.
2. **`getProjectCounts` returns globals while metric cards live next to filter UI.** Users applying phase / owner / search see the global "Active: 330" alongside a filtered list of 12.
3. **`.reviews/` artifacts from prior PRs (#245, #249) appeared in the diff.** False positive — these arrived via the rebase onto `origin/main`, not from this branch.

### P2
1. Hardcoded Procore company ID fallback in backfill-service (pre-existing).
2. No regression test asserting `getProjectDetail` is accessible regardless of `is_active`.
3. Duplicate `deriveIsActive` logic between script and live mirror.
4. Reports module changes in diff (false positive — also from the rebase).

## Fixes applied in this branch before round 2

- **P0 + P1-1**: Extracted `deriveIsActive(snapshot) → { isActive, reason } | null` as the single source of truth in `server/src/modules/projects/service.ts`. `buildProjectMirrorFields` and the upsert SQL now treat `null` as "no signal" — INSERT defaults to `true`, ON CONFLICT uses `COALESCE($16::boolean, projects.is_active)` so sparse webhook snapshots preserve the existing CRM state instead of overwriting it.
- **P1-2**: Updated metric card badges/captions to "CRM-wide, unfiltered" so the global vs filtered relationship is obvious.
- **P2-2**: Added a regression test confirming `getProjectDetail` returns inactive projects (direct links keep working after soft-delete).
- **P2-3**: Added a parity test fixture that runs both `deriveIsActive` (live mirror) and `deriveIsActiveFromSnapshot` (backfill script) over the same input set and asserts they agree on every case.

## Out of scope

- P1-3 and P2-4 are not changes introduced by this branch.
- P2-1 (hardcoded company ID) is pre-existing and out of this track's scope.
