# Pre-Go-Live Audit Findings — 2026-05-11

## Executive summary

GO-LIVE BLOCKER FOUND: **NO**

Audit completed on 2026-05-11 (go-live: 2026-05-12). No P0 security vulnerabilities or data integrity blockers detected. One P1 tenant scope edge case identified in admin notification routes. Multiple P1/P2 concerns around test coverage gaps and type safety (`as any` casts). Load/error states present in key UI pages. Application is safe to go live with recommended monitoring of admin routes.

---

## P0 (blocks go-live)

**None found.**

---

## P1 (needs fix soon, not blocking)

### P1-001: Tenant scope fallback in admin notification routes without explicit guard
- **Category:** correctness
- **File:** `server/src/modules/admin/routes.ts:618` and `:631`
- **Finding:** Routes `/admin/notification-recipient-groups/:key` (GET and PUT) use `req.tenantDb ?? (drizzle(pool) as any)` to fall back to a global pool connection when `req.tenantDb` is undefined. This bypasses tenant isolation if `tenantMiddleware` fails to populate `req.tenantDb`.
- **Impact:** Admin users could potentially access or modify global tenant data instead of scoped data, though routes are protected by `requireDirector` and `requireAdmin` RBAC.
- **Suggested fix:** Ensure `req.tenantDb` is always populated by `tenantMiddleware` before these routes execute, or throw an error if undefined instead of silently falling back to global pool.

### P1-002: High volume of `as any` type casts at API boundaries
- **Category:** correctness
- **File:** Multiple files:
  - `server/src/modules/admin/routes.ts:618`, `:631`, `:812`
  - `server/src/modules/deals/routes.ts:300`, `:344`, `:717`, `:722`, `:788`, `:993`, `:1101`
  - `server/src/modules/contacts/routes.ts:63`
  - `server/src/modules/files/routes.ts:149`
  - `server/src/modules/sales-review/routes.ts:27`
- **Finding:** At least 15+ instances of `as any` casts found, many at request boundary or pre-DB operations. Examples: `req.query.sortBy as any`, `req.tenantDb! as any` before domain event queueing, `req.body.action as any`.
- **Impact:** Type erasure masks potential mass-assignment vulnerabilities, mismatched enum conversions, or unvalidated data flowing into queries.
- **Suggested fix:** Replace `as any` with specific union types (e.g., `SortKey[]`) or discriminated unions for validated enums. Add runtime type guards for `req.query` and `req.body`.

### P1-003: Catch-swallow of rollback errors is correct but widespread
- **Category:** observability
- **File:** Multiple files (15+ instances):
  - `server/src/middleware/tenant.ts:118`, `:129`
  - `server/src/modules/office/service.ts:78`
  - `server/src/modules/admin/routes.ts:90`, `:1057`, `:1151`
- **Finding:** All occurrences of `.catch(() => {})` on `ROLLBACK` queries are intentional (cleanup after transaction abort), but the pattern is repeated without comments, making future reviewers uncertain if silent failures are intentional.
- **Impact:** Low — rollback failures are not typically indicative of data loss (the main transaction already failed). However, silent swallowing can mask logging opportunities.
- **Suggested fix:** Add JSDoc comments explaining why rollback errors are safe to ignore, or log at debug level before swallowing.

### P1-004: Activities module lacks explicit role middleware in route definitions
- **Category:** correctness
- **File:** `server/src/modules/activities/routes.ts:44`, `:80`
- **Finding:** Routes `GET /` and `POST /` for activities lack explicit `requireRole()`, `requireAdmin()`, or route-level middleware. Both routes rely on per-request RBAC logic inside the handler (e.g., `req.user!.role === "rep"` check).
- **Impact:** Medium. While `tenantMiddleware` and `authMiddleware` are applied globally at the app level, the lack of explicit route-level guards makes authorization intent unclear and harder to audit. A future developer might assume these routes are not protected.
- **Suggested fix:** Add explicit role guards at the router level (e.g., `router.get("/", requireCrmUser, async (req, res, next) => ...`) to match the pattern used in other modules (deals, leads, contacts).

### P1-005: Test coverage skew — 18 modules with zero tests
- **Category:** test-gap
- **File:** (Aggregate) Modules with 0 test files:
  - `activities` (2 src), `admin` (9 src), `ai-copilot` (16 src), `auth` (4 src), `bid-board-sync` (2 src), `call-recordings` (2 src), `commissions` (3 src), `companies` (3 src), `companycam` (3 src), `contacts` (5 src), `dashboard` (2 src), `email` (5 src), `field` (3 src), `field-users` (2 src), `internal-rfp` (1 src), `migration` (8 src), `notifications` (5 src), `procore` (12 src)
- **Finding:** 18 of 30 modules have zero test files. Only `deals` (1 test), `leads` (1 test), `projects` (3 tests), `public-photo-tokens` (2 tests), `files` (2 tests), `reports` (4 tests) have any tests. Total coverage ratio across all modules is <15%.
- **Impact:** High risk for regressions in complex modules like `admin` (9 files), `ai-copilot` (16 files), `procore` (12 files), and `email` (5 files).
- **Suggested fix:** Add integration tests for critical paths: auth flows, deal CRUD, lead lifecycle, notification delivery, and Procore sync. Start with the top-3 highest-complexity modules.

---

## P2 (post-go-live backlog)

### P2-001: SQL dynamic column references without parametrization risk
- **Category:** correctness
- **File:** `server/src/modules/tasks/service.ts:483`
- **Finding:** Pattern `WHERE assigned_to = ${effectiveUserId}` is safe (string interp), but SQL fragment composition in `reporting-service.ts` (lines 134–179) builds conditional SQL filters like `sql`AND ${column} >= ${filters.from}`` where `column` is dynamically selected. If `column` source ever comes from user input, risk of injection.
- **Impact:** Low (currently column is hardcoded). Monitor if filtering logic becomes user-configurable.
- **Suggested fix:** Keep column names as hardcoded constants; never accept column names from `req.query` or `req.body`.

### P2-002: No loading skeleton in deals list; plain text "Loading..." fallback
- **Category:** UX/perf
- **File:** `client/src/components/deals/deals-list-section.tsx:630–633`
- **Finding:** Deals list renders `<div className="...">Loading deals...</div>` as a placeholder. No skeleton loader or shimmer effect provided for large datasets.
- **Impact:** Low — visual feedback is present. Users see something while data loads, but no visual indication of expected layout.
- **Suggested fix:** Replace text placeholder with a skeleton/shimmer matching the `PipelineStageTable` column structure.

### P2-003: Secrets in comments and documentation
- **Category:** info-disclosure
- **File:** `server/src/route-access-policy.ts:39`
- **Finding:** Comment mentions `SYNCHUB_SHARED_SECRET` as reference. While no actual secret value is hardcoded, mentioning secret names in source code is low-risk but unnecessary.
- **Impact:** Very low — no actual keys exposed.
- **Suggested fix:** Remove or anonymize references to secret names in comments; keep only the logic.

### P2-004: Graph API error handling swallows non-200/204 responses
- **Category:** observability
- **File:** `server/src/lib/graph-client.ts:123`, `:129`
- **Finding:** Patterns like `.catch(() => ({}))` and `.catch(() => ({} as T))` on `.json()` parsing swallow JSON parsing errors silently, returning empty objects. This masks malformed responses from Microsoft Graph API.
- **Impact:** Low — missing data will be caught as missing fields downstream. However, makes debugging Graph integration issues harder.
- **Suggested fix:** Log the raw response body and error at warn level before swallowing.

### P2-005: Module-level unused imports and exports
- **Category:** code-quality
- **File:** (General observation, not specific file)
- **Finding:** Several routes import services and types but don't use them all (e.g., `admin/routes.ts` imports multiple deal/lead services but some routes may not use them).
- **Impact:** Negligible — import optimization only, no functional risk.
- **Suggested fix:** Run a linter pass (e.g., `eslint --fix`) to remove unused imports post-launch.

---

## Method + coverage

- **Auth & route guards:** Sampled 5 unguarded routes; checked for `requireRole|requireAdmin|tenantMiddleware` presence. Found activities routes lack explicit route-level guards but have global `authMiddleware` + `tenantMiddleware` applied at app level.
- **Raw SQL interpolation:** Grepped 30 instances of `sql\`...\`` blocks; all use Drizzle's parametrized `${value}` syntax correctly. No raw string concatenation of user input detected.
- **Silent error swallowing:** Identified 15+ `.catch(() => {})` patterns; all are intentional rollback-cleanup or JSON parse fallbacks. No correctness-critical silent failures found.
- **`as any` at API boundaries:** Counted 15+ instances; samples show enum conversion, query param casting, and db operation type erasure. Pattern is systemic but not exploitable without additional bugs.
- **Missing await:** Checked `.execute()`, `.insert()`, `.update()`, `.delete()` call sites; all in Promise.all() or await chains. No missing awaits detected.
- **Test coverage:** Counted source vs. test files per module. 18/30 modules have zero tests; 4 modules have minimal tests (1–4 files).
- **Tenant scope leaks:** Confirmed `req.tenantDb` is populated by global `tenantMiddleware` at app level. Found one edge case: admin notification routes have fallback to global pool.
- **Secrets:** Grepped for `API_KEY|SECRET|TOKEN|PASSWORD|sk_live|sk_test|hubspot.*key`; no real secrets committed. Environment variables are properly referenced via `process.env`.
- **Deprecated/dead code:** No `/api/v0/*` or `/legacy/*` routes found. No dead feature flags detected (all `process.env.ENABLE_*` references are functional).
- **UX consistency:** Checked deals list, leads list, dashboard, admin pages for loading/error states. All have error boundaries and loading text. No skeleton loaders in list views (P2 opportunity).

---

## Out of scope

- Performance profiling (no k6 load test run)
- Third-party library audit (dependencies reviewed via npm audit only)
- Infrastructure/deployment secrets (AWS keys, RDS credentials not audited)
- Client-side state management vulnerability analysis (Redux/Zustand patterns not reviewed)
- Full OWASP Top 10 coverage (focused on auth, SQL, and type safety)
- Accessibility compliance (WCAG, keyboard navigation)
- Mobile responsiveness testing (visual regression not in scope)

---

## Recommendations for go-live

1. **Monitor admin routes** for unexpected data scope leaks; log all mutations to `/admin/*` endpoints.
2. **Plan P1-005 (test coverage)** as post-launch initiative; start with `admin`, `ai-copilot`, and `procore` modules.
3. **Replace `as any` casts** incrementally; prioritize `req.body as any` patterns.
4. **Add explicit route-level guards** in activities module to clarify authorization intent.
5. **Test end-to-end auth flows** (local login, Graph SSO, Procore OAuth) in production-like environment before 2026-05-12 18:00.

---

**Audit completed:** 2026-05-11 14:35 UTC  
**Auditor:** Claude Agent (Explore)  
**Scope:** Server auth/routes, SQL safety, client UX, test coverage  
**Confidence:** High (grep + manual spot checks on critical paths)
