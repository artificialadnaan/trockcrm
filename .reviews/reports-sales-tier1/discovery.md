# Reports Sales Tier 1 Discovery

Date: 2026-05-11
Branch: `feat/reports-sales-tier1`
Worktree: `/Users/adnaaniqbal/projects/trockcrm-reports-sales`

## Existing Report Scaffold

- `client/src/pages/reports/reports-page.tsx` renders the current 12-card catalog grouped into Sales, Performance, Operations, and Analytics. All report cards are static and show `Coming soon`.
- `client/src/hooks/use-reports.ts` already owns report request types and typed report hooks. It appends shared analytics filters as `from`, `to`, `officeId`, `regionId`, `repId`, and `source`.
- Existing report sections use executive-style panels with `PageHeader`, KPI cards, simple tables, CSV/PDF export helpers, and `brand-red`/`#CC0000` accents.
- `server/src/modules/reports/routes.ts` is the correct router for new report endpoints. It already exports authenticated report routes under `/api/reports/*`.
- `server/src/modules/reports/service.ts` is the primary report aggregation service. It already mixes Drizzle table references and raw SQL via `tenantDb.execute(sql\`...\`)`.

## Routing Pattern

- The app uses `BrowserRouter` in `client/src/main.tsx`.
- Routes are declared in `client/src/App.tsx` with `<Routes>` / `<Route>`.
- `/reports` currently maps to `<ReportsPage />`; new report pages should be added as sibling app-shell routes:
  - `/reports/sales/pipeline-velocity`
  - `/reports/sales/closed-won-revenue`
  - `/reports/sales/lead-conversion`
- Use `Link` or `useNavigate` from `react-router-dom` for clickable catalog cards.

## Chart Library

- `client/package.json` uses `recharts`.
- Existing report sections already import shared chart formatting/color helpers from `client/src/components/charts/chart-colors.ts`.

## Brand Tokens

- Tailwind config defines `brand.red` as `#CC0000`, exposed as `bg-brand-red`, `text-brand-red`, etc.
- `client/src/globals.css` defines CSS variables for primary/ring/chart colors. Primary is a red hue via OKLCH.
- Existing reporting components use both `text-brand-red` and literal `#CC0000`; new pages should prefer `brand-red` classes and a small multi-color chart palette so the reports are not one-note red.

## Table and Header Patterns

- Table primitives live in `client/src/components/ui/table.tsx`.
- Page headers use `client/src/components/layout/page-header.tsx`.
- Existing pages place `PageHeader` at the top inside a `space-y-6` page container.

## Filter Bar

- Build `client/src/components/reports/report-filter-bar.tsx`.
- Reuse:
  - `useAccessibleOffices()` from `client/src/hooks/use-accessible-offices.ts` for office options.
  - `/api/users/sales-reps` via `api("/users/sales-reps")` for active owner options.
- Persist filters in URL search params for bookmarkable report views.
- Backend query contract for the new sales reports should accept `dateFrom`, `dateTo`, `office`, and `ownerIds` as requested. The frontend may map the selected office id into `office`.

## Backend Endpoint Location

- Add routes in `server/src/modules/reports/routes.ts`:
  - `GET /api/reports/pipeline-velocity`
  - `GET /api/reports/closed-won-revenue`
  - `GET /api/reports/lead-conversion`
- Add service functions in a focused new module, `server/src/modules/reports/sales-tier1-service.ts`, to keep `service.ts` from growing further.
- Use `req.tenantDb!` so queries remain tenant-scoped to the active office schema. Office filters should constrain public user/office joins where applicable; they must not switch tenant schemas.
- Use a simple 5-minute in-memory cache keyed by report type, tenant/office context, and normalized filters.

## Data Notes

- Deals are in tenant schema `deals`; stage display labels come from public `pipeline_stage_config.name`, not slugs.
- `deals.stage_entered_at` gives current stage age; `deal_stage_history.created_at` and `duration_in_previous_stage` can support movement/aging calculations, but current executive v1 can aggregate current stage age from `stage_entered_at`.
- Won/lost terminal stages can be derived from canonical/legacy slugs already used in `service.ts`: `won`, `sent_to_production`, `service_sent_to_production`, `closed_won`; lost equivalents are `lost`, `production_lost`, `service_lost`, `closed_lost`.
- Lead conversion should use tenant `leads`, `deals.source_lead_id`, lead `status`, `converted_at`, and deal won stage/value.
