import type {
  Company,
  CompanyFilters,
  CompanyListSortKey,
  CompanyVerificationStatus,
} from "@/hooks/use-companies";
import type { FilterBarValue } from "@/components/filters/filterbar-params";
import type { FilterBarSortOption } from "@/components/filters/filter-bar";
import type { FilterSelectOption } from "@/components/filters/filter-select";

/**
 * Companies FilterBar adapter (Wave 2) — the companies analog of `deals-filterbar-adapter.ts` and the
 * RED⇄BLUE seam written up in `.audit/filterbar-companies-scope-contract.md`. Maps the shared
 * FilterBarValue (URL state) into the params `GET /api/companies` consumes (`CompanyFilters`), and picks
 * the date a row should display. Consumed by the companies list mount; the filter-param TYPES live on
 * `useCompanies` (the hook owns them), this module owns the URL→params mapping + the option lists.
 *
 * The runtime predicates are GATED on BLUE's server params — `buildCompanyDateScope` +
 * `companyDisplayDateExpr`, the sort allow-list, the owner-by-id route param + `owner_id IS NULL`
 * branch, and the `status` -> `company_verification_status` filter. The frontend forwards the params
 * verbatim; until BLUE lands, the server safely ignores the ones it does not yet handle (filters no-op).
 */

/** Status options the mount passes as the FilterBar's opt-in `statusOptions` (the 4 verification
 *  values; `Company.companyVerificationStatus` omits `rejected`, but the reject flow writes it and the
 *  server filters the full DB enum — contract round 2). */
export const COMPANY_VERIFICATION_STATUS_OPTIONS: FilterSelectOption[] = [
  { value: "pending", label: "Pending" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "not_required", label: "Not required" },
];

const VERIFICATION_STATUS_VALUES: readonly string[] = COMPANY_VERIFICATION_STATUS_OPTIONS.map((o) => o.value);

function isVerificationStatus(value: string): value is CompanyVerificationStatus {
  return VERIFICATION_STATUS_VALUES.includes(value);
}

const COMPANY_SORT_KEYS: readonly string[] = ["last_activity_at", "created_at", "name"];

function isCompanySortKey(value: string): value is CompanyListSortKey {
  return COMPANY_SORT_KEYS.includes(value);
}

/**
 * Companies-list Sort allow-list (contract §sort). Keys MUST match BLUE's server `buildCompanyListOrder`
 * allow-list (the server hardcodes `name ASC` today). "Recently active" sorts the SAME
 * `COALESCE(last_activity_at, created_at)` axis the list's Date column shows — filter-axis ==
 * display-axis == sort-axis.
 */
export const COMPANY_LIST_SORT_OPTIONS: FilterBarSortOption[] = [
  { label: "Recently active", sortBy: "last_activity_at", sortDir: "desc" },
  { label: "Least recently active", sortBy: "last_activity_at", sortDir: "asc" },
  { label: "Newest", sortBy: "created_at", sortDir: "desc" },
  { label: "Oldest", sortBy: "created_at", sortDir: "asc" },
  { label: "Name (A → Z)", sortBy: "name", sortDir: "asc" },
];

/**
 * Map a FilterBar URL value into the params `GET /api/companies` consumes (`Partial<CompanyFilters>`).
 *  - emits the contract param names verbatim;
 *  - `scope` -> `ownerScope`: ONLY "mine" maps (the companies endpoint has no team scope; "all"/unset
 *    omit). The page's mine/all toggle is inherited via the URL `scope`, NOT a bar dimension (contract);
 *  - `status` -> `status` (verification): emitted under the CONTRACTED `status` param (the same multi-
 *    domain `status` query param / FilterBar dimension the deals lifecycle status uses — companies
 *    interpret it as `company_verification_status`, contract lines 40/80), validated against the
 *    verification allow-list; "any"/unrecognized omit (never widen);
 *  - forwards `assignedRepId` (owner) verbatim incl. the `__unassigned__` sentinel (BLUE -> IS NULL);
 *  - validates `sortBy` against the company allow-list, dropping a stale deal sortBy (e.g. left in the
 *    URL when navigating between surfaces); `sortDir` rides with a valid `sortBy`;
 *  - drops the deal-only dimensions by construction (no CompanyFilters field) and the client-only
 *    `datePreset`; omits `page` (the list section owns pagination + limit, not the filter map).
 * Only defined dimensions are included, so an absent key means "no filter".
 */
export function filterBarValueToCompanyFilters(value: FilterBarValue): Partial<CompanyFilters> {
  const filters: Partial<CompanyFilters> = {};
  if (value.search) filters.search = value.search;
  if (value.assignedRepId) filters.assignedRepId = value.assignedRepId;
  if (value.dateFrom) filters.dateFrom = value.dateFrom;
  if (value.dateTo) filters.dateTo = value.dateTo;
  if (value.sortBy && isCompanySortKey(value.sortBy)) {
    filters.sortBy = value.sortBy;
    if (value.sortDir) filters.sortDir = value.sortDir;
  }
  // The page's mine/all toggle is inherited via the URL `scope` (not a bar dimension); only "mine" is
  // meaningful to the companies endpoint, which reads `ownerScope` (not `scope`).
  if (value.scope === "mine") filters.ownerScope = "mine";

  // The shared `status` is a multi-domain free string; validate against the verification allow-list so a
  // deal status / unknown value (e.g. left in the URL when navigating between surfaces) never widens.
  if (value.status && value.status !== "any" && isVerificationStatus(value.status)) {
    filters.status = value.status;
  }
  return filters;
}

/**
 * The date a company row should DISPLAY. Prefers the server's `displayDate` (BLUE's
 * `companyDisplayDateExpr` = `COALESCE(last_activity_at, created_at)::date`) so the date shown matches
 * the date filtered on (filter-axis == display-axis). Falls back to `lastActivityAt`, then `createdAt`,
 * until the backend SELECTs `displayDate`.
 */
export function getCompanyDisplayDate(
  company: Partial<Pick<Company, "lastActivityAt" | "createdAt">> & { displayDate?: string | null }
): string | null {
  return company.displayDate ?? company.lastActivityAt ?? company.createdAt ?? null;
}
