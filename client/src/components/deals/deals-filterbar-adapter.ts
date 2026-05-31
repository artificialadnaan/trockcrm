import type { Deal, DealFilters } from "@/hooks/use-deals";
import type { FilterBarValue } from "@/components/filters/filterbar-params";
import type { FilterBarOptions, FilterBarSortOption, FilterDimension } from "@/components/filters/filter-bar";

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
 * URL param namespace for the shared FilterBar when it mounts on a surface that already owns URL state
 * — the director/stage drill-downs (/deals/stages/<id>) and the /deals dashboard drill-downs (Won /
 * Active / At-risk). Those surfaces carry BARE params (scope, period, filter, page, assignedRepId);
 * the bar serializes its keys as `${prefix}${key}` (fb_stageIds, fb_dateFrom, fb_page, …) so the two
 * URL spaces stay disjoint and toggling a bar control can't clobber the host's scope / period / page.
 * Threaded into useFilterState(prefix) at the mount — gated on the #577 namespace primitive landing on main.
 */
export const DRILLDOWN_FILTERBAR_PARAM_PREFIX = "fb_";

/** Canonical render order for the deals FilterBar dimensions (the pipeline list's row). Per-surface
 *  sets are this order, filtered — never re-sorted — so every deals bar reads left-to-right the same. */
const DRILLDOWN_DIMENSION_ORDER: FilterDimension[] = [
  "search",
  "date",
  "stage",
  "sort",
  "rep",
  "status",
  "workflow",
  "region",
  "projectType",
  "value",
  "stalled",
];

/**
 * The FilterBar dimensions for a director/stage drill-down mount. Starts from the canonical deals row
 * and drops what the host surface already owns:
 *  - `scope` is never a drill-down bar dimension — every drill-down keeps its own scope toggle
 *    (mine / all), so it is absent from DRILLDOWN_DIMENSION_ORDER entirely;
 *  - `rep` appears only when the bar OWNS rep (`ownRep`) — the /deals/stages/<id> page folds its
 *    bespoke admin rep select into the bar; the /deals dashboard drill-downs keep their page-level rep
 *    select (it filters the board AND the embedded list together), so the bar omits rep there;
 *  - `stage` is dropped when the surface PINS a single stage (`pinnedStage`) — the stage drill-down's
 *    route already fixes the stage, so a stage multi-select would let the user escape the route's stage.
 */
export function getDrilldownFilterBarDimensions(
  opts: { pinnedStage?: boolean; ownRep?: boolean } = {}
): FilterDimension[] {
  return DRILLDOWN_DIMENSION_ORDER.filter((dimension) => {
    if (dimension === "rep") return opts.ownRep === true;
    if (dimension === "stage") return opts.pinnedStage !== true;
    return true;
  });
}

/** Which FilterBarValue keys each dimension owns. Used to drop URL params for dimensions a mount does
 *  not render, so a stray prefixed key (e.g. fb_stageIds on a stage-pinned mount, or fb_assignedRepId
 *  where Rep is hidden) can't override a pinned/host-owned filter with no visible control to clear it. */
const DIMENSION_VALUE_KEYS: Record<FilterDimension, ReadonlyArray<keyof FilterBarValue>> = {
  search: ["search"],
  scope: ["scope"],
  date: ["dateFrom", "dateTo", "datePreset"],
  stage: ["stageIds"],
  sort: ["sortBy", "sortDir"],
  rep: ["assignedRepId"],
  status: ["status"],
  workflow: ["workflowRoute"],
  region: ["regionId"],
  projectType: ["projectTypeId"],
  value: ["valueMin", "valueMax"],
  stalled: ["minAgeDays", "maxAgeDays"],
};

/**
 * Narrow a deserialized FilterBar URL value to only the keys owned by the dimensions a mount actually
 * renders. Params for hidden dimensions are dropped, so they can't silently override a pinned filter
 * (Codex P2) — the bar applies only what it visibly exposes a control for.
 */
export function pickFilterBarValueForDimensions(
  value: FilterBarValue,
  dimensions: ReadonlyArray<FilterDimension>
): FilterBarValue {
  const allowed = new Set<string>();
  for (const dimension of dimensions) {
    for (const key of DIMENSION_VALUE_KEYS[dimension]) allowed.add(key);
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => allowed.has(key))
  ) as FilterBarValue;
}

/** The shared-FilterBar config a drill-down list mount feeds to `<DealsListSection filterBar={…}>`.
 *  Superset (all required) of the optional `filterBar` prop, so it is assignable verbatim. */
export interface DrilldownListFilterBar {
  dimensions: FilterDimension[];
  options: FilterBarOptions;
  stageEntryDateEnabled: boolean;
  defaultStageIds: string[];
  terminalStageIds: string[];
  paramPrefix: string;
}

/**
 * Build the FilterBar config for a /deals dashboard drill-down's embedded list (Won / Active /
 * Closing / Opportunities / Bid Board — every drill-down except the base view and the client-side
 * at-risk/stale list). Composes the tested primitives:
 *  - dashboard dimension set (no `rep` — the page's rep select already filters the board AND the list;
 *    no `scope` — the page's scope toggle owns it);
 *  - the drill-down's visible stages as both the stage multi-select options and the board-mirror scope
 *    (terminal subset → inactiveStageIds, so terminal columns show like the board);
 *  - outcome-aware (the prod flag is on) + the fb_ namespace so the bar's keys never collide with the
 *    page's bare scope/period/filter/page params.
 */
export function buildDrilldownListFilterBar(input: {
  visibleStages: ReadonlyArray<{ id: string; slug: string; name: string }>;
  isTerminalSlug: (slug: string) => boolean;
  regions: ReadonlyArray<{ id: string; name: string }>;
  projectTypes: ReadonlyArray<{ id: string; name: string }>;
}): DrilldownListFilterBar {
  const scope = getBoardVisibleStageScope(
    input.visibleStages.map((stage) => ({ id: stage.id, slug: stage.slug })),
    true,
    input.isTerminalSlug
  );
  return {
    dimensions: getDrilldownFilterBarDimensions(),
    options: {
      regions: input.regions.map((region) => ({ value: region.id, label: region.name })),
      projectTypes: input.projectTypes.map((type) => ({ value: type.id, label: type.name })),
      stages: input.visibleStages.map((stage) => ({ value: stage.id, label: stage.name })),
      sortOptions: DEAL_LIST_SORT_OPTIONS,
    },
    stageEntryDateEnabled: true,
    defaultStageIds: scope.defaultStageIds,
    terminalStageIds: scope.terminalStageIds,
    paramPrefix: DRILLDOWN_FILTERBAR_PARAM_PREFIX,
  };
}

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
  // Status is multi-domain now; narrow to the DEAL statuses so a stray lead status can't become an
  // invalid deal filter. The union check also narrows the type for assignment (no cast).
  if (value.status === "active" || value.status === "on_hold" || value.status === "inactive") {
    filters.status = value.status;
  }
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

/** Canonical Due Diligence stage slugs the board's Show-DD toggle governs. Single source of truth so
 *  the list's default stage scope and the FilterBar stage options exclude DD identically. */
export const DUE_DILIGENCE_STAGE_SLUGS = ["dd", "due_diligence"] as const;

/** Is a board column visible given the Show-DD toggle? (DD columns hide when the board hides them.) */
export function isBoardVisibleStage(slug: string, showDd: boolean): boolean {
  return showDd || !DUE_DILIGENCE_STAGE_SLUGS.includes(slug as (typeof DUE_DILIGENCE_STAGE_SLUGS)[number]);
}

export interface BoardVisibility {
  /** The board's currently-visible column stage ids (Show-DD-filtered). The list defaults its
   *  `stageIds` to these when the user has selected none, so the list shows the SAME stages as the
   *  board it sits under — including terminal columns, excluding DD when the board hides it. */
  defaultStageIds?: string[];
  /** The visible TERMINAL stage ids (subset of defaultStageIds). Sent as `inactiveStageIds` with
   *  `isActive:"pipeline"` so terminal (is_active=false) deals flow through the server's active-only
   *  default — matching the board, which shows Won/Lost columns. Omit to keep the contract's
   *  active-only default (a generic mount that does not want terminal rows). */
  terminalStageIds?: string[];
}

/**
 * Layer "this list mirrors the board above it" onto the mapped FilterBar filters (Slice 7 design
 * sign-off). Two overrides, both opt-in via the board context:
 *  - Q2 (Show-DD mirror): when the user has chosen no stages, default `stageIds` to the board's
 *    visible columns, so DD deals disappear from the list exactly when the board hides the DD column.
 *  - Q1 (active+terminal): when the user has chosen no explicit Status, request mixed visibility
 *    (`isActive:"pipeline"` + the visible terminal ids as `inactiveStageIds`) so terminal deals show
 *    like the board's terminal columns. An explicit Status owns is_active/on_hold server-side
 *    (contract §5), so it is NOT overridden — the chosen lifecycle wins.
 * A user's explicit stage pick or Status always overrides the corresponding default.
 */
export function applyBoardVisibilityDefaults(
  filters: Partial<DealFilters>,
  board: BoardVisibility
): Partial<DealFilters> {
  const next: Partial<DealFilters> = { ...filters };
  const visible = board.defaultStageIds;
  if (visible && visible.length > 0) {
    // Intersect the user's explicit stage picks with the board's currently-visible columns, so a stage
    // the board has hidden (e.g. a DD selection left in the URL after Show-DD is toggled off) cannot
    // linger in the list query (Q2). With no pick — or once every pick is hidden — mirror the board's
    // full visible column set rather than querying nothing or a hidden stage.
    const explicit = Array.isArray(next.stageIds) ? next.stageIds : [];
    const intersected = explicit.filter((id) => visible.includes(id));
    next.stageIds = intersected.length > 0 ? intersected : visible;
  }
  const hasExplicitStatus = next.status !== undefined;
  if (!hasExplicitStatus && board.terminalStageIds && board.terminalStageIds.length > 0) {
    next.isActive = "pipeline";
    next.inactiveStageIds = board.terminalStageIds;
  }
  return next;
}

/**
 * Derive the list's default stage scope from the board's columns: every visible column id (Show-DD
 * filtered) as `defaultStageIds`, and the terminal subset as `terminalStageIds`. Feeds
 * applyBoardVisibilityDefaults so the under-kanban list and the board never disagree about which
 * stages (and which terminal columns) are on the page.
 */
export function getBoardVisibleStageScope(
  columns: ReadonlyArray<{ id: string; slug: string }>,
  showDd: boolean,
  isTerminalSlug: (slug: string) => boolean
): { defaultStageIds: string[]; terminalStageIds: string[] } {
  const visible = columns.filter((column) => isBoardVisibleStage(column.slug, showDd));
  return {
    defaultStageIds: visible.map((column) => column.id),
    terminalStageIds: visible.filter((column) => isTerminalSlug(column.slug)).map((column) => column.id),
  };
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
