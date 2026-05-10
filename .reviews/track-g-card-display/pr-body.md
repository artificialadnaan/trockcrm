## Summary

- Deal detail right rail now shows PROJECT NUMBER as the primary identifier when projectNumber is set.
- Deals without a project number fall back to dealNumber in muted styling with a Not yet assigned caption.
- System IDs now include Deal ID first, while HubSpot remains as its own row.
- Deal detail API now prefers project_type_config.name for proper-cased project type labels.

## Tests

- npm run typecheck
- npx vitest run client/src/pages/deals/deal-detail-page.test.tsx
- npx vitest run server/tests/modules/deals/post-conversion-enrichment.test.ts
- npm run test was run with escalation; it still has unrelated baseline failures outside this branch, while touched tests pass.

## Review Notes

Subagent review round 1 found no P1/P2 issues; one P3 server test gap was addressed in this PR.

