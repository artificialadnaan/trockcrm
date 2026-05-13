# Scope Read-Only After RFP Verification

Generated: 2026-05-13T02:26:54Z

## Local Verification

- `npx vitest run server/tests/modules/deals/scoping-service.test.ts server/tests/modules/deals/scoping-routes.test.ts server/tests/modules/files/audit-routes.test.ts client/src/components/deals/deal-scoping-workspace.test.ts client/src/pages/deals/deal-detail-page.test.tsx`
  - Result: pass
  - Latest result: 104 tests passed after round-3 fixes.
  - Coverage: backend lock/read/write behavior, resolved-fields guard/audit, linked scoping file mutation guard/audit, frontend read-only mode, admin force edit, and deal detail lock routing.
- `npm run typecheck`
  - Result: pass
- `git diff --check`
  - Result: pass

## Review Rounds

- Round 1: two subagent reviewers found P1 gaps around read endpoints, audit coverage, frontend/backend lock parity, and linked scoping file bypasses. Fixes were applied and retested.
- Round 2: first attempt was blocked by the session agent thread limit after stale agents returned empty statuses. Stale agents were closed and fresh round-2 reviewers were launched.
  - Findings: direct `PATCH /api/deals/:id` could still mutate scoping-backed fields; file address/new-version routes could still mutate linked scoping evidence; scoping read/write routes needed explicit deal access checks before raw scoping services.
  - Fixes: direct deal PATCH now checks the scoping lock for scoping-backed fields and audits admin force edits; scoping routes assert deal access first; linked scoping file address/new-version routes now use the shared lock/audit helper.
  - Latest focused regression: pass.
- Round 3: two subagent reviewers found P1 gaps around direct deal `name` changes and access-check ordering for generic deal PATCH.
  - Fixes: `name` is now treated as a scoping-backed direct patch field; generic deal PATCH now asserts normal deal access before invoking the scoping lock policy.
  - Latest focused regression: pass.
