# Codex Findings Follow-up

Date: 2026-05-11
Branch: `fix/reports-operations-codex-findings`

## Findings Addressed

- P1: Removed `deals.created_at` date bounds from current active-work report queries. Active filters now remain `is_active=true`, non-terminal stage, office, and owner only.
- P1: Updated readiness stage classification to prefer stage name/slug and only use non-default proposal statuses as fallback signals.
- P2: Longest stuck KPI now uses actually stuck deal rows only and returns `0` when none are stuck.
- P2: Stages with `5+` stuck deals now uses `>= 5`.
- P2: Operations report routes now use client-side `RequireRole` guards for admin/director access.
- P2: Report filter bar refetches `/api/users/sales-reps` when office selection changes and passes `x-office-id` for scoped owner options.

## Verification

- `npx vitest run server/src/modules/reports/ client/src/pages/reports/` passed.
- `npx vitest run server/tests/modules/reports/operations-tier3-service.test.ts client/src/App.test.tsx client/src/components/reports/report-filter-bar.test.tsx` passed.
- `npm run typecheck` passed.
