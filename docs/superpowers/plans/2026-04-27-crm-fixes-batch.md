# CRM Fixes Batch — April 2026 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a connected batch of CRM bug fixes (lead save, modal contradiction, verification email) and new features (contract-signed date, commission engine, YTD/MTD metrics, activity range dropdown, Bid Board activity funnel) confirmed in client meeting on 2026-04-27.

**Architecture:** Monorepo (shared/server/worker/client). Drizzle ORM + tsx migration runner. Express API, React+Vite+Tailwind+shadcn/ui client. Deals table is the project entity (no separate projects table). qualificationPayload is a JSONB blob on leads holding estimated_value + timeline_status. Commission engine new; built around deal contract-signed transition. Bid Board funnel uses existing activities table + new origin column + new SyncHub-authenticated endpoint.

**Tech Stack:** TypeScript strict, Drizzle ORM, Express, Resend (email), React 18 + Vite + Tailwind + shadcn/ui, Recharts, Vitest. PostgreSQL on Railway.

---

## Decisions captured (from approval session)

1. "Project card" = deal card. Add `contract_signed_date` to `deals` table.
2. Native `<input type="date">` wrapped in `<DateField>`. No new deps.
3. Verification email: pull recipients from active admin/director users **and** add `verification_status` enum with approve/reject CTAs that block lead advancement past sales validation while pending. Past-year activity guard stays.
4. Bid Board funnel: CRM side only this session. Add `origin` column on activities (cleaner than overloading sourceEntityType). New endpoint `POST /api/integrations/synchub/activities` with idempotency key. Endpoint contract documented at `docs/integrations/synchub-activity-push.md`.
5. Commission fires only on null→date transition; idempotency guard on (deal_id, rep_id). Recalc-on-edit deferred to TODO.md.

**Foundational addition (Commit 0):** Global `EMAIL_OVERRIDE_RECIPIENT` env var for dev/staging that reroutes all outbound mail to a single address with subject prefix + body banner.

---

## Per-commit discipline

After each commit:
- `npm run typecheck`
- Run new tests + existing tests in touched area (`npm test --workspace=server`)
- For Commits 1+, grep new email call sites — must go through wrapped `sendSystemEmail`, not direct Resend client
- List files changed
- Brief summary: what changed, manual test path
- Do NOT push or open PRs without review

---

## Commit Plan

### Commit 0 — `chore(email): EMAIL_OVERRIDE_RECIPIENT dev override`

**Files:**
- Modify: `server/src/lib/resend-client.ts` (wrap sendSystemEmail with override layer)
- Modify: `.env.example` (add `EMAIL_OVERRIDE_RECIPIENT=`)
- Modify: `README.md` (add Development → Email Override section)
- Test: `server/tests/email-override.test.ts` (new)

**Behavior:**
- If `EMAIL_OVERRIDE_RECIPIENT` is set: override `to`/`cc`/`bcc` to that address; prepend `[→ original@example.com] ` to subject; inject body banner.
- If unset/empty: behave normally.

---

### Commit 1 — `fix(leads): persist qualificationPayload under v2 flag`

**Files:**
- Modify: `server/src/modules/leads/service.ts` (around line 1190 — remove `!v2Enabled` guard from qualificationPayload write path)
- Test: `server/tests/leads-update-v2-payload.test.ts` (new) — assert estimated_value + timeline_status persist when v2 flag is on

---

### Commit 2 — `fix(leads): unify advance-stage modal gating into single source of truth`

**Files:**
- Modify: `server/src/modules/leads/stage-gate.ts` (preflight returns union of structural + questionnaire missing items)
- Modify: `client/src/components/leads/lead-stage-change-dialog.tsx:99-127` (one missingItems source feeds both checklist and warning)
- Modify: `client/src/components/deals/stage-gate-checklist.tsx:122-159` (read from same source)
- Test: `server/tests/leads-stage-gate-union.test.ts` (new)

---

### Commit 3 — `feat(leads): timeline_status as DateField, normalize on save`

**Files:**
- Create: `client/src/components/ui/date-field.tsx` (small wrapper around `<input type="date">`, value prop YYYY-MM-DD, label/error/disabled props)
- Modify: `client/src/components/leads/lead-form.tsx` (use DateField for timeline_status node)
- Modify: `shared/src/types/lead-validation.ts` (mark timeline_status field as date input type)
- Modify: `server/src/modules/leads/service.ts` (normalize incoming timeline_status to YYYY-MM-DD or null; tolerate stale text values on read)
- Test: `server/tests/leads-timeline-status-normalize.test.ts` (new)

---

### Commit 4 — `fix(companies): verification email recipients + verification_status + approve/reject CTAs`

**Files:**
- Create: `migrations/0017_company_verification_status.sql` (idempotent: enum + column with default 'pending', backfill existing rows)
- Modify: `shared/src/schema/tenant/companies.ts` (add verification_status column)
- Modify: `server/src/modules/companies/customer-status-service.ts` (recipient query: active admin+director users; pass list to sendSystemEmail; CTA links in body)
- Modify: `server/src/modules/companies/routes.ts` (add POST /:id/verify and /:id/reject with requireRole middleware)
- Modify: `server/src/modules/leads/stage-gate.ts` (block advancement past sales-validation if linked company verification_status='pending')
- Test: `server/tests/companies-verification-flow.test.ts` (new)

---

### Commit 5 — `feat(deals): contract_signed_date + admin/director-gated edit + audit log helper`

**Files:**
- Create: `migrations/0018_deal_contract_signed_date.sql` (idempotent)
- Modify: `shared/src/schema/tenant/deals.ts` (add contractSignedDate column)
- Create: `server/src/lib/audit-log.ts` (writeAuditLog helper)
- Modify: `server/src/modules/deals/routes.ts` (PATCH gates contract_signed_date edit on requireRole(['admin','director']); writes audit log on change)
- Modify: deal card component (use DateField; readOnly={!isAdminOrDirector})
- Test: `server/tests/deals-contract-signed-date.test.ts` (new)

---

### Commit 6 — `feat(commissions): calculate commission on contract-signed transition`

**Files:**
- Create: `migrations/0019_commissions.sql` (commissions table: deal_id, rep_id, amount, rate, source_estimated_value, calculated_at, unique(deal_id, rep_id))
- Create: `shared/src/schema/tenant/commissions.ts`
- Create: `server/src/modules/commissions/service.ts` (`calculateCommissionForDeal(dealId)` — reads rep rate from userCommissionSettings, idempotency-guarded insert)
- Modify: `server/src/modules/deals/routes.ts` (in PATCH handler, after contract_signed_date null→date transition, call calculateCommissionForDeal)
- Modify: `TODO.md` (add: "Commission recalculation on contract_signed_date edit — not yet supported")
- Test: `server/tests/commissions-calculate.test.ts` (new) — covers happy path + idempotency + null→date trigger only

---

### Commit 7 — `feat(dashboard): YTD/MTD contracts-signed cards`

**Files:**
- Modify: `server/src/modules/dashboard/service.ts` (add YTD + MTD sums of estimated_value where assigned_rep_id=user AND contract_signed_date in range)
- Modify: `server/src/modules/dashboard/routes.ts` (return new fields)
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx` (render two StatCards above existing layout)
- Test: `server/tests/dashboard-rep-ytd-mtd.test.ts` (new)

---

### Commit 8 — `feat(dashboard): activity range dropdown shared with Reports`

**Files:**
- Modify: `server/src/modules/dashboard/service.ts:1139-1145` (accept `range: 'week'|'month'|'ytd'`; default 'week')
- Modify: `server/src/modules/dashboard/routes.ts` (parse range query param)
- Create: `client/src/components/dashboard/activity-range-select.tsx` (shared dropdown)
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx` (mount dropdown, wire to query)
- Modify: `client/src/pages/reports/reports-page.tsx` (mount dropdown if same metrics rendered)
- Test: `server/tests/dashboard-activity-range.test.ts` (new)

---

### Commit 9 — `feat(activities): receive Bid Board events from SyncHub`

**Files:**
- Create: `migrations/0020_activities_origin.sql` (add origin TEXT NULL + idx_activities_origin + unique(deal_id, idempotency_key) where idempotency_key is not null)
- Modify: `shared/src/schema/tenant/activities.ts` (add origin + idempotencyKey columns)
- Create: `server/src/modules/procore/synchub-activity-routes.ts` (POST /api/integrations/synchub/activities — X-SyncHub-Secret auth, schema validation, idempotency dedup)
- Modify: `server/src/modules/procore/index.ts` (mount route)
- Modify: `client/src/components/deals/deal-timeline-tab.tsx:29-35` (render "Bid Board" pill when origin='bid_board')
- Create: `docs/integrations/synchub-activity-push.md` (endpoint contract for SyncHub-side implementation)
- Test: `server/tests/synchub-activity-push.test.ts` (new) — covers auth, idempotency, origin tagging

---

## Out of scope this session

- SyncHub repo changes (separate codebase, gets its own session with dry-run + rollback discipline)
- Commission recalculation on contract_signed_date edits (TODO.md follow-up)
- Multi-office hardening from existing technical debt list

## Status

| Commit | Status |
|--------|--------|
| 0 | in progress |
| 1-9 | pending |
