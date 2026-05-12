# Subagent Review Round 2 — PR #254

Reviewer: oh-my-claudecode:code-reviewer
Commit reviewed: `f5465ab`
Date: 2026-05-11

## Verdict

**CLEAN.** Round-1 P0 (SyncHub sparse-snapshot overwriting `is_active`) is properly closed. No new P0/P1 introduced by the COALESCE refactor. Test coverage is sufficient.

## Confirmations

- Sparse snapshots produce `isActive=null` and the upsert preserves the prior CRM state via `COALESCE($16::boolean, projects.is_active)`.
- INSERT path defaults to `true` via `COALESCE($16::boolean, true)`; no NOT NULL violation.
- `EXCLUDED.is_active` would have masked the null signal — using `$16` directly in ON CONFLICT is exactly right.
- Parity test runs both `deriveIsActive` (live mirror) and `deriveIsActiveFromSnapshot` (script) across 10 fixture shapes; they cannot drift.
- `getProjectDetail` regression test pins that inactive projects remain accessible via direct link.
- Backfill `processRow` still correctly gates the office-prefix filter to NEW inserts only; existing rows always update on subsequent runs.

## Open LOWs (accepted / deferred)

1. **Sort key `status` has no SORT_COLUMNS entry.** `projects-page.tsx` sends `status` when the Status column header is clicked; `service.ts` falls back to `p.current_phase_sort_order`. Cosmetic, pre-existing pattern. Not blocking.
2. **`getProjectCounts` could miss `is_active IS NULL` rows.** The schema enforces `NOT NULL DEFAULT true`, so this is theoretical. Documented for future hardening if the schema ever loosens.

Exit review loop. Proceed to merge.
