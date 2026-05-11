# Operations Reports Tier 3 Discovery

Date: 2026-05-11
Branch: `feat/reports-operations-tier3`
Worktree: `/Users/adnaaniqbal/projects/trockcrm-reports-operations`

## Scaffold Read

- `client/src/pages/reports/reports-page.tsx` has the Operations category and the three target cards already present with `CalendarClock`, `ClipboardList`, and `BriefcaseBusiness`.
- `client/src/App.tsx` has the existing `/reports` route only. Tier 3 should append the three Operations routes.
- `server/src/modules/reports/routes.ts` owns report endpoints. Tier 3 should append the three Operations endpoints and import from a dedicated service file.
- `server/src/modules/reports/service.ts` shows the current Drizzle/SQL reporting pattern and the `tenantDb.execute(sql...)` approach.
- `client/src/hooks/use-reports.ts` owns report client fetch helpers and stateful hooks.

## Filter Bar Plan

- Main does not currently have `client/src/components/reports/report-filter-bar.tsx`.
- Tier 1 Sales worktree has a filter bar at `/Users/adnaaniqbal/projects/trockcrm-reports-sales/client/src/components/reports/report-filter-bar.tsx`.
- Tier 3 will add a local copy with the same public shape: `ReportFilters`, `useReportFilters`, and `ReportFilterBar`.
- If Tier 1 or Tier 2 merges first, this local copy should be deduplicated during conflict resolution and imports should use the merged shared component.

## Backend Service File

- New file: `server/src/modules/reports/operations-tier3-service.ts`
- Endpoints:
  - `GET /api/reports/workflow-bottlenecks`
  - `GET /api/reports/project-readiness`
  - `GET /api/reports/portfolio-load`
- Accepted filters: `dateFrom`, `dateTo`, `office`, `ownerIds`
- Service cache: 5 minutes, with a route-supplied cache scope to avoid cross-tenant reuse.

## Data Sources

### Workflow Bottlenecks

- Tenant `deals`: active deals, `stage_id`, `stage_entered_at`, `last_activity_at`, `assigned_rep_id`, deal value fields, `project_number`.
- Public `pipeline_stage_config`: stage display name, display order, terminal flag.
- Public `users`: owner display names.
- Exclude terminal stages via `pipeline_stage_config.is_terminal = false` and active deals via `deals.is_active = true`.

### Project Readiness

- Tenant `deals`: stage, `proposal_status`, `proposal_sent_at`, `proposal_accepted_at`, `contract_signed_date`, `contract_signed_at`, `assigned_rep_id`, stage age.
- Tenant `deal_scoping_intake`: `status`, `completion_state`, `readiness_errors`, `first_ready_at`, `activated_at`.
- Public `pipeline_stage_config`: stage display names.
- Public `users`: owner display names.

Readiness is only partially modeled. Scoping has structured completion JSON; estimating/contract readiness can use proposal and contract fields. Kickoff readiness does not appear to have a dedicated checklist table in the inspected schema, so v1 uses stage-age and assignment proxies plus contract/proposal state where available.

### Portfolio Load

- Tenant `deals`: active work, company/property IDs, active values, owner, office, stage age, project number, city/state fallback fields.
- Tenant `companies`: company display name, city/state/region, last activity.
- Tenant `properties`: property display name, company, city/state, last activity.
- Public `users`: owner display names.

## Gaps / Assumptions

- No dedicated kickoff checklist table was found in the inspected schema. The kickoff section will be labeled as a v1 readiness proxy.
- No raw stage slugs or user/company/property UUIDs should be rendered as visible text in the UI. IDs may still be used in links.
- Office filtering uses `deals.office_code` because tenant deals carry office code text rather than a tenant `office_id` column.
