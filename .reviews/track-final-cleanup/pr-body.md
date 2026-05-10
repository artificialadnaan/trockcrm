## Summary

Consolidated final cleanup for `/deals` and `/pipeline` after Tracks K/L/M:

- restores `/deals` as its own route instead of redirecting to `/pipeline`
- keeps `/deals` board-only with KPI cards, scope toggle, search, and the five requested active deal columns
- preserves `/pipeline` as the full board/list surface with terminal columns, date filters, and project numbers
- fixes terminal Won/Lost queries so canonical terminal columns include inactive historical alias stage IDs
- fixes DealsListSection stage-family loading, same-slug multi-ID chip selection, scope pagination reset, DD chip parity, and stage-metadata loading behavior
- adds `.reviews/track-final-cleanup/` discovery and review artifacts

## Codex findings addressed

### Track M / PR #222

- P1 terminal columns under-report when canonical stage exists: fixed. Canonical Won/Lost queries now include all deal-family terminal alias IDs, including inactive historical aliases, while inactive aliases are not rendered as separate columns.
- P2 listIsActiveFilter disables list query on stage metadata failure: fixed. Known non-terminal selections can still query active-only while terminal/unknown selections stay disabled until metadata is safe.

### Track K / PR #223

- P1 scroll proxy spacer not re-running after kanban mounts: fixed on `/deals` by re-running the sizing effect on loading transition.
- P2 usePipelineStages without workflowFamily returns lead stages: fixed via `usePipelineStages("deal")` and backend support for the aggregate deal-family filter.
- P2 pagination not reset on scope change: fixed in DealsListSection.
- P2 Show DD toggle parity broken: fixed by excluding DD chips from the pipeline list when Show DD is off.
- P2 stage slug de-duplication drops alternate workflow family stage IDs: fixed by grouping all IDs per slug and sending all matching IDs.

## Verification

Passed:

- `npx vitest run client/src/App.test.tsx client/src/pages/deals/deal-list-page.test.tsx client/src/pages/pipeline/pipeline-page.test.ts client/src/components/deals/deals-list-section.test.tsx` - 46 tests passed
- `npx vitest run server/tests/modules/deals/pipeline-team-scope.test.ts` - 9 tests passed
- `npm run typecheck` - passed
- Subagent review rounds: 3 total, final round clean with no P1/P2 findings

Known full-suite status:

- `npm run test` was run first inside the sandbox and failed mostly on `listen EPERM` from Supertest route suites.
- It was rerun with escalation; sandbox bind errors cleared, but the server suite still has pre-existing baseline failures outside this cleanup diff: 20 failed files / 45 failed tests. Examples include missing `server/migrations/0107_commission_deal_snapshots.sql`, estimating workflow routes not found, CSRF logout expectation drift, report label expectations, and existing mock/export mismatches.

## Notes

- Prompt baseline expected `origin/main` at `0c6be74`, but after fetch, PR #222 and #224 were already merged into `origin/main` at `bb64f06`. This PR corrects the merged behavior in place.
- PR #222 and #224 could not be closed because GitHub reported both were already merged.
