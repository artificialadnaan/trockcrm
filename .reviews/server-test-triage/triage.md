# Server Test Suite Triage - 2026-05-12

Assumptions:
- Canonical baseline is `/tmp/trockcrm-server-test-triage-20260512-escalated.log`; the first sandboxed run was discarded because Supertest could not bind local ephemeral listeners (`listen EPERM`).
- Branch base is `origin/main` at `d2315412c9481cac9510ae0b603b7ea5c564e840`. Local `fix/pre-smoke-unblock-trio` exists in `/private/tmp/trockcrm-origin-main-audit` at the same commit, with no remote ref available.
- Triage scope is the full server workspace baseline run: 24 failed files, 54 failed tests.
- After fixes and rebase onto `origin/main` (`01ec9471`), `npm run test --workspace=server` exits 0: 263 passed files, 1967 passed tests. Latest output captured in `/tmp/trockcrm-server-test-rebased-prepr-3-20260512.log`.

Go-live scope warning:
- The failures include two real production-adjacent regressions: logout is currently CSRF-exempted, and the estimating route handlers are absent from `dealRoutes`.
- Full green plus DD live smoke is likely more than four hours of work because restoring the estimating route surface affects 28 tests and many service boundaries. Priority order is Bucket B first, then high-traffic Bucket A/C drift.

| File | Test name | Bucket | Root cause | Fix plan | Est. |
|---|---|---:|---|---|---:|
| `server/tests/app-csrf-public-auth.test.ts` | keeps logout CSRF-protected | B | `isPublicAuthCsrfExempt` includes `/api/auth/logout`, bypassing cookie-pair CSRF. | Remove logout from CSRF public auth exemption and update unit contract. | S |
| `server/tests/app-csrf-field-cross-origin.test.ts` | keeps logout protected by the existing CSRF cookie pair | B | Same logout exemption bypasses CSRF even with field requested-with header. | Same code fix; retain app-level regression coverage. | S |
| `server/tests/field-route-policy.test.ts` | keeps every current CRM tenant route behind the CRM-only policy with field routes explicitly allowlisted | A | Test route list is stale; `/projects` is now a CRM-only tenant route. | Add `/projects` to expected list. | XS |
| `server/tests/lib/r2-client.test.ts` | should generate valid mock upload URLs | A | Upload URL expiry changed from 15 min to 30 min. | Expect `30 * 60`. | XS |
| `server/tests/lib/r2-client.test.ts` | should use 15-minute expiry for uploads | A | Test name/expectation stale after 30 min expiry. | Rename/expect 30 min. | XS |
| `server/tests/modules/files/service.test.ts` | should enforce 50 MB limit | A | File limit is now 200 MB. | Expect `200 * 1024 * 1024`. | XS |
| `server/tests/modules/files/service.test.ts` | should allow files at exactly 50 MB | A | Stale 50 MB exact-value expectation. | Rename/expect exact 200 MB. | XS |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | returns workflow state for the estimating shell | B | `/:id/estimating` handlers disappeared from `dealRoutes`. | Restore estimating route imports and handlers from prior route surface. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | returns 404 when a reprocess target document is missing | B | Missing `POST /:id/estimating/documents/:documentId/reprocess`. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | passes parse measurement options through document upload and reprocess routes | B | Missing document upload/reprocess routes. | Restore routes. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | accepts a pre-uploaded deal file when creating an estimate source document | B | Missing document upload route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | returns copilot answers using server-built context | B | Missing `POST /:id/estimating/copilot`. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | requires generationRunId before promotion | B | Missing `POST /:id/estimating/promote`. | Restore route and validation. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | updates an extraction row for the workbench | B | Missing extraction review route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | approves an extraction row for the workbench | B | Missing extraction approve route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | rejects an extraction row for the workbench | B | Missing extraction reject route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | selects a catalog match for the workbench | B | Missing match select route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | rejects a catalog match for the workbench | B | Missing match reject route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | approves a pricing recommendation for the workbench | B | Missing pricing approve route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | rejects a pricing recommendation for the workbench | B | Missing pricing reject route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | overrides a pricing recommendation for the workbench | B | Missing pricing override route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | returns the effective market context for a deal | B | Missing market context route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | lists active market choices for override selection | B | Missing markets route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | sets a market override, writes an audit event, and enqueues an estimate generation rerun | B | Missing market override route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | clears a market override, writes an audit event, and enqueues an estimate generation rerun | B | Missing clear override route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | updates review state for 'accept_recommended' | B | Missing pricing review-state route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | updates review state for 'accept_manual_row' | B | Missing pricing review-state route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | updates review state for 'switch_to_alternate' | B | Missing pricing review-state route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | updates review state for 'override' | B | Missing pricing review-state route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | updates review state for 'reject' | B | Missing pricing review-state route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | updates review state for 'pending_review' | B | Missing pricing review-state route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | returns row-level promotion errors when duplicate recommendations are blocked | B | Missing promote route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | creates a pending-review manual row from free text when no catalog item is selected | B | Missing manual row route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | keeps an immutable manual identity when a manual row is edited into a catalog-backed selection | B | Missing manual row patch route. | Restore route. | M |
| `server/tests/modules/estimating/workflow-state-routes.test.ts` | promotes only free-text manual rows into the local catalog and seeds override values | B | Missing manual-row local catalog promotion route. | Restore route. | M |
| `server/tests/modules/estimating/estimating-security.test.ts` | rejects document upload when the user cannot access the deal | B | Same missing document upload route. | Restore route. | S |
| `server/tests/modules/estimating/document-service.test.ts` | uses a conditional insert-select to guard estimate generation enqueue | C | Mock tenant DB lacks `insert(...).values(...).returning()` now required by parse-run creation. | Extend fixture mock to support parse-run insert. | S |
| `server/tests/modules/deals/board-service.test.ts` | limits board payload cards to the preview window while keeping the full count | A | `listDealBoard` was replaced by `getDealsForPipeline`; old test imports removed API. | Update or remove stale test against current pipeline preview behavior. | S |
| `server/tests/modules/deals/routing-service.test.ts` | adds active service-deal stages so under-threshold routing has an entry stage | A | Migration no longer seeds legacy `service_review` slug; current active service slugs are `service_estimating`, `service_estimate_under_review`, `service_estimate_sent_to_client`. | Update expected slugs. | XS |
| `server/tests/modules/deals/ownership-service.test.ts` | falls back to operations ownership for production stages without handoffs | B | Legacy/current production stage aliases are not both mapped to operations. | Include `in_production` as production ownership alias. | XS |
| `server/tests/modules/deals/contract-signed-date.test.ts` | allows contract_signed_at to be written with handoff flag off but queues no Procore handoff event | A | Feature flag now defaults enabled; test never sets `ENABLE_CONTRACT_SIGNED_HANDOFF=false`. | Set env false in test. | XS |
| `server/tests/modules/auth/dev-login-demo-bootstrap.test.ts` | does not seed the auth demo workspace by default during dev login | C | Mock auth service omitted `getUserOnboardingGateStatus`, causing 500 after dev login. | Add mock export/default response. | XS |
| `server/tests/modules/auth/dev-login-demo-bootstrap.test.ts` | can still seed the auth demo workspace when explicitly enabled | C | Same missing mock export. | Add mock export/default response. | XS |
| `server/tests/modules/leads/conversion-service.test.ts` | ignores parent-gated child questions when the parent is unanswered or false during Sales Validation gating | C | Fake tenant DB table matcher lacks a newly queried table path. | Add fake table support or adjust fixture ordering. | S |
| `server/tests/modules/leads/conversion-service.test.ts` | strips migrationMode from public deal-create requests | C | Route fixture request lacks `query`, but route now redacts based on `req.query`. | Add `query: {}` to fixture request. | XS |
| `server/tests/modules/leads/conversion-service.test.ts` | strips migrationMode from public deal-update requests | C | Same missing `query` fixture. | Add `query: {}` to fixture request. | XS |
| `server/tests/modules/leads/reassignment.test.ts` | creates a new lead assignment task when assignedRepId changes | C | Queue-based fake DB is out of sync with new `validateAssignee` query order and office-access check. | Reorder/add queued rows. | XS |
| `server/tests/modules/delete-policy-services.test.ts` | soft-deletes active companies and returns null for already inactive companies | C | Fake query chain lacks `leftJoin`, now used by `getCompanyById`. | Add chainable `leftJoin` to fake DB. | XS |
| `server/tests/modules/migration/commission-deal-snapshots-migration.test.ts` | test file load | C | Test reads `process.cwd()/migrations`, but workspace cwd is `server/`; migrations live at repo root. | Resolve path from `import.meta.dirname`. | XS |
| `server/tests/modules/migration/lead-dd-recipient-reseed-migration.test.ts` | test file load | C | Same wrong migration path assumption. | Resolve path from `import.meta.dirname`. | XS |
| `server/tests/modules/migration/activity-attribution-migration.test.ts` | applies to all existing office schemas | A | Migration now uses `PERFORM set_config('search_path', format('%I,public', tenant_schema), true)` instead of literal `SET LOCAL`. | Update assertion to current idempotent implementation. | XS |
| `server/tests/modules/sales-review/service.test.ts` | builds forecast, activity cadence, hygiene, and support views from canonical records | A | Support-request expectation is stale for current overview behavior. | Update fixture/expectation after confirming current contract. | S |
| `server/tests/modules/tasks/inbound-email-rules.test.ts` | splits reply-needed and disambiguation into distinct rules | A | A legacy no-op email assignment rule remains registered for compatibility. | Expect/filter the no-op rule intentionally. | XS |
| `server/tests/modules/reports/saved-reports-service.test.ts` | does not seed duplicates when all locked presets already exist | A | Locked preset changed from `Closed-Won Summary` to `Won Deals Summary`. | Update expected preset list. | XS |
| `server/tests/modules/reports/service.test.ts` | keeps CRM-owned progression, mirrored downstream bottlenecks, and reason-coded disqualifications queryable | A | Mirrored stage label resolver now returns canonical `Estimating`, not `Service - Estimating`. | Update expectation. | XS |
| `server/tests/modules/reports/unified-pipeline-report.test.ts` | returns stale lead and stale deal outputs | A | Canonical stale deal stage label is now `Estimate Sent to Client`, not `Bid Sent`. | Update expectation. | XS |

## Final Bucket Summary

- Bucket A, stale test expectations: fixed in tests only.
- Bucket B, production-relevant code regressions: fixed in `server/src/modules/auth/http-config.ts`, `server/src/modules/deals/routes.ts`, and `server/src/modules/deals/ownership-service.ts`.
- Bucket C, fixture/infrastructure drift: fixed in local mocks and migration-path tests.
- Bucket D, deferred/skipped tests: none.
