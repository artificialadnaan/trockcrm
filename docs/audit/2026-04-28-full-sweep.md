# Full Code Sweep Audit - 2026-04-28

Branch: `fix/audit-domain`  
Checkout: `/Users/adnaaniqbal/projects/trockcrm-audit`  
Scope: read-only audit of the CRM codebase. No production code was changed.

## Executive Summary

Total findings: 44

Severity breakdown:

- P0: 0
- P1: 6
- P2: 26
- P3: 12

Top P0s: none found.

Top risks found:

1. P1 security: cookie auth uses `SameSite=None` with credentialed CORS and no visible CSRF guard on state-changing routes.
2. P1 security: `DEV_MODE=true` enables dev auth independent of host or environment.
3. P1 authorization: director cleanup reassignment accepts any `officeId` without the same accessible-office check used by the read endpoint.
4. P1 reliability: Procore webhook idempotency is a 60-second heuristic with no unique replay key.
5. P1 dependency risk: `npm audit` reports high vulnerabilities in `drizzle-orm`, `vite`, and transitive `lodash`.

Methodology:

- Confirmed checkout with `pwd && git rev-parse --show-toplevel && git branch --show-current`.
- Searched with `rg` for secrets, auth, role checks, TODO/FIXME/HACK/XXX, raw SQL, route mounting, file upload, test skips, and dependency usage.
- Reviewed key server routers, tenant middleware, auth middleware, upload code, webhook handlers, project-number generation, board serializers, schema/migrations, and representative frontend hot paths.
- Ran `npm audit --audit-level=high --json`; it completed after sandbox network approval.
- Attempted local-only installation of optional tools (`knip`, `depcheck`, `madge`) and `npm outdated`; both were blocked by disk exhaustion (`ENOSPC`, only about 282MiB available). Findings below therefore use manual source review plus `npm audit` rather than those optional scanners.
- Verified project-number suffix generation uses a row lock (`FOR UPDATE`) and did not file it as unsafe.

## 1. SECURITY

### Finding SEC-01

- File: `server/src/modules/auth/http-config.ts:48`
- Severity: P1
- Category: Security - CSRF
- Description: Production auth cookies are `SameSite: "none"` and CORS allows credentials (`server/src/app.ts:63`). I did not find a CSRF token, origin enforcement middleware, or double-submit cookie guard for state-changing API calls. A malicious allowed-origin mistake or browser credentialed request path could mutate tenant state through the user's cookie.
- Suggested fix: Add centralized CSRF protection for cookie-authenticated unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) and enforce an exact `Origin`/`Referer` allowlist before route handlers. Consider using bearer-only auth for API writes if cross-site cookies remain necessary.
- Effort estimate: 2-3 days including integration tests.

### Finding SEC-02

- File: `server/src/modules/auth/http-config.ts:39`
- Severity: P1
- Category: Security - Auth bypass
- Description: `isDevAuthEnabled` returns true whenever `DEV_MODE=true`, regardless of host or `NODE_ENV`. That exposes `/api/auth/dev/users` and `/api/auth/dev/login` (`server/src/modules/auth/routes.ts:43`, `server/src/modules/auth/routes.ts:56`) if the environment variable is accidentally set in production.
- Suggested fix: Require both explicit dev mode and non-production localhost/test host, or hard-fail process startup if `DEV_MODE=true` with `NODE_ENV=production`.
- Effort estimate: 0.5 day.

### Finding SEC-03

- File: `server/src/modules/admin/routes.ts:353`
- Severity: P1
- Category: Security - Authorization
- Description: `POST /admin/cleanup/reassign` accepts `officeId` and calls `withOfficeTenantContext` without the accessible-office check used by `GET /admin/cleanup/office` at `server/src/modules/admin/routes.ts:308`. A director who can guess or obtain another office id may be able to attempt reassignment in an office outside their allowed scope.
- Suggested fix: Reuse the `getAccessibleOffices` check from the read endpoint before entering tenant context. Add integration tests for director access to allowed and disallowed offices.
- Effort estimate: 1 day.

### Finding SEC-04

- File: `server/src/modules/contacts/routes.ts:196`
- Severity: P2
- Category: Security - Object authorization
- Description: `GET /api/contacts/:id` fetches by id only (`getContactById`) and `PATCH /api/contacts/:id` updates by id only at `server/src/modules/contacts/routes.ts:284`. Tenant middleware prevents cross-tenant leakage, but there is no explicit per-role/object policy for reps. If contacts are intended to be scoped by assigned deals/leads, this leaks tenant-wide contact details to every authenticated tenant user.
- Suggested fix: Define the intended contact visibility model. If reps should be limited, enforce association-based visibility and update authorization in the route/service layer.
- Effort estimate: 1-2 days.

### Finding SEC-05

- File: `server/src/app.ts:85`
- Severity: P2
- Category: Security - Information exposure
- Description: Swagger docs are mounted publicly at `/api/docs` before auth middleware. The docs can expose endpoint shape, admin routes, and integration behavior to unauthenticated users.
- Suggested fix: Gate `/api/docs` behind admin auth in non-local environments, or disable it in production.
- Effort estimate: 0.5 day.

### Finding SEC-06

- File: `server/src/modules/tasks/rules/persistence.ts:149`
- Severity: P2
- Category: Security - SQL injection hardening
- Description: `createTenantTaskRulePersistence` accepts a raw `schemaName` string and interpolates it into SQL identifiers at `server/src/modules/tasks/rules/persistence.ts:188`, `server/src/modules/tasks/rules/persistence.ts:208`, and `server/src/modules/tasks/rules/persistence.ts:221`. Callers appear to derive schema names from office slugs, but this helper has no local validation or identifier quoting.
- Suggested fix: Centralize tenant schema identifier validation (`/^office_[a-z0-9_]+$/`) or use a safe identifier formatter before every raw schema interpolation.
- Effort estimate: 1 day.

### Finding SEC-07

- File: `client/src/components/email/email-thread-view.tsx:361`
- Severity: P2
- Category: Security - XSS dependency risk
- Description: Email HTML is rendered through `dangerouslySetInnerHTML` after `DOMPurify.sanitize`. That is the correct pattern, but `npm audit` reports a moderate DOMPurify advisory and the sink is high-impact because email body HTML is untrusted.
- Suggested fix: Upgrade DOMPurify, add regression tests with malicious email HTML fixtures, and keep sanitizer configuration narrow.
- Effort estimate: 1 day.

### Finding SEC-08

- File: `server/src/modules/auth/routes.ts:248`
- Severity: P3
- Category: Security - Redirect hygiene
- Description: The Graph OAuth callback redirects with `?error=${error}` without URL encoding at `server/src/modules/auth/routes.ts:250`. The value comes from a query parameter.
- Suggested fix: Use `encodeURIComponent(error)` or `URLSearchParams` for callback redirect parameters.
- Effort estimate: 0.25 day.

## 2. PRODUCTION RELIABILITY

### Finding REL-01

- File: `server/src/modules/procore/webhook-routes.ts:68`
- Severity: P1
- Category: Reliability - Webhook idempotency
- Description: Procore webhook dedupe checks only `event_type + resource_id` within 60 seconds. The log table has no provider event id or unique idempotency key, and the handler inserts a new job at `server/src/modules/procore/webhook-routes.ts:101`. Replays outside the time window, or concurrent duplicate requests, can enqueue duplicate work.
- Suggested fix: Store a provider event id or HMAC/body hash with a unique index. Insert the webhook log/job with `ON CONFLICT DO NOTHING` and return idempotent success for duplicates.
- Effort estimate: 1-2 days.

### Finding REL-02

- File: `server/src/modules/bid-board-sync/service.ts:241`
- Severity: P2
- Category: Reliability - Webhook idempotency
- Description: Bid Board ingestion computes `payloadHash` but immediately inserts a new sync run at `server/src/modules/bid-board-sync/service.ts:276` with no prior dedupe or unique constraint. Retry of the same signed payload can create duplicate runs and repeat downstream updates.
- Suggested fix: Add a unique key on `(payload_hash, source_filename, extracted_at)` or a signed delivery id, and make ingestion idempotent.
- Effort estimate: 1-2 days.

### Finding REL-03

- File: `server/src/modules/files/routes.ts:97`
- Severity: P2
- Category: Reliability - Input handling
- Description: `decodeURIComponent(req.headers["x-original-filename"] as string)` can throw `URIError` on malformed percent-encoding before the route can return a typed `AppError`. The global handler will convert it to a generic 500.
- Suggested fix: Validate the header exists as a string before decoding, wrap decoding in a `try/catch`, and return 400 for malformed filename encoding.
- Effort estimate: 0.5 day.

### Finding REL-04

- File: `server/src/modules/procore/webhook-routes.ts:45`
- Severity: P2
- Category: Reliability - Request size limits
- Description: The Procore webhook uses `express.raw({ type: "application/json" })` without an explicit size limit, unlike Bid Board (`25mb`) and file upload (`50mb`). The default may be lower than expected or could drift with framework defaults.
- Suggested fix: Set an explicit webhook body limit appropriate to Procore payloads and test oversized body behavior.
- Effort estimate: 0.25 day.

### Finding REL-05

- File: `server/src/modules/contacts/routes.ts:210`
- Severity: P2
- Category: Reliability - Input validation
- Description: Contact creation destructures `firstName`, `lastName`, and `skipDedupCheck`, then forwards the rest of `req.body` into `createContact`. Contact update forwards the whole body at `server/src/modules/contacts/routes.ts:287`. This can produce inconsistent data or unexpected DB errors when clients send wrong field types.
- Suggested fix: Add route-level schema validation with an explicit create/update allowlist and type coercion.
- Effort estimate: 1 day.

### Finding REL-06

- File: `server/src/services/projectNumber.ts:138`
- Severity: P3
- Category: Reliability - Race condition review
- Description: The project-number suffix path is currently safe because it inserts the daily row and then locks it with `FOR UPDATE` before incrementing. This is not a defect, but it is a critical invariant that should be protected by a concurrency regression test if not already covered with real parallel execution.
- Suggested fix: Add a parallel generation integration test against Postgres that asserts unique suffixes under concurrent calls.
- Effort estimate: 1 day.

## 3. DATA INTEGRITY

### Finding DATA-01

- File: `server/src/modules/deals/service.ts:1311`
- Severity: P2
- Category: Data integrity - Incorrect aggregates
- Description: `getDealsForPipeline` limits the query to 500 active deals and then computes per-stage `count` and `totalValue` from only those rows at `server/src/modules/deals/service.ts:1330`. Dense boards can undercount stage totals and hide records.
- Suggested fix: Return cards from a paginated/limited query, but compute counts and totals from separate aggregate queries without the card limit.
- Effort estimate: 2 days.

### Finding DATA-02

- File: `shared/src/schema/tenant/deals.ts:47`
- Severity: P2
- Category: Data integrity - Schema drift
- Description: The shared Drizzle schema notes that cross-schema FK constraints live in SQL migrations, not schema metadata. For example, `stageId` and `assignedRepId` have no `.references()` at `shared/src/schema/tenant/deals.ts:65`, while `migrations/0001_initial.sql:428` and `migrations/0001_initial.sql:429` define those FKs. This creates drift risk for generated types, local tooling, and future migrations.
- Suggested fix: Add a schema/migration consistency test or metadata manifest for cross-schema FKs so future changes cannot silently diverge.
- Effort estimate: 1-2 days.

### Finding DATA-03

- File: `server/src/modules/tasks/rules/persistence.ts:153`
- Severity: P3
- Category: Data integrity - Enum drift
- Description: Active task statuses are converted into a handwritten SQL string. The values come from a constant, but the query embeds the enum list manually instead of parameterizing it, making future enum changes harder to audit.
- Suggested fix: Parameterize active statuses with `ANY($n)` or centralize task-status SQL builders.
- Effort estimate: 0.5 day.

### Finding DATA-04

- File: `shared/src/schema/tenant/deals.ts:27`
- Severity: P3
- Category: Data integrity - Enum ownership
- Description: Proposal and estimating substage enums live in the schema, while UI/workflow TODOs indicate proposal behavior is still deferred (`client/src/pages/deals/deal-proposal-card.tsx:12`). The enum is committed before full workflow ownership is implemented, increasing stale-value risk.
- Suggested fix: Document enum ownership and add tests that UI state options match DB enum values when the proposal workflow is implemented.
- Effort estimate: 1 day.

## 4. PERFORMANCE

### Finding PERF-01

- File: `server/src/modules/deals/service.ts:1311`
- Severity: P2
- Category: Performance - Hot path query shape
- Description: The deal kanban fetches up to 500 full deal rows, groups in memory, and calculates totals in Node. This caps data correctness and makes the endpoint heavier than necessary on dense tenants.
- Suggested fix: Split into aggregate queries for counts/totals plus paginated cards per stage. Return a cursor for stage expansion.
- Effort estimate: 3-5 days.

### Finding PERF-02

- File: `server/src/modules/leads/service.ts:786`
- Severity: P2
- Category: Performance - Whole-table scan risk
- Description: The lead board query fetches every scoped lead row, groups all rows in memory, and then slices cards to `previewLimit` at `server/src/modules/leads/service.ts:818`. Counts are correct, but the hot path still pays for all matching leads.
- Suggested fix: Use SQL aggregates for counts plus limited cards per stage, or a lateral join/window function to return top N cards per stage.
- Effort estimate: 2-4 days.

### Finding PERF-03

- File: `client/src/components/pipeline/pipeline-board-column.tsx:100`
- Severity: P3
- Category: Performance - Frontend virtualization
- Description: Kanban virtualization exists and activates over 200 cards, but lead board cards are server-trimmed to 8-12 and deal board is globally capped at 500. The client protection works only after the backend sends large arrays; it does not solve backend hot-path load or per-stage pagination.
- Suggested fix: Keep virtualization, but pair it with backend stage pagination and add Playwright coverage that asserts `data-virtualized-card-count` for synthetic large board data.
- Effort estimate: 1-2 days.

### Finding PERF-04

- File: `server/src/modules/reports/report-builder-service.ts:228`
- Severity: P2
- Category: Performance - Reporting query cost
- Description: Report builder can group deals by multiple user-selected dimensions and joins stage/user tables. Inputs are allowlisted at `server/src/modules/reports/report-builder-service.ts:194`, but there is no explicit row limit, timeout, or saved-report cost guard visible in the query path.
- Suggested fix: Add query timeout, max dimension count/period defaults, and indexes for high-use filters. Record slow report telemetry.
- Effort estimate: 2-3 days.

## 5. DEAD CODE & DRIFT

### Finding DEAD-01

- File: `server/src/modules/auth/routes.ts:142`
- Severity: P3
- Category: Dead code & drift - Deferred route contract
- Description: SSO callback/login routes are documented as TODOs while Graph OAuth routes exist separately. This can confuse clients and future maintainers about the canonical auth path.
- Suggested fix: Remove obsolete TODOs or replace them with tracked issue references and current route names.
- Effort estimate: 0.25 day.

### Finding DEAD-02

- File: `server/src/modules/leads/routes.ts:242`
- Severity: P3
- Category: Dead code & drift - Deferred workflow
- Description: Lead approval still has TODO markers for replacing manual approval with email/tokenized approval. The same TODO appears in service and UI code (`server/src/modules/leads/service.ts:1010`, `client/src/components/leads/lead-form.tsx:371`, `client/src/components/leads/lead-form.tsx:466`).
- Suggested fix: Either schedule the PR2 approval flow or consolidate the TODO into a single tracked roadmap item to avoid scattered workflow drift.
- Effort estimate: 0.5 day to track; 3-5 days to implement.

### Finding DEAD-03

- File: `client/src/pages/deals/deal-proposal-card.tsx:12`
- Severity: P3
- Category: Dead code & drift - Incomplete feature
- Description: Proposal drafting has deferred TODOs for templates, version history, and e-sign while DB enums already include proposal status values.
- Suggested fix: Add a short proposal workflow spec or hide incomplete states until the workflow is implemented.
- Effort estimate: 1 day planning; 1-2 weeks implementation.

### Finding DEAD-04

- File: `client/src/pages/search/search-page.tsx:74`
- Severity: P3
- Category: Dead code & drift - Lint suppression
- Description: `eslint-disable react-hooks/exhaustive-deps` appears in search code, and another suppression appears in `client/src/hooks/use-photo-feed.ts:75`. Suppressions can conceal stale closure bugs in data-fetching paths.
- Suggested fix: Refactor effects to stable callbacks or document why each suppression is safe with tests.
- Effort estimate: 0.5-1 day.

### Finding DEAD-05

- File: `server/src/modules/dashboard/service.ts:1106`
- Severity: P3
- Category: Dead code & drift - Naming debt
- Description: Dashboard service carries a naming-debt comment pointing to `TODO.md`. The codebase has several workflow naming layers, so unresolved naming debt can become report/API drift.
- Suggested fix: Resolve or link the exact TODO item and add a naming glossary near shared workflow constants.
- Effort estimate: 1 day.

## 6. TEST COVERAGE GAPS

### Finding TEST-01

- File: `server/src/modules/procore/webhook-routes.ts:43`
- Severity: P2
- Category: Test coverage - Integration gaps
- Description: I found no corresponding Procore webhook route integration test, despite raw body parsing, signature validation, dedupe, logging, and job enqueue behavior living in this route.
- Suggested fix: Add tests for valid signature, invalid signature, replay/idempotency, oversized body, invalid JSON, and job enqueue transaction behavior.
- Effort estimate: 1-2 days.

### Finding TEST-02

- File: `server/src/modules/files/routes.ts:95`
- Severity: P2
- Category: Test coverage - Integration gaps
- Description: File upload has service tests, but the direct-upload route path lacks visible integration coverage for malformed headers, invalid filename encoding, content type, size limit, deal/lead authorization, and R2 failure behavior.
- Suggested fix: Add route-level tests with Supertest or equivalent mocks around R2.
- Effort estimate: 1-2 days.

### Finding TEST-03

- File: `client/e2e/pipeline-workflow-alignment.spec.ts:44`
- Severity: P2
- Category: Test coverage - Skipped e2e
- Description: Critical pipeline workflow coverage is skipped when no property seed exists. That makes the check environment-dependent and easy to miss in CI.
- Suggested fix: Seed the minimal property fixture in the test setup or convert the skip into a hard fixture failure in CI.
- Effort estimate: 1 day.

### Finding TEST-04

- File: `client/e2e/dashboard-contracts-signed-cards.spec.ts:143`
- Severity: P2
- Category: Test coverage - Skipped e2e
- Description: Dashboard signed-contract card coverage can skip silently when seeded data is missing.
- Suggested fix: Add deterministic tenant fixtures or an API setup helper that creates the needed signed contract state.
- Effort estimate: 1 day.

### Finding TEST-05

- File: `server/src/services/projectNumber.ts:138`
- Severity: P2
- Category: Test coverage - Concurrency
- Description: Project-number generation uses the right row-lock pattern, but the existing audit confirmed the code path rather than a live concurrent database test in this sweep.
- Suggested fix: Add a Postgres-backed concurrency test that launches multiple suffix reservations for the same day and asserts unique ordered results.
- Effort estimate: 1 day.

## 7. DEPENDENCY RISKS

### Finding DEP-01

- File: `server/package.json:23`
- Severity: P1
- Category: Dependency risk - Security advisory
- Description: `npm audit` reports a high vulnerability for `drizzle-orm` (`<0.45.2`) related to SQL injection via escaped SQL identifiers. The repo uses `drizzle-orm` in server, shared, and worker packages.
- Suggested fix: Upgrade Drizzle in all workspaces, run migrations/typecheck/tests, and pay special attention to raw SQL and `sql.identifier` paths.
- Effort estimate: 2-4 days.

### Finding DEP-02

- File: `client/package.json:47`
- Severity: P1
- Category: Dependency risk - Security advisory
- Description: `npm audit` reports high Vite advisories. The client declares `vite ^6.0.7`, and the lockfile contains Vite entries at `package-lock.json:675` and `package-lock.json:12603`.
- Suggested fix: Upgrade Vite to a patched line, verify dev-server config, rebuild, and run client e2e smoke tests.
- Effort estimate: 1-2 days.

### Finding DEP-03

- File: `package-lock.json:8878`
- Severity: P2
- Category: Dependency risk - Transitive advisory
- Description: `npm audit` reports high advisories for transitive `lodash`. The lockfile resolves `lodash` at `package-lock.json:8878`.
- Suggested fix: Identify the parent dependency path from `npm audit`/`npm ls lodash`, upgrade the parent, or override to a patched Lodash version.
- Effort estimate: 0.5-1 day.

### Finding DEP-04

- File: `client/package.json:23`
- Severity: P2
- Category: Dependency risk - Security advisory
- Description: `npm audit` reports a moderate advisory for `dompurify <=3.3.3`, and the app uses DOMPurify on untrusted email HTML.
- Suggested fix: Upgrade DOMPurify and add sanitizer regression tests for email rendering.
- Effort estimate: 0.5-1 day.

### Finding DEP-05

- File: `worker/package.json:19`
- Severity: P2
- Category: Dependency risk - Security advisory
- Description: `npm audit` reports a moderate advisory for `node-cron 3.0.2-3.0.3`. The worker imports `node-cron` at `worker/src/index.ts:8`.
- Suggested fix: Upgrade `node-cron` to a patched version and run worker job tests.
- Effort estimate: 0.5 day.

### Finding DEP-06

- File: `server/package.json:17`
- Severity: P2
- Category: Dependency risk - Security advisory
- Description: `npm audit` reports moderate advisories under `@azure/msal-node`/`fast-xml-parser`. Server and worker both depend on `@azure/msal-node`.
- Suggested fix: Upgrade MSAL and verify Graph auth/email sync flows.
- Effort estimate: 1-2 days.

### Finding DEP-07

- File: `client/package.json:43`
- Severity: P2
- Category: Dependency risk - Security advisory
- Description: `npm audit` reports a moderate PostCSS advisory. The client declares `postcss ^8.4.49`, while the lockfile resolves patched and nested PostCSS versions in multiple places.
- Suggested fix: Refresh lockfile after dependency upgrades and ensure all PostCSS instances resolve to patched versions.
- Effort estimate: 0.5 day.

## 8. CODE QUALITY

### Finding QUAL-01

- File: `client/src/components/leads/lead-form.tsx:315`
- Severity: P2
- Category: Code quality - Large component
- Description: `EditableLeadForm` combines display derivation, assignment mutation, manual verification, navigation controls, and rendering in one component. This makes workflow changes risky and increases re-render surface.
- Suggested fix: Extract assignment controls, verification controls, and display selectors into focused components/hooks with tests.
- Effort estimate: 2-3 days.

### Finding QUAL-02

- File: `worker/src/jobs/index.ts:107`
- Severity: P2
- Category: Code quality - Large registration function
- Description: `registerAllJobs` centralizes every worker handler registration in a single growing function. It is easy to create import-time coupling and hard to audit job ownership.
- Suggested fix: Split job registrations by domain modules and compose them from a registry list with tests that assert expected job names are registered.
- Effort estimate: 1-2 days.

### Finding QUAL-03

- File: `server/src/modules/sales-review/routes.ts:13`
- Severity: P3
- Category: Code quality - Inconsistent patterns
- Description: Sales review defines a local `requireRole` helper while shared RBAC middleware exists at `server/src/middleware/rbac.ts:5`. Multiple role-check patterns make authorization audits harder.
- Suggested fix: Use the shared RBAC helpers consistently or document why this route needs a local request-level helper.
- Effort estimate: 0.5 day.

### Finding QUAL-04

- File: `server/src/middleware/tenant.ts:97`
- Severity: P2
- Category: Code quality - Inconsistent tenant SQL safety
- Description: Tenant middleware sets `search_path` through parameterized `set_config`, while other code paths interpolate tenant schema names manually (for example `server/src/modules/tasks/rules/persistence.ts:188` and `server/src/modules/bid-board-sync/service.ts:213`). The inconsistency raises audit cost and injection risk.
- Suggested fix: Create one tenant schema identifier utility and forbid ad hoc schema interpolation by lint rule or code review checklist.
- Effort estimate: 1-2 days.

### Finding QUAL-05

- File: `server/src/modules/reports/report-builder-service.ts:136`
- Severity: P3
- Category: Code quality - Defensive allowlists
- Description: Report builder has good allowlists for dimensions/measures, but it is a standalone pattern. Similar dynamic query builders should reuse the same assertion style so future raw SQL paths are consistently guarded.
- Suggested fix: Extract a small allowlist/assertion helper for dynamic report/filter builders.
- Effort estimate: 0.5 day.

## 30-Day Prioritized Roadmap

### Week 1 - Security and Dependency Hotfixes

1. Patch dependency advisories: Drizzle, Vite, DOMPurify, MSAL, node-cron, PostCSS, and Lodash parent path.
2. Lock down dev auth so `DEV_MODE=true` cannot expose dev login in production.
3. Gate `/api/docs` behind auth or disable it in production.
4. Add accessible-office authorization to `POST /admin/cleanup/reassign`.
5. Add CSRF/origin protection for cookie-authenticated write requests.

### Week 2 - Idempotency and Input Validation

1. Add durable Procore webhook idempotency keys and unique constraints.
2. Make Bid Board ingestion idempotent by payload/delivery id.
3. Add route-level validation for contact create/update.
4. Harden upload-direct header decoding and oversized/malformed upload responses.
5. Add Procore webhook and upload-direct integration tests.

### Week 3 - Board Data Correctness and Performance

1. Split deal board card queries from aggregate count/total queries.
2. Refactor lead board to SQL aggregates plus per-stage preview rows.
3. Add kanban pagination/expansion contract and frontend virtualization coverage.
4. Add slow-report telemetry, timeouts, and report-builder cost limits.

### Week 4 - Drift Reduction and Maintainability

1. Add schema/migration drift checks for cross-schema foreign keys and enum ownership.
2. Consolidate role-check helpers and tenant schema SQL helpers.
3. Extract large lead form and worker job registration modules.
4. Resolve or centralize TODOs for SSO, tokenized lead approval, proposal drafting, and dashboard naming debt.
5. Replace skipped e2e tests with deterministic fixtures.
