# TenantDb Promise.all Guard Report

Branch: `fix-tenantdb-promise-all`  
Base: `origin/main` at `2937016c`

## Summary

Production request-scoped `tenantDb` uses a single client/transaction per request. This change audits `server/` `Promise.all` / `Promise.allSettled` usage and serializes the cases where multiple tenant-schema queries shared that request connection. Concurrency that does not share a constrained request transaction was left unchanged.

## Full Classification

### Violations Fixed

- `server/src/modules/activities/service.ts:174` - list count and rows both queried request `tenantDb`.
- `server/src/modules/admin/routes.ts:549` - lead duplicate/detail related reads used multiple `req.tenantDb` queries in parallel.
- `server/src/modules/ai-copilot/context-service.ts:65` - deal copilot context ran multiple request `tenantDb.execute` reads concurrently.
- `server/src/modules/ai-copilot/intervention-policy-recommendation-review-service.ts:786` - history actor enrichment queried request `tenantDb` concurrently.
- `server/src/modules/ai-copilot/intervention-policy-recommendation-review-service.ts:845` - evaluation summary calls shared request `tenantDb`.
- `server/src/modules/ai-copilot/intervention-policy-recommendation-review-service.ts:860` - window and global decision reads shared request `tenantDb`.
- `server/src/modules/ai-copilot/intervention-service.ts:607` - intervention queue enrichment queried tasks/deals/companies/history on one `tenantDb`.
- `server/src/modules/ai-copilot/intervention-service.ts:783` - analytics enrichment queried deals/companies/users/history on one `tenantDb`.
- `server/src/modules/ai-copilot/intervention-service.ts:807` - analytics preview reads shared request `tenantDb`.
- `server/src/modules/ai-copilot/service.ts:1501` - company copilot contact/deal reads shared request `tenantDb`.
- `server/src/modules/ai-copilot/service.ts:1544` - suggested task and blind spot reads shared request `tenantDb`.
- `server/src/modules/ai-copilot/service.ts:1821` - sales disconnect dashboard executed multiple request `tenantDb` reads concurrently.
- `server/src/modules/ai-copilot/service.ts:2148` - AI ops metric summary/document reads shared request `tenantDb`.
- `server/src/modules/ai-copilot/service.ts:2393` - AI review packet detail queried packet/tasks/risks/feedback on one `tenantDb`.
- `server/src/modules/ai-copilot/signal-service.ts:46` - blind spot signal reads shared request `tenantDb`.
- `server/src/modules/companycam/service.ts:109` - import worker pool processed tenantDb inserts concurrently.
- `server/src/modules/contacts/merge-service.ts:47`, `:49` - merge queue entity enrichment queried same `tenantDb` concurrently.
- `server/src/modules/deals/scoping-service.ts:496`, `:719`, `:930`, `:1106` - scoping reads and mutation preloads shared request `tenantDb`.
- `server/src/modules/email/service.ts:780`, `:981`, `:995`, `:1345`, `:1491` - email stat collection, queue/list counts, and queue enrichment shared request `tenantDb`.
- `server/src/modules/estimating/workbench-service.ts:636` - estimating workbench state queried many tenant tables concurrently.
- `server/src/modules/field/projects-service.ts:124`, `:314` - field project count/rows and photo URL lookups shared request `tenantDb`.
- `server/src/modules/files/feed-service.ts:78` - photo feed count/rows shared request `tenantDb`.
- `server/src/modules/files/service.ts:803`, `:880`, `:1242` - file count/rows, photo target search, and photo timeline count/rows shared request `tenantDb`.
- `server/src/modules/leads/questionnaire-service.ts:296`, `:316`, `:475`, `:516` - questionnaire snapshots/gates/mirroring reads shared request `tenantDb`.
- `server/src/modules/leads/scoping-service.ts:84` - lead scoping intake and attachment key reads shared request `tenantDb`.
- `server/src/modules/notifications/service.ts:32` - notification count/rows shared request `tenantDb`.
- `server/src/modules/procore/reconciliation-service.ts:651`, `:708` - reconciliation deal/ignored-row lookups shared request `tenantDb`.
- `server/src/modules/public-photo-tokens/service.ts:272` - public photo URL lookup loop queried same `tenantDb` concurrently.
- `server/src/modules/sales-review/ownership-sync-service.ts:283` - tenant CRM deal and identity reads shared tenant connection; external HubSpot concurrency retained.
- `server/src/modules/sales-review/service.ts:329` - sales review lead/deal/activity/user/company/property reads shared request `tenantDb`.
- `server/src/modules/search/service.ts:122`, `:147`, `:216` - natural language and per-office search ran multiple searches on one tenant client; now settled sequentially.
- `server/src/modules/shared/team-scope.ts:12` - active office user primary/access reads shared request `tenantDb`.
- `server/src/modules/tasks/service.ts:329` - task count/rows shared request `tenantDb`.
- `server/src/services/directoryDedup.ts:262`, `:265` - directory merge queue item/entity enrichment shared request `tenantDb`.

### Safe Left Unchanged

- `server/src/modules/admin/routes.ts:1222` - independent per-office tenant contexts; each callback obtains its own tenant client.
- `server/src/modules/admin/user-import-service.ts:298` - external HubSpot/Procore API calls only.
- `server/src/modules/admin/users-service.ts:351` - global/public `db` reads, not request `tenantDb`.
- `server/src/modules/companycam/service.ts:119` - one external CompanyCam API call plus one tenant query; no multiple tenant queries share the `Promise.all`.
- `server/src/modules/deals/stage-gate.ts:235` - public `pipeline_stage_config` reads through global `db`.
- `server/src/modules/field/photos-service.ts:442` - URL/shape mapping only; no tenantDb query in the loop.
- `server/src/modules/leads/due-diligence-service.ts:491` - public stage lookup only.
- `server/src/modules/leads/service.ts:207` - one public `db` office query and one tenant helper; the helper is internally serialized.
- `server/src/modules/leads/service.ts:1197` - public stage config helpers plus one tenant query.
- `server/src/modules/leads/stage-gate.ts:350` - public stage lookups plus one tenant qualification query.
- `server/src/modules/migration/routes.ts:102` - migration/staging validation context, not request-scoped tenantDb.
- `server/src/modules/migration/service.ts:95`, `:171`, `:233`, `:295`, `:361`, `:456` - migration/global DB context, not request-scoped tenantDb.
- `server/src/modules/procore/routes.ts:87` - public/global Procore sync state tables.
- `server/src/modules/search/service.ts:178` - global/public `db` user office lookups.
- `server/src/modules/search/service.ts:240` - outer cross-office concurrency uses independent clients; inner per-office same-client search was serialized.
- `server/src/modules/sales-review/ownership-sync-service.ts:294` - external HubSpot calls only.
- Test/comment occurrences: `server/src/modules/projects/service.test.ts:329`, `server/tests/dashboard-rep-ytd-mtd.test.ts:79`, `server/tests/dashboard-rep-ytd-mtd.test.ts:118`, `server/tests/deals-contract-signed-filter.test.ts:52`, `server/tests/modules/contacts/list-ownership.test.ts:23`, `server/tests/modules/deals/manual-rfp-trigger-route.test.ts:469`, `server/tests/modules/deals/post-conversion-enrichment.test.ts:18`, `server/tests/modules/reports/workflow-overview-rep-filter.test.ts:63`.

## Implementation

- Replaced violating `Promise.all` and `Promise.allSettled` groups with sequential awaits while preserving returned values and ordering.
- For all-settled search behavior, added a sequential settle helper so one failed search type still allows the remaining search types to run.
- Replaced CompanyCam tenant import worker concurrency with sequential photo processing.
- Kept concurrency for external-only, public-db-only, and independent-client contexts.
- Added a regression test in `server/tests/modules/activities/service.test.ts` using a single-client guard that fails if list count and row queries overlap.
- Updated AI copilot context/signal tests to assert serialized execution instead of parallel dispatch.

## Review Rounds

1. Kepler reviewed the uncommitted diff for missed tenantDb violations and behavior/syntax/test risks. Result: no concrete findings.
2. Sagan reviewed remaining `Promise.all` / `Promise.allSettled` instances in `server/src` for missed violations and non-request single-client patterns. Result: no findings.
3. Final behavior/test adequacy review checked result shape, ordering, error handling, side effects, changed tests, syntax/type risks, and remaining obvious violations. Result: no concrete findings.

## Verification

- `npm run build --workspace=shared` - passed.
- Red test before production changes: `TMPDIR=/private/tmp npx vitest run server/tests/modules/activities/service.test.ts -t "serializes list count and row queries" --testTimeout=15000 --exclude '.worktrees/**'` - failed with `concurrent tenantDb query`, confirming coverage.
- Targeted regression after fixes: same command - passed.
- `npm run typecheck --workspace=server` - passed.
- Focused affected-module suite passed: 12 files, 167 tests.
- `git diff --check` - passed.
- Required broad command:
  `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'`
  - failed: 50 failed files, 477 passed files; 330 failed tests, 3700 passed tests; 251 uncaught errors.
  - Failures include known pre-existing categories from the task, especially `deal-list-page.test.tsx`, `detail-page-shell.test.tsx`, and sandbox/auth listen `EPERM`.
  - Additional broad-suite client failures occurred in untouched files such as `kanban-deal-card.test.tsx`, `deal-detail-page.test.tsx`, and `lead-form.test.ts`; no client files were changed by this PR.
