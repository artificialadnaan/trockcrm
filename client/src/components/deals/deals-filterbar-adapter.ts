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
  // A shown Stalled (days-in-stage) control must actually filter even when the server flag
  // ENABLE_STAGE_ENTRY_DATE_FILTER is off (e.g. a flag rollback). The server gates the stalled
  // predicate on stageEntryDateEnabled = (flag || stageEntryDateWindow) (service.ts getDeals +
  // deal-filter-predicates.buildStalledPredicate), so forcing the per-request window whenever an
  // age bound is active honors minAgeDays/maxAgeDays regardless of the flag — removing the
  // visible-but-inert state (Codex #580). With no dateFrom/dateTo this only enables the predicate;
  // it does not date-narrow open rows.
  if (value.minAgeDays !== undefined || value.maxAgeDays !== undefined) {
    filters.stageEntryDateWindow = true;
  }
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
