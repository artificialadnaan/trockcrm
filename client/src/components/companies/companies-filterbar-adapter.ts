import type { Company, CompanyFilters } from "@/hooks/use-companies";
import type { FilterBarValue } from "@/components/filters/filterbar-params";
import type { FilterBarSortOption } from "@/components/filters/filter-bar";
import type { FilterSelectOption } from "@/components/filters/filter-select";

/**
 * Companies FilterBar adapter (Wave 2) — the companies analog of `deals-filterbar-adapter.ts` and the
 * RED⇄BLUE seam written up in `.audit/filterbar-companies-scope-contract.md`. PURE LOGIC ONLY: it maps
 * the shared FilterBarValue (URL state) into the params `GET /api/companies` consumes, and picks the
 * date a row should display. It is imported by NOTHING but its test until the mount lands, so it changes
 * no runtime behavior on its own.
 *
 * The mount (useFilterState + <FilterBar> in the companies list page) is GATED on:
 *   1. RED's extracted FilterBar primitives on main — `paramPrefix`, opt-in `statusOptions`,
 *      `allowUnassigned`, and a configurable Owner label (`repLabel`) on the `rep` dimension; and
 *   2. BLUE's server params — `buildCompanyDateScope` + `companyDisplayDateExpr`, the sort allow-list,
 *      the owner-by-id route param + `owner_id IS NULL` branch, and the verification-status filter.
 * Until both land, this module is the ready-to-wire logic.
 */

/**
 * Company verification statuses — the DB enum IN FULL. The reject flow writes `rejected`, so the filter
 * must offer all four (contract round 2). NOTE: the client `Company.companyVerificationStatus` union
 * currently OMITS `rejected` — a separate surface fix (the DB enum has it); this adapter's type is the
 * source of truth for the FILTER param.
 */
export type CompanyVerificationStatus = "pending" | "verified" | "rejected" | "not_required";

/** Status options the mount passes as the FilterBar's opt-in `statusOptions` (RED dependency). */
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

/** The companies sort allow-list keys — MUST match BLUE's server allow-list. */
export type CompanyListSortKey = "last_activity_at" | "created_at" | "name";

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
 * The params the companies FilterBar emits — a superset of today's `CompanyFilters` with the contract's
 * BLUE-owned additions. The mount folds these into `useCompanies` once BLUE accepts them (today the hook
 * forwards only search/category/industry/ownerScope/page/limit, so the new fields stay dormant until the
 * mount + BLUE land).
 */
export interface CompanyListFilters extends CompanyFilters {
  /** owner_id eq, or the `__unassigned__` sentinel BLUE maps to `owner_id IS NULL`. */
  assignedRepId?: string;
  /** `company_verification_status` filter (BLUE). */
  verificationStatus?: CompanyVerificationStatus;
  /** `COALESCE(last_activity_at, created_at)` window (BLUE). */
  dateFrom?: string;
  dateTo?: string;
  /** Sort allow-list `last_activity_at | created_at | name` (BLUE). */
  sortBy?: CompanyListSortKey;
  sortDir?: "asc" | "desc";
}

/**
 * Map a FilterBar URL value into the params `GET /api/companies` consumes (CompanyListFilters).
 *  - emits the contract param names verbatim;
 *  - `scope` -> `ownerScope`: ONLY "mine" maps (the companies endpoint has no team scope; "all"/unset
 *    omit). The page's mine/all toggle is inherited via the URL `scope`, NOT a bar dimension (contract);
 *  - `status` -> `verificationStatus`: validated against the verification allow-list; "any"/unrecognized
 *    omit (never widen). On main `FilterBarValue.status` is still the deal-status union — RED's #577
 *    widens the shared `status` param to a multi-domain free string, at which point the cast is a no-op;
 *  - forwards `assignedRepId` (owner) verbatim incl. the `__unassigned__` sentinel (BLUE -> IS NULL);
 *  - validates `sortBy` against the company allow-list, dropping a stale deal sortBy (e.g. left in the
 *    URL when navigating between surfaces); `sortDir` rides with a valid `sortBy`;
 *  - drops the deal-only dimensions by construction (no CompanyListFilters field) and the client-only
 *    `datePreset`; omits `page` (the list section owns pagination + limit, not the filter map).
 * Only defined dimensions are included, so an absent key means "no filter".
 */
export function filterBarValueToCompanyFilters(value: FilterBarValue): Partial<CompanyListFilters> {
  const filters: Partial<CompanyListFilters> = {};
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

  // `value.status` is the deal-status union on main; RED's multi-domain `status` widens it to a free
  // string — this cast becomes a no-op then. Validated so a deal status / unknown value never widens.
  const rawStatus = value.status as string | undefined;
  if (rawStatus && rawStatus !== "any" && isVerificationStatus(rawStatus)) {
    filters.verificationStatus = rawStatus;
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
