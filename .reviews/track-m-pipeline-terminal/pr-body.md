## Summary

Follow-up to PR #219 / Track J-FIX for `/pipeline` data consistency.

Addresses the remaining Codex findings on `/pipeline`:

- P1 #1: Restricts list/export terminal stage IDs to terminal stages visible in the current board, preventing hidden or legacy terminal configs from leaking into `inactiveStageIds`.
- P2 #1: Handles `usePipelineStages` loading/error explicitly by deferring the list query/export until stage metadata is resolved.
- P2 #2: Changes terminal alias board queries so active won/lost aliases query their own `stage_id` when no canonical won/lost stage exists, while preserving canonical-stage behavior.

## Tests

- PASS: `npx vitest run client/src/pages/pipeline/pipeline-page.test.ts server/tests/modules/deals/pipeline-team-scope.test.ts`
- PASS: `npm run typecheck`
- KNOWN BASELINE FAILURES: `npm run test` still fails outside this patch scope with existing unrelated server failures (for example missing migration test fixture `0107_commission_deal_snapshots.sql`, estimating route tests expecting removed routes, CSRF logout expectations, report/migration/service mock mismatches). The Track M focused suites pass.

## Review

- Subagent review round 1: no P1/P2 findings.
