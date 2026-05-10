# Round 1 Subagent Review

Reviewer: Singer
Date: 2026-05-10

## Verdict

No P1/P2 findings.

## P3/Test Gap

The UI coverage is good, but the initial patch did not include a server-side regression test proving `/api/deals/:id/detail` returns `project_type_config.name`. The implementation joins and selects `projectTypeConfig.name`, but the first project-type UI test mocked `deal.projectType` directly.

Resolution: added `getDealDetail` coverage in `server/tests/modules/deals/post-conversion-enrichment.test.ts` asserting a deal with lowercase stored `projectType` and linked `projectTypeId` returns the proper-cased config name.

## Verified Criteria

- Project type casing: detail API uses `COALESCE(projectTypeConfig.name, deals.projectType)` and joins config; visible badge no longer applies `uppercase`, and `formatDealType` does not lowercase populated `projectType`.
- Project number: deal detail page displays `deal.projectNumber` when present and falls back to `deal.dealNumber`.
- Fallback styling/caption: fallback path uses muted slate text and only renders `Not yet assigned` inside the fallback branch.
- System IDs: `Deal ID` is first under `System IDs`, with `HubSpot` still immediately after it.
- Right rail: company, owner, address, close target, HubSpot, and Procore sections remain present around the changed block.

## Review Verification

- `npx vitest run client/src/pages/deals/deal-detail-page.test.tsx`: passed 27/27 tests with existing React `act(...)` warnings in two tests.
- `git diff --check`: passed.

