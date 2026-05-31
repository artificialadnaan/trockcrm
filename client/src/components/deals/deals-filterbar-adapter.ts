import type { Deal, DealFilters } from "@/hooks/use-deals";
import type { FilterBarValue } from "@/components/filters/filterbar-params";
import type { FilterBarSortOption } from "@/components/filters/filter-bar";

/**
 * The deals-list Sort allow-list (contract §4). Shared by every deals FilterBar surface (proving
 * ground now, rep drill-down next) so sort labels/keys stay consistent and match the server's
 * buildDealListOrder allow-list. "Value" sorts the effective-value chain (BLUE's D-1 migration);
 * "Days in stage" orders by stage_entered_at (oldest entry = most days).
 */
export const DEAL_LIST_SORT_OPTIONS: FilterBarSortOption[] = [
  { label: "Newest", sortBy: "created_at", sortDir: "desc" },
  { label: "Oldest", sortBy: "created_at", sortDir: "asc" },
  { label: "Recently updated", sortBy: "updated_at", sortDir: "desc" },
  { label: "Value (high → low)", sortBy: "awarded_amount", sortDir: "desc" },
  { label: "Days in stage", sortBy: "stage_entered_at", sortDir: "asc" },
];

/**
 * Map a FilterBar URL value into the DealFilters shape useDeals/getDeals consume.
 *  - emits the contract param names (#546) verbatim;
 *  - drops the client-only `datePreset` (the server reads only dateFrom/dateTo);
 *  - omits `page` — the list section owns pagination + limit, not the filter map;
 *  - omits the "any" status (the no-filter state) and never emits the legacy `isActive`
 *    (Status owns is_active/on_hold per contract §5);
 *  - forwards the `__unassigned__` sentinel verbatim (backend maps it to IS NULL).
 * Only defined dimensions are included, so an absent key means "no filter".
 */
export function filterBarValueToDealFilters(value: FilterBarValue): Partial<DealFilters> {
  const filters: Partial<DealFilters> = {};
  if (value.search) filters.search = value.search;
  if (value.stageIds && value.stageIds.length > 0) filters.stageIds = value.stageIds;
  if (value.assignedRepId) filters.assignedRepId = value.assignedRepId;
  if (value.regionId) filters.regionId = value.regionId;
  if (value.projectTypeId) filters.projectTypeId = value.projectTypeId;
  if (value.workflowRoute) filters.workflowRoute = value.workflowRoute;
  if (value.status && value.status !== "any") filters.status = value.status;
  if (value.valueMin !== undefined) filters.valueMin = value.valueMin;
  if (value.valueMax !== undefined) filters.valueMax = value.valueMax;
  if (value.minAgeDays !== undefined) filters.minAgeDays = value.minAgeDays;
  if (value.maxAgeDays !== undefined) filters.maxAgeDays = value.maxAgeDays;
  if (value.dateFrom) filters.dateFrom = value.dateFrom;
  if (value.dateTo) filters.dateTo = value.dateTo;
  if (value.sortBy) filters.sortBy = value.sortBy;
  if (value.sortDir) filters.sortDir = value.sortDir;
  if (value.scope) filters.scope = value.scope;
  return filters;
}

/**
 * The date a deal row should DISPLAY. Prefers the server's outcome-aware `displayDate`
 * (Won->signed, Lost->lost, open->stage-entry by row outcome — P0's dealDisplayDateExpr) so the
 * date shown matches the date filtered on (filter-axis == display-axis). Falls back to the legacy
 * close-date chain (actual, then expected) until the backend SELECTs `displayDate`.
 */
export function getDealDisplayDate(
  deal: Partial<Pick<Deal, "displayDate" | "actualCloseDate" | "expectedCloseDate">>
): string | null {
  return deal.displayDate ?? deal.actualCloseDate ?? deal.expectedCloseDate ?? null;
}
