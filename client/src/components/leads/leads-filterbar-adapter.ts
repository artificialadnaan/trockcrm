import type { LeadFilters, LeadRecord } from "@/hooks/use-leads";
import { UNASSIGNED, type FilterBarValue } from "@/components/filters/filterbar-params";
import type { FilterBarSortOption } from "@/components/filters/filter-bar";
import type { FilterSelectOption } from "@/components/filters/filter-select";

/**
 * The leads FilterBar adapter (Wave 1) — the leads analog of deals-filterbar-adapter. Maps the shared
 * FilterBar URL value into LeadFilters, with the LEAD variants: status open|converted|disqualified,
 * the outcome-aware date window (BLUE's lead-date-scope), and the lead sort keys. Deal-only dimensions
 * (value/workflow/region/age) have no LeadFilters field, so they're dropped by construction.
 * See .audit/filterbar-leads-date-scope-contract.md.
 */

/** Opt-in Status option set for the leads FilterBar mount (overrides the deal-status default). */
export const LEAD_STATUS_OPTIONS: FilterSelectOption[] = [
  { value: "open", label: "Open" },
  { value: "converted", label: "Converted" },
  { value: "disqualified", label: "Disqualified" },
];

/** Lead sort allow-list — matches LeadFilters.sortBy (the server's lead sort keys). */
export const LEAD_LIST_SORT_OPTIONS: FilterBarSortOption[] = [
  { label: "Newest", sortBy: "created_at", sortDir: "desc" },
  { label: "Oldest", sortBy: "created_at", sortDir: "asc" },
  { label: "Recently updated", sortBy: "updated_at", sortDir: "desc" },
];

export function filterBarValueToLeadFilters(value: FilterBarValue): Partial<LeadFilters> {
  const filters: Partial<LeadFilters> = {};
  if (value.search) filters.search = value.search;
  if (value.stageIds && value.stageIds.length > 0) filters.stageIds = value.stageIds;
  // Leads.assignedRepId is a non-null UUID — there is no "unassigned" lead bucket and the backend
  // compares the value directly, so the __unassigned__ sentinel would error/no-match. Drop it (Codex
  // #577 P1); the Unassigned OPTION is also suppressed for the leads Rep control via allowUnassigned.
  if (value.assignedRepId && value.assignedRepId !== UNASSIGNED) filters.assignedRepId = value.assignedRepId;
  if (value.projectTypeId) filters.projectTypeId = value.projectTypeId;
  // Narrow to LEAD statuses so a stray deal status (active/on_hold/inactive) can't become an invalid
  // lead filter. The union check also narrows the type for assignment (no cast).
  if (value.status === "open" || value.status === "converted" || value.status === "disqualified") {
    filters.status = value.status;
  }
  if (value.dateFrom) filters.dateFrom = value.dateFrom;
  if (value.dateTo) filters.dateTo = value.dateTo;
  // Narrow to the lead sort keys; sortDir only rides along with a valid lead sortBy (no orphan dir).
  if (value.sortBy === "created_at" || value.sortBy === "updated_at") {
    filters.sortBy = value.sortBy;
    if (value.sortDir) filters.sortDir = value.sortDir;
  }
  if (value.scope) filters.scope = value.scope;
  return filters;
}

/**
 * The date a lead row should DISPLAY. Prefers the server's outcome-aware `displayDate`
 * (converted→converted_at, open→stage-entry, disqualified→disqualified-entry — BLUE's
 * lead-date-scope), so the date shown matches the date filtered on (filter-axis == display-axis).
 * Falls back to the lead date chain (converted, then stage-entry, then created) until the backend
 * SELECTs `displayDate`.
 */
export function getLeadDisplayDate(
  lead: Partial<Pick<LeadRecord, "displayDate" | "convertedAt" | "stageEnteredAt" | "createdAt">>
): string | null {
  return lead.displayDate ?? lead.convertedAt ?? lead.stageEnteredAt ?? lead.createdAt ?? null;
}
