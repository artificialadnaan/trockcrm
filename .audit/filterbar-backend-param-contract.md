# Shared FilterBar — Backend Param Contract (BLUE owns server; RED owns frontend)

Status: CONTRACT. The frontend dropdowns MUST emit these exact param names/values
so they connect to the backend predicates. Derived from
.audit/shared-filterbar-design.md (§2 catalog, §7.3 URL mapping) + the resolved
open decisions. Backend implementation: server/src/modules/deals/deal-filter-predicates.ts
+ server/src/modules/shared/deal-date-scope.ts, wired into getDeals.

## Query params consumed by GET /api/deals (the deals list)

| Param          | Type / values                         | Backend predicate / behavior                                   |
|----------------|---------------------------------------|----------------------------------------------------------------|
| assignedRepId  | uuid \| `__unassigned__`              | eq(assigned_rep_id); sentinel -> IS NULL                       |
| regionId       | uuid \| `__unassigned__`              | eq(region_id); sentinel -> IS NULL                             |
| projectTypeId  | uuid                                  | eq(project_type_id)                                            |
| workflowRoute  | `normal` \| `service`                 | eq(workflow_route) — stored verbatim, NO mapping               |
| status         | `active`\|`on_hold`\|`inactive`\|`any`| active = is_active=true AND on_hold=false; on_hold = on_hold true; inactive = is_active=false; any/unset = omitted |
| valueMin       | number (dollars)                      | effective-value chain >= min (on-hold-zeroed best estimate)    |
| valueMax       | number (dollars)                      | effective-value chain <= max                                   |
| minAgeDays     | number                                | days-in-stage >= n — GATED on FEATURE_STAGE_ENTRY_DATE         |
| maxAgeDays     | number                                | days-in-stage <= n — GATED on FEATURE_STAGE_ENTRY_DATE         |
| date_from      | YYYY-MM-DD (also accepts dateFrom)    | outcome-aware window lower bound (inclusive)                   |
| date_to        | YYYY-MM-DD (also accepts dateTo)      | outcome-aware window upper bound (exclusive next-day)          |

Already-existing params the FilterBar reuses unchanged: `search`, `stageIds`
(comma-joined), `source`, `scope` (mine|team|all), `sortBy`/`sortDir`,
`page`/`limit`, `isActive`. NOTE: when `status` is sent, the backend ignores the
legacy `isActive` param (Status owns is_active/on_hold) — send one or the other.

## The Unassigned sentinel

`UNASSIGNED_FILTER_SENTINEL = "__unassigned__"` (exported from
deal-filter-predicates.ts). The frontend's "Unassigned" option for Rep and Region
must emit this exact string as the param value. Backend maps it to `IS NULL`;
eq() on it would match nothing.

## Workflow value (resolved)

Design §3.1 wrote `normal | service`; the DB enum (`WORKFLOW_ROUTES`) is exactly
`["normal","service"]`, so RED emits `normal`/`service` and the backend uses it
directly — no translation layer.

## Stalled + open-stage date are flag-gated (resolved)

Both `minAgeDays`/`maxAgeDays` (stalled) and the OPEN-stage branch of the date
window depend on `stage_entered_at`, reliable only post-#535. They are gated on
`ENABLE_STAGE_ENTRY_DATE_FILTER`:
- Flag OFF: backend ignores stalled params; the date window applies to Won/Lost
  rows only (open rows pass through as current-state, never silently dropped).
  RED should HIDE the Stalled dropdown and label the date control honestly.
- Flag ON: stalled applies; open rows are bounded by their stage-entry date.

## The date model is outcome-aware (canonical, platform-wide)

One `date_from`/`date_to` window, three axes by row outcome:
- Won rows  -> won/signed date (COALESCE(contract_signed_at::date, contract_signed_date))
- Lost rows -> lost_at date
- Open rows -> stage_entry date (flag-gated)

filter axis == display axis. This lives in the SHARED module
`server/src/modules/shared/deal-date-scope.ts` (`buildDealOutcomeDateScope`) so
the other list surfaces (rep drill-down, board, reports) adopt the same function
in the upcoming platform-wide date-filter audit — it is intentionally NOT a
getDeals-private helper.

## Graceful-empty guarantee

Every predicate returns `undefined` when its param is unset (omitted, never a
broken/empty SQL). Sparse FK dimensions (region/rep) are safe: an unset filter
omits, a no-match value returns an empty set, and an empty Won/Lost stage-id set
in the date predicate degrades to a `false` sentinel (never `IN ()`).

## Won basis untouched

These are READ-path list predicates only. The Won total (191 / $9,778,045.90)
lives in dashboard `getWonCloseSummary` / reports, which this change does not
touch — verified: no diff to server/src/modules/dashboard, server/src/modules/reports,
or shared/deal-value-sql.ts.
