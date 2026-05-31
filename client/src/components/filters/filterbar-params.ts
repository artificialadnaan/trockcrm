// FilterBar value <-> URL query serde. Param names/values match BLUE's backend contract (PR #546)
// EXACTLY so the deals list emits what getDeals consumes. The URL is the source of truth (Slice 7).

import { withResolvedDateWindow } from "./filterbar-date";

export const UNASSIGNED = "__unassigned__";
export type DealStatusFilter = "active" | "on_hold" | "inactive" | "any";

export interface FilterBarValue {
  search?: string;
  stageIds?: string[];
  assignedRepId?: string; // uuid | "__unassigned__"
  regionId?: string; // uuid | "__unassigned__"
  projectTypeId?: string;
  workflowRoute?: "normal" | "service";
  /** Domain status, surface-specific (deals: active|on_hold|inactive; leads: open|converted|disqualified).
   *  The bar is multi-domain now, so this is a free string validated by each surface's adapter; "any"/
   *  unset is the omitted/default state. */
  status?: string;
  valueMin?: number;
  valueMax?: number;
  minAgeDays?: number;
  maxAgeDays?: number;
  dateFrom?: string;
  dateTo?: string;
  /** Client-only: kept in the URL so the date control can re-derive its chip; the server only
   *  reads dateFrom/dateTo. */
  datePreset?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  scope?: "mine" | "team" | "all";
  page?: number;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** FilterBar value -> URL query record. Omits undefined / empty / default values so absent params
 *  mean "no filter" (matches the contract's __all__/absent -> omit rule). */
export function serializeFilters(value: FilterBarValue): Record<string, string> {
  const out: Record<string, string> = {};

  if (value.search && value.search.trim()) out.search = value.search.trim();
  if (value.stageIds && value.stageIds.length > 0) out.stageIds = value.stageIds.join(",");
  if (value.assignedRepId) out.assignedRepId = value.assignedRepId;
  if (value.regionId) out.regionId = value.regionId;
  if (value.projectTypeId) out.projectTypeId = value.projectTypeId;
  if (value.workflowRoute) out.workflowRoute = value.workflowRoute;
  if (value.status && value.status !== "any") out.status = value.status;
  if (isFiniteNumber(value.valueMin)) out.valueMin = String(value.valueMin);
  if (isFiniteNumber(value.valueMax)) out.valueMax = String(value.valueMax);
  if (isFiniteNumber(value.minAgeDays)) out.minAgeDays = String(value.minAgeDays);
  if (isFiniteNumber(value.maxAgeDays)) out.maxAgeDays = String(value.maxAgeDays);
  if (value.dateFrom) out.dateFrom = value.dateFrom;
  if (value.dateTo) out.dateTo = value.dateTo;
  if (value.datePreset) out.datePreset = value.datePreset;
  if (value.sortBy) out.sortBy = value.sortBy;
  if (value.sortDir) out.sortDir = value.sortDir;
  if (value.scope) out.scope = value.scope;
  if (isFiniteNumber(value.page) && value.page > 1) out.page = String(value.page);

  return out;
}

/** The URL params the FilterBar owns. mergeFilterParams clears these before re-setting, so
 *  non-FilterBar params on the same URL (dashboard filter/period, tab, etc.) are preserved. */
const FILTERBAR_PARAM_KEYS = [
  "search",
  "stageIds",
  "assignedRepId",
  "regionId",
  "projectTypeId",
  "workflowRoute",
  "status",
  "valueMin",
  "valueMax",
  "minAgeDays",
  "maxAgeDays",
  "dateFrom",
  "dateTo",
  "datePreset",
  "sortBy",
  "sortDir",
  "scope",
  "page",
] as const;

/** Apply a partial patch to the FilterBar params on a URL, preserving any non-FilterBar params.
 *  Page-resets to 1 (omitted) on any change that doesn't explicitly set `page` (mirrors
 *  useContactFilters). Returns a new URLSearchParams. */
export function mergeFilterParams(
  prev: URLSearchParams,
  patch: Partial<FilterBarValue>,
  now = new Date()
): URLSearchParams {
  // Re-resolve the existing params' NAMED date preset before merging, so a relative preset's stale
  // bounds (from a bookmarked/shared URL saved earlier) self-heal to today's window on ANY edit —
  // instead of being re-serialized stale on an unrelated change like typing in Search (Codex). The
  // patch still wins (a date-control change overrides); custom/unknown presets keep their bounds.
  const next: FilterBarValue = { ...withResolvedDateWindow(deserializeFilters(prev), now), ...patch };
  if (patch.page === undefined) delete next.page;
  const fbParams = serializeFilters(next);
  const result = new URLSearchParams(prev);
  for (const key of FILTERBAR_PARAM_KEYS) result.delete(key);
  for (const [key, val] of Object.entries(fbParams)) result.set(key, val);
  return result;
}

/** Remove all FilterBar params (reset), preserving non-FilterBar params. `preserveKeys` keeps the
 *  listed FilterBar params too — used when a surface inherits a param it does not render as a
 *  dimension (e.g. the deals-list-under-kanban inherits the board-owned `scope`, so Clear must not
 *  reset the whole pipeline). */
export function clearFilterParams(prev: URLSearchParams, preserveKeys: readonly string[] = []): URLSearchParams {
  const result = new URLSearchParams(prev);
  for (const key of FILTERBAR_PARAM_KEYS) {
    if (preserveKeys.includes(key)) continue;
    result.delete(key);
  }
  return result;
}

function parseNumberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** URL query -> FilterBar value. Inverse of serializeFilters (modulo omitted defaults). */
export function deserializeFilters(params: URLSearchParams): FilterBarValue {
  const value: FilterBarValue = {};

  const search = params.get("search");
  if (search) value.search = search;

  const stageIds = params.get("stageIds");
  if (stageIds) {
    const ids = stageIds.split(",").filter(Boolean);
    if (ids.length > 0) value.stageIds = ids;
  }

  const assignedRepId = params.get("assignedRepId");
  if (assignedRepId) value.assignedRepId = assignedRepId;
  const regionId = params.get("regionId");
  if (regionId) value.regionId = regionId;
  const projectTypeId = params.get("projectTypeId");
  if (projectTypeId) value.projectTypeId = projectTypeId;

  const workflowRoute = params.get("workflowRoute");
  if (workflowRoute === "normal" || workflowRoute === "service") value.workflowRoute = workflowRoute;

  const status = params.get("status");
  // Multi-domain status: accept any value verbatim (deal or lead status); the per-surface adapter
  // validates it. "any"/blank is the omitted/default state, so it does not deserialize to a value
  // (keeps serialize/deserialize symmetric and the value object canonical).
  if (status && status !== "any") {
    value.status = status;
  }

  const valueMin = parseNumberParam(params.get("valueMin"));
  if (valueMin !== undefined) value.valueMin = valueMin;
  const valueMax = parseNumberParam(params.get("valueMax"));
  if (valueMax !== undefined) value.valueMax = valueMax;
  const minAgeDays = parseNumberParam(params.get("minAgeDays"));
  if (minAgeDays !== undefined) value.minAgeDays = minAgeDays;
  const maxAgeDays = parseNumberParam(params.get("maxAgeDays"));
  if (maxAgeDays !== undefined) value.maxAgeDays = maxAgeDays;

  const dateFrom = params.get("dateFrom");
  if (dateFrom) value.dateFrom = dateFrom;
  const dateTo = params.get("dateTo");
  if (dateTo) value.dateTo = dateTo;
  const datePreset = params.get("datePreset");
  if (datePreset) value.datePreset = datePreset;

  const sortBy = params.get("sortBy");
  if (sortBy) value.sortBy = sortBy;
  const sortDir = params.get("sortDir");
  if (sortDir === "asc" || sortDir === "desc") value.sortDir = sortDir;

  const scope = params.get("scope");
  if (scope === "mine" || scope === "team" || scope === "all") value.scope = scope;

  const page = parseNumberParam(params.get("page"));
  if (page !== undefined && page > 1) value.page = page;

  return value;
}
