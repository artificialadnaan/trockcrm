import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Briefcase, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import { USD_COMPACT } from "@/components/shared/formatters";
import { useDealBoard, type Deal, type DealBoardColumn } from "@/hooks/use-deals";
import { usePipelineStages, useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { buildCanonicalDealBoardColumns, buildCanonicalDealStageFamilies } from "@/lib/canonical-deal-board";
import { isBoardVisibleStage, DEAL_LIST_SORT_OPTIONS } from "@/components/deals/deals-filterbar-adapter";
import type { FilterDimension } from "@/components/filters/filter-bar";
import { useAuth } from "@/lib/auth";
import { getEffectiveDealValue, WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import {
  buildDealStageWorkspacePath,
  clampDateToToday,
  daysAgo,
  getActivePipelineColumns,
  isTerminalStage,
  isTerminalOutcomeSlug,
  resolveDatePreset,
  toDatePresetRange,
  type TerminalDateFilter,
  type TerminalOutcome,
} from "@/lib/pipeline-terminal-filters";
import { coerceScope, type PipelineScope } from "@/lib/pipeline-scope";
import { KanbanScrollColumn } from "@/components/deals/kanban-scroll-column";
import { DecoratedKanbanCard } from "@/components/deals/decorated-kanban-card";
import { DealsListSection } from "@/components/deals/deals-list-section";
import { buildDrilldownListFilterBar } from "@/components/deals/deals-filterbar-adapter";
import type { DealFilters } from "@/hooks/use-deals";
import type { DealListSortState } from "@/components/deals/deals-list-section";
import { resolvePreferredScope, writeStoredScopePreference } from "@/lib/scope-preferences";
import {
  applyStoredDealView,
  collectPersistableDealViewParams,
  readStoredDealView,
  writeStoredDealView,
} from "@/lib/deals-view-preferences";

// Team scope is parked (PR #512) and not configured anywhere, so it is not offered here. The pills are
// Mine | All plus the two deals-only filter pseudo-scopes Watched and On Hold. "On Hold" matches deals
// that are explicitly held OR have a close target more than 90 days out (effectiveOnHoldSqlPredicate). The shared
// PipelineScope union still includes "team" for URL coercion (see DealListPage); do not change it.
const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
  { value: "watched", label: "Watched" },
  { value: "on_hold", label: "On Hold" },
] as const satisfies readonly ScopeToggleOption<PipelineScope>[];

const SLA_DRILLDOWN_PREVIEW_LIMIT = 1000;
// Request the full per-stage card set (mirrors the server's
// MAX_PIPELINE_CARDS_PER_STAGE_LIMIT) so each board column scrolls internally
// through ALL its deals instead of an 8-card preview. Header counts/totals come
// from independent backend aggregates, so this changes only how many cards are
// fetched into the scroll list — not any displayed total.
const BOARD_CARDS_PER_STAGE_LIMIT = 1000;
// Initial row-height estimate for the virtualized board column; the real height
// of each variable-height DecoratedKanbanCard is measured after mount.
const DEALS_KANBAN_CARD_ESTIMATE_HEIGHT = 132;

export type DashboardDealListFilter =
  | "active"
  | "active_pipeline"
  | "won"
  | "closing_soon"
  | "stale"
  | "at_risk"
  | "opportunities"
  | "bid_board"
  | null;

type DashboardPeriod = "today" | "week" | "mtd" | "qtd" | "ytd" | "last_month" | "last_quarter" | "last_year";
type DashboardPeriodSelection = DashboardPeriod | null;

// Order shown in the header period dropdown (labels via getDashboardPeriodLabel). "__all__" = no ?period.
const PERIOD_OPTIONS: DashboardPeriod[] = ["today", "week", "mtd", "qtd", "ytd", "last_month", "last_quarter", "last_year"];

type DashboardDealListView = {
  filter: DashboardDealListFilter;
  title: string;
  subtitle: string;
  eyebrow: string;
  boardMode: "all" | "active" | "won" | "at_risk";
  listBaseFilters: Partial<DealFilters>;
  listInitialSort: DealListSortState;
  // D-12: the embedded list's date axis. "outcome" (active-pipeline drill-down) routes
  // the window to the canonical outcome filter (dateFrom/dateTo) + displayDate display;
  // other drill-downs keep the default "updated".
  listDateField?: "updated" | "created" | "outcome";
  showEmbeddedList: boolean;
  initialStageSlugs: string[];
  boardStageSlugs: string[];
};

type DrilldownListRow = Deal & {
  boardStageName: string;
};

type DateRange = {
  from?: string;
  to?: string;
};

export function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** URL-param namespaces owned by the under-kanban lists (NOT the board): the base list (dl_) and the
 *  drill-down FilterBar (fb_). Stripped from the board key so list-only edits never refetch the kanban. */
const LIST_PARAM_PREFIXES = ["dl_", "fb_"] as const;

/**
 * A canonical key over only the BOARD-relevant URL params (scope/period/assignedRepId/terminal/estimate).
 * The kanban + KPI cards read these; the under-kanban lists own the dl_* (base) and fb_* (drill-down)
 * namespaces. The board sync effect keys on this so a list-only filter edit (either namespace) does NOT
 * re-sync the board's terminal/estimate state and pointlessly refetch the kanban (Codex #589). Sorted so
 * param order never matters.
 */
export function boardRelevantParamKey(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of [...params.keys()]) {
    if (LIST_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix))) params.delete(key);
  }
  params.sort();
  return params.toString();
}

function normalizeDashboardPeriod(periodParam: string | null | undefined): DashboardPeriodSelection {
  switch (periodParam) {
    case "today":
    case "week":
    case "mtd":
    case "qtd":
    case "ytd":
    case "last_month":
    case "last_quarter":
    case "last_year":
      return periodParam;
    default:
      return null;
  }
}

function getDashboardPeriodLabel(period: DashboardPeriodSelection) {
  if (!period) return "All time";
  switch (period) {
    case "today":
      return "Today";
    case "week":
      return "Week";
    case "mtd":
      return "MTD";
    case "qtd":
      return "QTD";
    case "ytd":
      return "YTD";
    case "last_month":
      return "Last month";
    case "last_quarter":
      return "Last quarter";
    case "last_year":
      return "Last year";
  }
}

export function getDashboardPeriodDateRange(period: DashboardPeriodSelection, now = new Date()) {
  if (!period) return null;
  // Delegate to the canonical resolver (one window math platform-wide). The dashboard tabs label
  // the Sunday-anchored week "week"; the canonical preset for it is "wtd" — same Sun-Sat semantics.
  return resolveDatePreset(period === "week" ? "wtd" : period, now);
}

// Map an inherited dashboard period to the equivalent Won/Lost column date filter. mtd/qtd/ytd
// (and week->wtd) line up with the terminal presets directly; last_* become a custom window from
// the canonical resolver (the chip reads "Custom", never the false "All time").
function periodToTerminalDateFilter(period: DashboardPeriod, now = new Date()): TerminalDateFilter {
  if (period === "mtd" || period === "qtd" || period === "ytd") return { preset: period };
  if (period === "week") return { preset: "wtd" };
  // `today` resolves to a to-date window ENDING today. A custom terminal filter's customEnd is
  // serialized through appendTerminalDateParams' UTC-based clampDateToToday: east of UTC between
  // local and UTC midnight that clamps won_until back to the PREVIOUS day while the sibling
  // won_period_to stays the local date — mutually exclusive Won bounds that empty the board
  // (Codex #566). last_* windows end in the PAST so the clamp is a no-op there; only `today`
  // collides, so keep it at the default and let won_period (local) window the data on its own.
  if (period === "today") return { preset: "all" };
  const range = getDashboardPeriodDateRange(period, now);
  if (range?.from) return { preset: "custom", customStart: range.from, customEnd: range.to };
  return { preset: "all" };
}

// The shared period as a terminal-STAGE-page window. Stage drill-downs read won_since/until & lost_since/until
// and have NO won_period sibling, so the WON stage page must be windowed by the period directly — the #566
// today->all dodge is BOARD-specific (it dodges a won_until-vs-won_period_to clamp the stage page can't hit).
// Mirrors the Lost windowing in resolveDrilldownTerminalDateFilters, so both terminal stage pages match the
// visibly period-windowed board columns.
function periodToStageWindow(period: DashboardPeriodSelection, now = new Date()): TerminalDateFilter {
  if (!period) return { preset: "all" };
  if (period === "today") {
    const range = getDashboardPeriodDateRange(period, now);
    return range?.from
      ? { preset: "custom", customStart: range.from, customEnd: range.to }
      : { preset: "all" };
  }
  return periodToTerminalDateFilter(period, now);
}

// Option A (board-wide date): the /deals board carries ONE shared date — the header ?period. The Won/Lost
// terminal columns mirror it and no longer own independent per-column overrides, so the board's terminal
// windows derive PURELY from ?period. Any stale won_*/lost_* still in the URL (an old bookmark) is collapsed
// here and stripped on load — it can no longer pin a column to a divergent window.
//   Won vs Lost asymmetry is preserved: the Won column lets the board-wide won_period aggregate window it
// (so it stays {all} on non-Won views), while the Lost column has no won_period sibling and is windowed
// directly from the period (Codex #600 P2). #566: period=today routes Won to {all} to dodge the UTC
// won_until-vs-won_period_to clamp that would otherwise empty the Won board.
export function resolveDrilldownTerminalDateFilters(
  params: URLSearchParams,
  now = new Date()
): Record<TerminalOutcome, TerminalDateFilter> {
  const period = normalizeDashboardPeriod(params.get("period"));
  if (!period) return { won: { preset: "all" }, lost: { preset: "all" } };
  const isWonDrilldown = normalizeDashboardDealFilter(params.get("filter")) === "won";
  const result: Record<TerminalOutcome, TerminalDateFilter> = {
    won: { preset: "all" },
    lost: { preset: "all" },
  };
  // Won column: seed from the period ONLY on the Won drill-down (the surface D-7 flags); other views keep
  // the Won column current-state and let won_period window the board-wide aggregate.
  if (isWonDrilldown) {
    result.won = periodToTerminalDateFilter(period, now);
  }
  // Lost column: the header period windows it directly. won_period covers Won + open columns server-side,
  // but the Lost column reads lost_since/lost_until — so seed it from the period whenever ?period is set.
  if (period === "today") {
    // periodToTerminalDateFilter nulls `today` to {preset:"all"} to dodge a WON-only won_until vs
    // won_period_to clamp conflict (Codex #566). Lost has no won_period sibling, so give it the REAL
    // today window — otherwise ?period=today leaves the Lost column all-time (Codex #600 P2).
    const todayRange = getDashboardPeriodDateRange(period, now);
    result.lost = todayRange?.from
      ? { preset: "custom", customStart: todayRange.from, customEnd: todayRange.to }
      : { preset: "all" };
  } else {
    result.lost = periodToTerminalDateFilter(period, now);
  }
  return result;
}

function normalizeDashboardDealFilter(filterParam: string | null | undefined): DashboardDealListFilter {
  switch (filterParam) {
    case "active":
    case "active_pipeline":
      return "active";
    case "pipeline":
      return "active_pipeline";
    case "won":
      return "won";
    case "closing_soon":
    case "closing-soon":
      return "closing_soon";
    case "stale":
      return "stale";
    case "at_risk":
    case "at-risk":
      return "at_risk";
    case "opportunities":
    case "opportunity":
      return "opportunities";
    case "bid_board":
    case "bid-board":
    case "estimating":
      return "bid_board";
    default:
      return null;
  }
}

// The /deals BASE-view list mounts the FULL /pipeline FilterBar (incl. Rep), MINUS only Scope (the page
// toggle owns scope; the list inherits it). The header's Rep + period also drive the KPI cards + board;
// the bar's Rep NESTS within the header Rep — the header is the broad scope, the bar refines the list
// within it (Adnaan). Namespaced `dl_` so the list's params can't collide with the header's bare
// ?assignedRepId/?scope/?period. Cards + read-only board stay untouched.
// NOTE: this PR is the base-list FilterBar mount ONLY. The top "Estimate Sent to Client" control
// removal + the real board-wide ?period dropdown is a SEPARATE follow-up (not built here).
const DEALS_BASE_LIST_FILTERBAR_DIMENSIONS: FilterDimension[] = [
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

export function getDashboardDealListView(input: {
  filterParam: string | null | undefined;
  periodParam: string | null | undefined;
  now?: Date;
}): DashboardDealListView {
  const filter = normalizeDashboardDealFilter(input.filterParam);
  const period = normalizeDashboardPeriod(input.periodParam);
  const periodLabel = getDashboardPeriodLabel(period);
  const periodRange = getDashboardPeriodDateRange(period, input.now);

  if (filter === "active" || filter === "active_pipeline") {
    return {
      filter: input.filterParam === "active_pipeline" || input.filterParam === "pipeline" ? "active_pipeline" : "active",
      eyebrow: "Director drill-down",
      title: "Active Pipeline",
      subtitle: period ? `Open-stage deals for ${periodLabel}.` : "Open-stage deals across the current pipeline.",
      boardMode: "active",
      // D-12: window the embedded list on the CANONICAL outcome axis (dateFrom/dateTo ->
      // buildDealOutcomeDateScope: open rows bound by stage_entered_at) instead of
      // updated_at — so a deal's shown date is the axis it filtered on and "Open-stage
      // deals for MTD" stops leaking Lost/months-old deals merely touched in the window.
      listBaseFilters: periodRange
        ? {
            dateFrom: periodRange.from,
            dateTo: periodRange.to,
          }
        : {},
      listInitialSort: { key: "display_date", dir: "desc" },
      listDateField: "outcome",
      showEmbeddedList: true,
      initialStageSlugs: [],
      boardStageSlugs: [],
    };
  }

  if (filter === "won") {
    return {
      filter,
      eyebrow: "Director drill-down",
      title: "Closed Won",
      subtitle: period ? `Booked wins for ${periodLabel}.` : "Booked wins across all time.",
      boardMode: "won",
      listBaseFilters: periodRange
        ? {
            wonClosedFrom: periodRange.from,
            wonClosedTo: periodRange.to,
          }
        : {},
      listInitialSort: { key: "contract_signed_date", dir: "desc" },
      showEmbeddedList: true,
      initialStageSlugs: [],
      boardStageSlugs: [],
    };
  }

  if (filter === "closing_soon") {
    return {
      filter,
      eyebrow: "Director drill-down",
      title: "Closing Pipeline",
      subtitle: period
        ? `Active deals sorted by expected close date for ${periodLabel}.`
        : "Active deals sorted by expected close date.",
      boardMode: "active",
      listBaseFilters: periodRange
        ? {
            updatedFrom: periodRange.from,
            updatedTo: periodRange.to,
          }
        : {},
      listInitialSort: { key: "expected_close_date", dir: "asc" },
      showEmbeddedList: true,
      initialStageSlugs: [],
      boardStageSlugs: [],
    };
  }

  if (filter === "opportunities" || filter === "bid_board") {
    const stageSlugs = filter === "opportunities" ? ["opportunity"] : ["estimating", "service_estimating"];
    return {
      filter,
      eyebrow: "Dashboard drill-down",
      title: filter === "opportunities" ? "Opportunities" : "Bid Board",
      subtitle:
        filter === "opportunities"
          ? period
            ? `Opportunity-stage deals for ${periodLabel}.`
            : "Opportunity-stage deals."
          : period
            ? `Estimating-stage deals for ${periodLabel}.`
            : "Estimating-stage deals.",
      boardMode: "all",
      listBaseFilters: periodRange
        ? {
            updatedFrom: periodRange.from,
            updatedTo: periodRange.to,
          }
        : {},
      listInitialSort: { key: "updated_at", dir: "desc" },
      showEmbeddedList: true,
      initialStageSlugs: stageSlugs,
      boardStageSlugs: stageSlugs,
    };
  }

  if (filter === "stale" || filter === "at_risk") {
    return {
      filter,
      eyebrow: "Dashboard drill-down",
      title: filter === "stale" ? "Stale Deals" : "Deals At Risk",
      // "Stale"/"Deals At Risk" are CURRENT-STATE views — ?period is a deliberate no-op here. Period-
      // windowing by updated_at would hide the stalest (least-recently-touched, i.e. MOST at-risk) deals,
      // which is backwards for an SLA surface. So the subtitle never claims a period, and listBaseFilters
      // carries no updated-at window — the card, kanban, list, and link all show the full current cohort.
      subtitle:
        filter === "stale"
          ? "Open-stage deals past their stage SLA."
          : "Open-stage deals over SLA and needing attention.",
      boardMode: "at_risk",
      listBaseFilters: {},
      listInitialSort: { key: "stage_entered_at", dir: "asc" },
      showEmbeddedList: true,
      initialStageSlugs: [],
      boardStageSlugs: [],
    };
  }

  return {
    filter,
    eyebrow: "Workflow control",
    title: "Deals Dashboard",
    subtitle: "KPIs and drill-downs over your deals, with the kanban board + filterable working list below.",
    boardMode: "all",
    listBaseFilters: {},
    listInitialSort: { key: "updated_at", dir: "desc" },
    showEmbeddedList: true,
    initialStageSlugs: [],
    boardStageSlugs: [],
  };
}

function getScope(searchParams: URLSearchParams, role: string | undefined): PipelineScope {
  void role;
  return coerceScope(searchParams.get("scope")) ?? "mine";
}

function readCurrentTerminalDateFilters(): Record<TerminalOutcome, TerminalDateFilter> {
  return {
    won: { preset: "all" },
    lost: { preset: "all" },
  };
}

export function isDealDatePreset(value: string | null): value is Exclude<TerminalDateFilter["preset"], "custom"> {
  return (
    value === "7" ||
    value === "30" ||
    value === "60" ||
    value === "90" ||
    value === "wtd" ||
    value === "mtd" ||
    value === "qtd" ||
    value === "ytd" ||
    value === "all"
  );
}

export function buildDealStageNavigationPath(
  column: DealBoardColumn,
  scope: PipelineScope,
  filters: Record<TerminalOutcome, TerminalDateFilter> = readCurrentTerminalDateFilters(),
  queryParams?: URLSearchParams | Record<string, string | null | undefined>
) {
  return buildDealStageWorkspacePath({
    stageId: column.stage.id,
    stageSlug: column.stage.slug,
    scope,
    filters,
    queryParams,
  });
}

export function buildDealsPageKpiDrilldownPath(
  filter: Exclude<DashboardDealListFilter, null>,
  scope: PipelineScope,
  period?: DashboardPeriodSelection,
  options?: {
    queryParams?: URLSearchParams | Record<string, string | null | undefined>;
    wonQueryParams?: URLSearchParams | Record<string, string | null | undefined>;
  }
) {
  const params = new URLSearchParams();
  params.set("filter", filter);
  params.set("scope", scope);
  if (period) params.set("period", period);
  const queryParams = options?.queryParams ?? options?.wonQueryParams;
  if (queryParams) {
    const entries =
      queryParams instanceof URLSearchParams
        ? Array.from(queryParams.entries())
        : Object.entries(queryParams);
    for (const [key, value] of entries) {
      if (!value) continue;
      if (
        key === "assignedRepId" ||
        // Keep the header period scope through outcome-aware drill-downs (active pipeline / Won), but NOT
        // the SLA drill-downs (at_risk / stale): those are CURRENT-STATE views where ?period is a deliberate
        // no-op (getDashboardDealListView gives them no updated-at window — period-filtering an SLA surface
        // by updated_at would hide the stalest, most at-risk deals). So the link must NOT carry a period
        // either — omitting it keeps the destination on the full current at-risk cohort, matching the card.
        // won_*/lost_* are NOT forwarded — the Won drill-down inherits the single shared ?period (already
        // set above), not a collapsed per-column override.
        (key === "period" && filter !== "at_risk" && filter !== "stale")
      ) {
        params.set(key, value);
      }
    }
  }
  return `/deals?${params.toString()}`;
}

function moneyValue(deal: Deal) {
  return getEffectiveDealValue(deal);
}

export function sumNonOnHoldDealValues(deals: Deal[]) {
  return deals
    .filter((deal) => !deal.onHold)
    .reduce((sum, deal) => sum + moneyValue(deal), 0);
}

export function isEngineAtRiskDeal(deal: Deal) {
  return deal.atRisk?.isAtRisk === true && deal.atRisk.status === "at_risk";
}

/**
 * Rebuild a board column's aggregates from a filtered subset of its cards: `count` excludes on-hold,
 * `totalCount` is every card, `totalValue` is the non-on-hold $. The ONE recount used by the search
 * filter, the at-risk filter, and the summary — so every surface aggregates a card set identically.
 */
export function recountColumnFromCards(column: DealBoardColumn, cards: Deal[]): DealBoardColumn {
  return {
    ...column,
    totalCount: cards.length,
    count: cards.filter((deal) => !deal.onHold).length,
    cards,
    totalValue: sumNonOnHoldDealValues(cards),
  };
}

/**
 * The at-risk drill-down's SINGLE source of truth: non-terminal columns with their cards narrowed to
 * the engine at-risk predicate. The Active Pipeline card, the At-Risk card, and the kanban all derive
 * from THIS set (the kanban additionally applies the text search), so the three reconcile by
 * construction — no parallel whole-pipeline query.
 *
 * "Deals at Risk" is a CURRENT-STATE view: it deliberately does NOT period-filter by updated_at. A deal
 * is at risk because it's over-SLA / needs touch — period-windowing on updated_at would hide the STALEST
 * deals (the least-recently-touched, i.e. the most at-risk), which is backwards for this surface. So
 * ?period is a no-op here, and the card/kanban/list/link all show the same full current at-risk cohort.
 *
 * The at-risk count/value are derived from the column's CARDS (there is no server-side at-risk
 * aggregate — the board only ships a full-column aggregate + a preview card slice). That is shared by
 * all three at-risk surfaces, so they stay reconciled; it also means the totals are bounded by the
 * board's per-stage preview cap (SLA_DRILLDOWN_PREVIEW_LIMIT, 1000), far above the real at-risk volume.
 * A stage with >1000 at-risk deals would under-count uniformly across all three — if that ever becomes
 * reachable, the fix is a server at-risk aggregate feeding all three, not a per-card divergence here.
 */
export function getAtRiskBoardColumns(boardColumns: DealBoardColumn[]): DealBoardColumn[] {
  return boardColumns
    .filter((column) => !isTerminalStage(column.stage.slug))
    .map((column) =>
      recountColumnFromCards(
        column,
        column.cards.filter((deal) => isEngineAtRiskDeal(deal))
      )
    );
}

/**
 * NaN-safe roll-up for the Active Pipeline KPI card: active (non-on-hold) `count`, `visibleCount`
 * (incl. on-hold), and non-on-hold `value` — each coerced finite so a stray non-numeric column total
 * can never render `$NaN`.
 */
export function getActivePipelineSummary(columns: DealBoardColumn[]) {
  const finite = (n: number) => (Number.isFinite(n) ? n : 0);
  return {
    count: columns.reduce((sum, column) => sum + finite(column.count), 0),
    visibleCount: columns.reduce((sum, column) => sum + finite(column.totalCount ?? column.count), 0),
    value: columns.reduce((sum, column) => sum + finite(column.totalValue), 0),
  };
}

/**
 * The Active Pipeline KPI card drills into the cohort it DISPLAYS: the at-risk set on the at-risk
 * drill-down (so the click-through matches the number on the card), the full active pipeline otherwise.
 */
export function activePipelineDrilldownFilter(
  boardMode: "all" | "active" | "won" | "at_risk"
): "at_risk" | "active_pipeline" {
  return boardMode === "at_risk" ? "at_risk" : "active_pipeline";
}

function stageAgeDaysLabel(deal: Deal) {
  return deal.atRisk ? `${deal.atRisk.effectiveStageAgeDays}d` : "N/A";
}

function dealOwnerLabel(deal: Deal) {
  const ownerName = deal.assignedRepName?.trim();
  if (ownerName) return ownerName;
  return deal.assignedRepId ? "Unknown owner" : "Unassigned";
}

export function compareDrilldownDeals(left: DrilldownListRow, right: DrilldownListRow, sort: DealListSortState) {
  // Primary tier: active, non-zero deals on top; on-hold and $0 deals sink to the
  // bottom regardless of the active sort. (on-hold already reads as $0 via
  // getEffectiveDealValue/moneyValue, but the explicit guard keeps the intent clear.)
  const tierOf = (deal: DrilldownListRow) => (!deal.onHold && moneyValue(deal) > 0 ? 0 : 1);
  const tierDelta = tierOf(left) - tierOf(right);
  if (tierDelta !== 0) return tierDelta;

  const direction = sort.dir === "asc" ? 1 : -1;
  const textCompare = (a: string, b: string) => a.localeCompare(b) * direction;
  const numberCompare = (a: number, b: number) => (a - b) * direction;
  const dateCompare = (a?: string | null, b?: string | null) =>
    numberCompare(new Date(a ?? 0).getTime() || 0, new Date(b ?? 0).getTime() || 0);

  switch (sort.key) {
    case "name":
      return textCompare(left.name, right.name);
    case "awarded_amount":
      return numberCompare(moneyValue(left), moneyValue(right));
    case "stage_entered_at":
      if (left.atRisk && right.atRisk) {
        return numberCompare(
          right.atRisk.effectiveStageAgeSeconds,
          left.atRisk.effectiveStageAgeSeconds
        );
      }
      return dateCompare(left.stageEnteredAt, right.stageEnteredAt);
    case "expected_close_date":
      return dateCompare(left.expectedCloseDate, right.expectedCloseDate);
    case "contract_signed_date":
      return dateCompare(left.actualCloseDate, right.actualCloseDate);
    case "updated_at":
    default:
      return dateCompare(left.updatedAt, right.updatedAt);
  }
}

function parseLocalDay(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function parseDayEnd(value: string) {
  const date = parseLocalDay(value);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function parseDayStart(value: string) {
  return parseLocalDay(value).getTime();
}

export function getWonMetricTerminalLabel(filter: TerminalDateFilter) {
  if (filter.preset === "custom") return "Custom";
  if (filter.preset === "all") return "All time";
  if (filter.preset === "wtd") return "WTD";
  if (filter.preset === "mtd") return "MTD";
  if (filter.preset === "qtd") return "QTD";
  if (filter.preset === "ytd") return "YTD";
  return `Last ${filter.preset} days`;
}

export function getTerminalDateRange(filter: TerminalDateFilter, now = new Date()): DateRange {
  if (filter.preset === "all") return {};

  const today = formatDateInput(now);
  if (filter.preset === "custom") {
    return {
      from: filter.customStart,
      to: filter.customEnd ?? today,
    };
  }

  if (
    filter.preset === "wtd" ||
    filter.preset === "mtd" ||
    filter.preset === "qtd" ||
    filter.preset === "ytd"
  ) {
    return toDatePresetRange(filter.preset, now);
  }

  const start = new Date(now);
  start.setDate(start.getDate() - Number(filter.preset));

  return {
    from: formatDateInput(start),
    to: today,
  };
}

function intersectDateRanges(...ranges: Array<DateRange | null | undefined>): DateRange {
  let from: string | undefined;
  let to: string | undefined;

  for (const range of ranges) {
    if (!range) continue;
    if (range.from) from = from ? (range.from > from ? range.from : from) : range.from;
    if (range.to) to = to ? (range.to < to ? range.to : to) : range.to;
  }

  return { from, to };
}

export function matchesUpdatedRange(deal: Deal, updatedFrom?: string, updatedTo?: string) {
  if (!updatedFrom && !updatedTo) return true;

  const updatedAt = new Date(deal.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) return false;

  if (updatedFrom && updatedAt < parseDayStart(updatedFrom)) return false;
  if (updatedTo && updatedAt > parseDayEnd(updatedTo)) return false;

  return true;
}

export function getCanonicalTerminalMetric(columns: DealBoardColumn[], stageSlug: TerminalOutcome) {
  const column = columns.find((item) => item.stage.slug === stageSlug);

  return {
    count: column?.count ?? 0,
    totalCount: column?.totalCount ?? column?.count ?? 0,
    totalValue: column?.totalValue ?? 0,
  };
}

function DealsBoardColumn({
  column,
  onOpenStage,
  onOpenRecord,
  periodValue,
  onPeriodChange,
}: {
  column: DealBoardColumn;
  onOpenStage: (column: DealBoardColumn) => void;
  onOpenRecord: (id: string) => void;
  // Option A: the Won/Lost terminal columns mirror the single shared board date (?period). `periodValue`
  // is the page's selected period ("__all__" = no period); `onPeriodChange` is the shared period setter —
  // both supplied ONLY for terminal columns, so changing a column writes the same ?period the top control does.
  periodValue?: string;
  onPeriodChange?: (value: string) => void;
}) {
  const totalValue =
    column.totalValue ?? sumNonOnHoldDealValues(column.cards);
  const terminalOutcome = isTerminalOutcomeSlug(column.stage.slug) ? column.stage.slug : null;
  const hasBoardDate = periodValue != null && periodValue !== "__all__";
  const emptyText = terminalOutcome && hasBoardDate ? "No deals in selected range" : "No deals";

  const header = (
    <>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="truncate text-left text-xs font-medium uppercase tracking-wide text-gray-500 hover:text-gray-900"
          onClick={() => onOpenStage(column)}
        >
          {column.stage.name}
        </button>
        <span className="rounded-sm bg-gray-200/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-gray-600">
          {column.count}/{column.totalCount ?? column.count}
        </span>
      </div>
      {terminalOutcome && periodValue !== undefined && onPeriodChange ? (
        <Select value={periodValue} onValueChange={(value) => onPeriodChange(value ?? "__all__")}>
          <SelectTrigger
            aria-label={`${column.stage.name} date range`}
            className="mt-2 h-7 w-full justify-between rounded-sm border-slate-300 bg-white text-xs font-semibold text-slate-700"
          >
            <SelectValue>
              {getDashboardPeriodLabel(
                normalizeDashboardPeriod(periodValue === "__all__" ? null : periodValue)
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All time</SelectItem>
            {PERIOD_OPTIONS.map((period) => (
              <SelectItem key={period} value={period}>
                {getDashboardPeriodLabel(period)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900">
        {USD_COMPACT(totalValue)}
      </p>
    </>
  );

  return (
    <KanbanScrollColumn
      header={header}
      childCount={column.cards.length}
      itemCount={column.cards.length}
      estimateItemSize={DEALS_KANBAN_CARD_ESTIMATE_HEIGHT}
      getItemKey={(index) => column.cards[index]!.id}
      renderItem={(index) => {
        const deal = column.cards[index]!;
        return (
          <DecoratedKanbanCard
            deal={deal}
            stageSlug={column.stage.slug}
            onClick={() => onOpenRecord(deal.id)}
          />
        );
      }}
    >
      {/* Rendered only when itemCount is 0 (virtualization off). */}
      <div className="border border-dashed border-gray-200 py-8 text-center text-xs text-gray-400">
        {emptyText}
      </div>
    </KanbanScrollColumn>
  );
}

export function DealListPage() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading || !user) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
        Loading deal board...
      </div>
    );
  }

  return <DealListPageContent role={user.role} userId={user.id} />;
}

function DealListPageContent({ role, userId }: { role: string; userId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Remember the standing dashboard filters (header Rep + timeframe + base-list `dl_` FilterBar) per-user,
  // the same way Mine/All already persists — so opening a deal and returning to /deals (a nav link lands on
  // a bare /deals) restores the last selection instead of resetting. Scope stays owned by scope-preferences;
  // transient drill-down state (?filter / fb_* / terminal / won_* / lost_*) is intentionally NOT persisted.
  const dealViewHydratedRef = useRef(false);
  const dealViewWritePrimedRef = useRef(false);
  useEffect(() => {
    // Hydrate ONCE on mount: fill any missing standing param from the store. The ref guard makes this a
    // single-shot even though `searchParams` is a dependency, and an explicit URL param always wins.
    if (dealViewHydratedRef.current) return;
    dealViewHydratedRef.current = true;
    const next = applyStoredDealView(searchParams.toString(), readStoredDealView(userId));
    if (next !== null) setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, userId]);
  useEffect(() => {
    // Skip the mount run (it would persist the pre-hydrate URL, briefly clobbering the store), then save the
    // persistable subset on every change — including a deliberate clear.
    if (!dealViewWritePrimedRef.current) {
      dealViewWritePrimedRef.current = true;
      return;
    }
    writeStoredDealView(userId, collectPersistableDealViewParams(searchParams.toString()));
  }, [searchParams, userId]);

  const [search, setSearch] = useState("");
  const [drilldownPage, setDrilldownPage] = useState(1);
  const [terminalDateFilters, setTerminalDateFilters] = useState<Record<TerminalOutcome, TerminalDateFilter>>(() =>
    resolveDrilldownTerminalDateFilters(searchParams)
  );
  const requestedScope = resolvePreferredScope({
    requestedScope: searchParams.get("scope"),
    userId,
    fallback: getScope(searchParams, role),
  });
  // Team is not offered (see SCOPE_OPTIONS); coerce a stored/URL ?scope=team to a scope we
  // actually render so the toggle and board never reach the dead "team" placeholder state.
  const scope: PipelineScope = requestedScope === "team" ? "mine" : requestedScope;
  const selectedPeriod = useMemo(() => normalizeDashboardPeriod(searchParams.get("period")), [searchParams]);
  const selectedPeriodRange = useMemo(() => getDashboardPeriodDateRange(selectedPeriod), [selectedPeriod]);
  const scopeOptions = SCOPE_OPTIONS;
  const { stages } = usePipelineStages("deal");
  const { assignees } = useTaskAssignees();
  // Option sources for the base-view + drill-down FilterBar region / project-type dimensions (Rep stays
  // the page-level select / header; scope stays the page toggle — neither is a bar dimension here).
  const { regions } = useRegions();
  const { projectTypes } = useProjectTypes();
  // When a parked ?scope=team bookmark is coerced to mine, drop any stale owner filter from
  // the URL too -- otherwise the Mine board (the viewer's deals) is intersected with another
  // rep's owner filter and renders empty instead of the intended Mine view (D-12b).
  const selectedRepId =
    requestedScope === "team" ? "__all__" : searchParams.get("assignedRepId") || "__all__";
  const selectedRepFilter = selectedRepId === "__all__" ? undefined : selectedRepId;
  const selectedRepLabel =
    selectedRepId === "__all__"
      ? "All reps"
      : assignees.find((assignee) => assignee.id === selectedRepId)?.displayName ?? "Selected rep";
  const dashboardView = useMemo(
    () =>
      getDashboardDealListView({
        filterParam: searchParams.get("filter"),
        periodParam: searchParams.get("period"),
      }),
    [searchParams]
  );
  const isAtRiskDrilldown = dashboardView.filter === "stale" || dashboardView.filter === "at_risk";
  const { board, loading, error } = useDealBoard(
    scope,
    true,
    terminalDateFilters,
    isAtRiskDrilldown ? SLA_DRILLDOWN_PREVIEW_LIMIT : BOARD_CARDS_PER_STAGE_LIMIT,
    // Deals-at-Risk is a CURRENT-STATE view: ?period is a no-op. The board period serializes as
    // won_period_from/to, which the server applies to OPEN columns as a stage-entry-date window
    // (getDealsForPipeline) — so sending it here would still drop at-risk deals outside the window at the
    // SOURCE, even though the client no longer filters by it. Send no board period on this drill-down so
    // the at-risk cohort (card/kanban/list) is the full current set. (Won columns are hidden here anyway.)
    isAtRiskDrilldown ? null : selectedPeriodRange,
    selectedRepFilter
  );

  // Sync the board's terminal (Won/Lost) date state from the URL — but key on the BOARD params only, so a
  // list-namespaced (dl_/fb_) FilterBar edit never churns this state and refetches the kanban above it
  // (Codex #589). searchParams is read live inside; it is current whenever the key changes.
  const boardParamKey = boardRelevantParamKey(searchParams.toString());
  useEffect(() => {
    setTerminalDateFilters(resolveDrilldownTerminalDateFilters(searchParams));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on board params only.
  }, [boardParamKey]);

  // A parked ?scope=team bookmark is coerced to mine for the render above; also rewrite the
  // URL so the stale scope/owner params do not persist -- otherwise updateScope clones them
  // and clicking All silently re-applies the old owner filter to the All board (D-12b).
  useEffect(() => {
    if (requestedScope !== "team") return;
    const next = new URLSearchParams(searchParams);
    next.set("scope", "mine");
    next.delete("assignedRepId");
    setSearchParams(next, { replace: true });
  }, [requestedScope, searchParams, setSearchParams]);

  // Strip stale params from the URL on load so a bookmarked/shared link can neither invisibly filter the
  // board NOR be forwarded into a stage-page drill-down (which still passes the full searchParams and would
  // otherwise apply an invisible, control-less filter there, Codex #600 P2). Two families are collapsed:
  //   - estimate_sent_*: the Estimate-Sent control was replaced by the header Period dropdown (its range is
  //     no longer read here);
  //   - won_*/lost_*: the per-column Won/Lost overrides were collapsed into the single shared ?period
  //     (Option A). A bare won_/lost_ in the URL would otherwise be carried into the Won drill-down path.
  useEffect(() => {
    const stale = [...searchParams.keys()].filter(
      (key) => key.startsWith("estimate_sent_") || key.startsWith("won_") || key.startsWith("lost_")
    );
    if (stale.length === 0) return;
    const next = new URLSearchParams(searchParams);
    for (const key of stale) next.delete(key);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const updateSelectedRep = useCallback((repId: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (!repId || repId === "__all__") next.delete("assignedRepId");
      else next.set("assignedRepId", repId);
      return next;
    });
  }, [setSearchParams]);

  // The header period dropdown writes ?period, which already drives the KPI cards + read-only board
  // board-wide (selectedPeriodRange → useDealBoard wonPeriodRange → won_period_from/to, the outcome-aware
  // D-11 window) AND scopes the base list (fed into its baseFilters below). "__all__" clears the param.
  // The single shared "set board date" setter — used by BOTH the header Period dropdown and the Won/Lost
  // column date controls (Option A). One action -> one ?period write -> the board, KPIs, list, and both
  // terminal columns all follow it.
  const updatePeriod = useCallback((value: string) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === "__all__") next.delete("period");
    else next.set("period", value);
    // Collapse any per-column won_*/lost_* override so a board-date change (from the top control OR a
    // terminal column) can never leave a stale per-column window behind — the board carries ONE date.
    for (const key of [...next.keys()]) {
      if (key.startsWith("won_") || key.startsWith("lost_")) next.delete(key);
    }
    // Write ?period AND the period-derived terminal (Won/Lost) filters in LOCKSTEP. If we only wrote
    // ?period and let the boardParamKey effect re-sync terminalDateFilters a render later, the board would
    // fire one fetch with the NEW won_period_from/to but STALE lost_since/until — a mixed window;
    // useDealBoard does not cancel or order responses, so that stale fetch could win and leave the
    // board/cards on a blended date range (Codex #600 P2).
    setSearchParams(next);
    setTerminalDateFilters(resolveDrilldownTerminalDateFilters(next));
  }, [searchParams, setSearchParams]);

  const boardColumns = useMemo(
    () => buildCanonicalDealBoardColumns(board?.columns, stages),
    [board?.columns, stages]
  );
  // Base-list board-mirror scope: the /deals board always includes DD (useDealBoard includeDd=true),
  // so showDd=true — the list defaults to the full visible-column set and lets terminal deals through,
  // exactly like the board it sits under (mirrors the /pipeline mount).
  //
  // ALL three values flow from ONE CANONICAL grouping — the same normalizeDealStageSlug membership the
  // board uses — so the list matches the board column-for-column (Codex #589):
  //  - defaultStageIds: every member id of every visible canonical column (no family dropped);
  //  - terminalStageIds: members of the canonical WON/LOST columns — classified by CANONICAL slug, so
  //    Won/Lost ALIASES (closed_won, sent_to_production, service_lost, …) are included and their inactive
  //    rows survive the active-only default (raw-slug isTerminalOutcomeSlug only matched literal won/lost);
  //  - stageIdFamilies: the per-column id set, so an explicit canonical pick expands to the board column's
  //    full membership (contract_signed + service_contract_signed → contract).
  // isBoardVisibleStage filters DD, which canonicalizes into opportunity, so it is a no-op at showDd=true.
  const dealsBaseListStageScope = useMemo(() => {
    const families = buildCanonicalDealStageFamilies(stages).filter((family) =>
      isBoardVisibleStage(family.slug, true)
    );
    return {
      defaultStageIds: families.flatMap((family) => family.ids),
      terminalStageIds: families
        .filter((family) => isTerminalOutcomeSlug(family.slug))
        .flatMap((family) => family.ids),
      stageIdFamilies: families.map((family) => family.ids),
    };
  }, [stages]);
  const columns = useMemo(
    () => {
      const searchTerm = search.trim().toLowerCase();
      const sourceColumns =
        dashboardView.boardStageSlugs.length > 0
          ? boardColumns.filter((column) => dashboardView.boardStageSlugs.includes(column.stage.slug))
          : dashboardView.boardMode === "active"
          ? boardColumns.filter((column) => !isTerminalStage(column.stage.slug))
          : dashboardView.boardMode === "won"
            ? boardColumns.filter((column) => column.stage.slug === "won")
            : dashboardView.boardMode === "at_risk"
              ? getAtRiskBoardColumns(boardColumns)
          : boardColumns;
      return sourceColumns
        .map((column) => {
          if (!searchTerm) return column;
          const cards = column.cards.filter((deal) => {
            const haystack = [
              deal.name,
              deal.dealNumber,
              deal.projectNumber,
              deal.companyName,
              deal.propertyCity,
              deal.propertyState,
              deal.assignedRepName,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return haystack.includes(searchTerm);
          });
          return recountColumnFromCards(column, cards);
        });
    },
    [boardColumns, dashboardView.boardMode, dashboardView.boardStageSlugs, search]
  );
  const unsearchedColumns = useMemo(() => {
    if (dashboardView.boardStageSlugs.length > 0) {
      return boardColumns.filter((column) => dashboardView.boardStageSlugs.includes(column.stage.slug));
    }
    if (dashboardView.boardMode === "active") {
      return boardColumns.filter((column) => !isTerminalStage(column.stage.slug));
    }
    if (dashboardView.boardMode === "won") {
      return boardColumns.filter((column) => column.stage.slug === "won");
    }
    if (dashboardView.boardMode === "at_risk") {
      return getAtRiskBoardColumns(boardColumns);
    }
    return boardColumns;
  }, [boardColumns, dashboardView.boardMode, dashboardView.boardStageSlugs]);
  // On the at-risk drill-down the Active Pipeline KPI card aggregates the SAME at-risk-filtered set that
  // feeds the At-Risk card and the kanban (unsearchedColumns), so the three reconcile by construction —
  // not the whole open board. Everywhere else it stays the full active (non-terminal) pipeline.
  const activePipelineColumns =
    dashboardView.boardMode === "at_risk" ? unsearchedColumns : getActivePipelineColumns(boardColumns);
  const drilldownVisibleStages = useMemo(
    () =>
      dashboardView.boardStageSlugs.length > 0
        ? stages.filter((stage) => dashboardView.boardStageSlugs.includes(stage.slug))
        : dashboardView.boardMode === "active"
        ? stages.filter((stage) => !isTerminalStage(stage.slug))
        : dashboardView.boardMode === "won"
          // The Won list scope = the FULL Won alias family (won, closed_won, the service-won stages),
          // matching the canonical board column / Won KPI which aggregate the family. Canonical-only
          // would drop historical alias-stage wins and under-report vs the KPI (Codex P2 / BLUE checklist).
          ? stages.filter((stage) => WON_DEAL_STAGE_SLUGS.includes(stage.slug))
          : dashboardView.boardMode === "at_risk"
            ? stages.filter((stage) => !isTerminalStage(stage.slug))
          : undefined,
    [dashboardView.boardMode, dashboardView.boardStageSlugs, stages]
  );
  const drilldownDeals = useMemo(() => {
    if (!isAtRiskDrilldown) return [];

    return columns
      .flatMap((column) =>
        column.cards.map((deal) => ({
          ...deal,
          boardStageName: column.stage.name,
        }))
      )
      .sort((left, right) => compareDrilldownDeals(left, right, dashboardView.listInitialSort));
  }, [columns, dashboardView.listInitialSort, isAtRiskDrilldown]);
  const drilldownPageSize = 20;
  const drilldownTotalPages = Math.max(1, Math.ceil(drilldownDeals.length / drilldownPageSize));
  const paginatedDrilldownDeals = useMemo(() => {
    const start = (drilldownPage - 1) * drilldownPageSize;
    return drilldownDeals.slice(start, start + drilldownPageSize);
  }, [drilldownDeals, drilldownPage]);
  const wonDateRange = useMemo(
    () => intersectDateRanges(selectedPeriodRange, getTerminalDateRange(terminalDateFilters.won)),
    [selectedPeriodRange, terminalDateFilters.won]
  );
  const { count: totalCount, visibleCount: totalVisibleCount, value: totalValue } =
    getActivePipelineSummary(activePipelineColumns);
  const wonMetric = getCanonicalTerminalMetric(boardColumns, "won");
  const wonValue = wonMetric.totalValue;
  const unsearchedOverSlaCount = unsearchedColumns.reduce(
    (sum, column) =>
      sum +
      (isTerminalStage(column.stage.slug)
        ? 0
        : column.cards.filter(isEngineAtRiskDeal).length),
    0
  );
  // On the at-risk drill-down the Active Pipeline card DISPLAYS the at-risk cohort, so its click-through
  // must land on that same cohort — not the full active pipeline (which would show a larger, different set
  // than the number on the card). Everywhere else it drills into the full active pipeline.
  const activePipelineDestination = buildDealsPageKpiDrilldownPath(
    activePipelineDrilldownFilter(dashboardView.boardMode),
    scope,
    undefined,
    { queryParams: searchParams }
  );
  const wonDestination = buildDealsPageKpiDrilldownPath("won", scope, selectedPeriod, {
    queryParams: searchParams,
  });
  const atRiskDestination = buildDealsPageKpiDrilldownPath("at_risk", scope, undefined, {
    queryParams: searchParams,
  });
  const wonCaption =
    terminalDateFilters.won.preset !== "all"
      ? getWonMetricTerminalLabel(terminalDateFilters.won)
      : selectedPeriod
        ? getDashboardPeriodLabel(selectedPeriod)
        : "All time";
  // D-14: the "Won" sibling KPI card is windowed by this page's ?period, so on a
  // current-state drill-down with no period it shows an unlabeled LIFETIME Won total
  // (the $22.6M "All time" vs $3.9M "QTD" swing). Show it only where Won is the
  // relevant metric — the Won drill-down — and the base deals list; drop it on the
  // active-pipeline / at-risk / other non-Won drill-downs (a Won total beside
  // at-risk deals is clutter). This avoids the swing WITHOUT propagating the period
  // into those drill-downs (which would wrongly filter their current-state lists by
  // updated_at and hide the stalest deals).
  const showWonKpiCard = dashboardView.filter === null || dashboardView.filter === "won";
  const drilldownBaseFilters = useMemo(() => {
    if (dashboardView.filter !== "won") return dashboardView.listBaseFilters;

    return {
      ...dashboardView.listBaseFilters,
      ...(wonDateRange.from ? { wonClosedFrom: wonDateRange.from } : {}),
      ...(wonDateRange.to ? { wonClosedTo: wonDateRange.to } : {}),
    };
  }, [dashboardView.filter, dashboardView.listBaseFilters, wonDateRange.from, wonDateRange.to]);
  // The drill-down list baseline = the drill-down base filters (the estimate-sent overlay was removed with
  // the top control; the period control's window is layered at the base-view mount, not here).
  const layeredListBaseFilters = drilldownBaseFilters;
  // Shared FilterBar on the DRILL-DOWN list (filter !== null). RED owns the base-view mount
  // (filter === null); the client-side at-risk/stale SLA list has no server predicate, so the bar
  // (which drives getDeals) can't back it — both return undefined here and keep today's behavior.
  const drilldownFilterBar = useMemo(() => {
    if (dashboardView.filter === null || isAtRiskDrilldown) return undefined;
    // Codex P2: wait for stage metadata before mounting the bar. FilterBar mode queries unconditionally,
    // so with stages still [] the first request would carry no stage constraint and briefly show all
    // active deals (wrong cohort on e.g. a Won / Opportunities drill-down) before refetching. Until then
    // the section stays in legacy mode, which gates the query on stage loading.
    if (stages.length === 0) return undefined;
    return {
      ...buildDrilldownListFilterBar({
        visibleStages: (drilldownVisibleStages ?? []).map((stage) => ({
          id: stage.id,
          slug: stage.slug,
          name: stage.name,
        })),
        isTerminalSlug: isTerminalStage,
        regions,
        projectTypes,
      }),
      // Codex P2: preserve the drill-down's intended order in FilterBar mode (URL-backed sort would
      // otherwise fall to the server default created_at desc for a default/bookmarked view).
      defaultSort: dashboardView.listInitialSort,
    };
  }, [
    dashboardView.filter,
    dashboardView.listInitialSort,
    isAtRiskDrilldown,
    drilldownVisibleStages,
    regions,
    projectTypes,
    stages.length,
  ]);
  // In FilterBar mode the list args spread baseFilters then the bar value; they do NOT read
  // lockedOwnerId (that feeds only the legacy path). So fold the page's rep select into baseFilters,
  // else the drill-down list would ignore the selected rep and diverge from the board above. The
  // legacy/base path overrides this with the identical lockedOwnerId value, so it is a no-op there.
  const drilldownListBaseFilters = useMemo(
    () => ({
      ...layeredListBaseFilters,
      ...(selectedRepFilter ? { assignedRepId: selectedRepFilter } : {}),
      // Won drill-down: exclude on-hold (migration parking-lot) deals so the list reconciles to the Won
      // KPI / board column, both of which drop on-hold from the Won count (Codex P2).
      ...(dashboardView.filter === "won" ? { excludeOnHold: true } : {}),
    }),
    [layeredListBaseFilters, selectedRepFilter, dashboardView.filter]
  );

  const updateScope = (nextScope: PipelineScope) => {
    writeStoredScopePreference(userId, nextScope);
    const next = new URLSearchParams(searchParams);
    next.set("scope", nextScope);
    setSearchParams(next);
  };

  // Stage drill-downs inherit the single shared board date. terminalDateFilters.won is {all} on non-Won
  // views (the board windows it via won_period, which the stage page lacks), so window BOTH terminal stage
  // pages by the period directly — otherwise the visibly period-windowed Won column would open an all-time
  // stage page (Codex P2).
  const stageNavTerminalFilters = useMemo<Record<TerminalOutcome, TerminalDateFilter>>(() => {
    const periodWindow = periodToStageWindow(selectedPeriod);
    return { won: periodWindow, lost: periodWindow };
  }, [selectedPeriod]);

  const openStage = (column: DealBoardColumn) => {
    if (column.stage.slug === "pending_rfp") {
      // Preserve office context (?officeId=…) so a cross-office viewer stays in the same office.
      const qs = searchParams.toString();
      navigate(qs ? `/deals/pending-rfp?${qs}` : "/deals/pending-rfp");
      return;
    }
    navigate(buildDealStageNavigationPath(column, scope, stageNavTerminalFilters, searchParams));
  };

  useEffect(() => {
    setDrilldownPage(1);
  }, [drilldownDeals.length, search, searchParams]);

  // Synced top scrollbar proxy (matches /pipeline pattern).
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const innerWidthSpacerRef = useRef<HTMLDivElement>(null);
  const isSyncingScrollRef = useRef(false);

  useLayoutEffect(() => {
    const main = mainScrollRef.current;
    const spacer = innerWidthSpacerRef.current;
    if (!main || !spacer) return;
    const sync = () => {
      spacer.style.width = `${main.scrollWidth}px`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(main);
    for (const child of Array.from(main.children)) {
      observer.observe(child);
    }
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [columns.length, loading]);

  const handleMainScroll = () => {
    if (isSyncingScrollRef.current) {
      isSyncingScrollRef.current = false;
      return;
    }
    const main = mainScrollRef.current;
    const top = topScrollRef.current;
    if (!main || !top) return;
    if (top.scrollLeft !== main.scrollLeft) {
      isSyncingScrollRef.current = true;
      top.scrollLeft = main.scrollLeft;
    }
  };

  const handleTopScroll = () => {
    if (isSyncingScrollRef.current) {
      isSyncingScrollRef.current = false;
      return;
    }
    const main = mainScrollRef.current;
    const top = topScrollRef.current;
    if (!main || !top) return;
    if (main.scrollLeft !== top.scrollLeft) {
      isSyncingScrollRef.current = true;
      main.scrollLeft = top.scrollLeft;
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-red">
            {dashboardView.eyebrow}
          </p>
          <h1 className="mt-2 text-4xl font-black uppercase leading-none tracking-tight text-slate-950">
            {dashboardView.title}
          </h1>
          <p className="mt-2 max-w-2xl text-sm font-medium text-slate-500">
            {dashboardView.subtitle}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={selectedRepId} onValueChange={(value) => updateSelectedRep(value ?? "__all__")}>
            <SelectTrigger className="h-10 w-[13rem] bg-white">
              <SelectValue placeholder="All reps">{selectedRepLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All reps</SelectItem>
              {assignees.map((assignee) => (
                <SelectItem key={assignee.id} value={assignee.id}>
                  {assignee.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedPeriod ?? "__all__"} onValueChange={(value) => updatePeriod(value ?? "__all__")}>
            <SelectTrigger className="h-10 w-[11rem] bg-white" aria-label="Period">
              <SelectValue placeholder="All time">{getDashboardPeriodLabel(selectedPeriod)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All time</SelectItem>
              {PERIOD_OPTIONS.map((period) => (
                <SelectItem key={period} value={period}>
                  {getDashboardPeriodLabel(period)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ScopeToggle options={scopeOptions} value={scope} onChange={updateScope} ariaLabel="Deal scope" />
          <Button onClick={() => navigate("/deals/service-opportunity/new")} className="bg-brand-red text-white hover:bg-brand-red/90">
            <Plus className="mr-2 h-4 w-4" />
            New Service Opportunity
          </Button>
        </div>
      </section>

      <>
      <div className={`grid gap-4 ${showWonKpiCard ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        <MetricCard
          eyebrow="Active pipeline"
          value={USD_COMPACT(totalValue)}
          badge={`${totalCount}/${totalVisibleCount} deals`}
          caption="Open board"
          tone="white"
          accent="red"
          to={activePipelineDestination}
          ariaLabel="View active pipeline deals"
        />
        {showWonKpiCard ? (
          <MetricCard
            eyebrow="Won"
            value={USD_COMPACT(wonValue)}
            badge="Bid Board"
            caption={wonCaption}
            tone="blue"
            accent="blue"
            to={wonDestination}
            ariaLabel="View won deals"
          />
        ) : null}
        <MetricCard
          eyebrow="At risk"
          value={String(unsearchedOverSlaCount)}
          badge="Over SLA"
          caption="Needs touch"
          tone={unsearchedOverSlaCount > 0 ? "red" : "green"}
          accent="red"
          to={atRiskDestination}
          ariaLabel="View at-risk deals"
        />
      </div>

      <label className="block">
        <span className="sr-only">Search deals</span>
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search deals"
            className="pl-9"
          />
        </div>
      </label>

      {error ? (
        <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
          {error}
        </div>
      ) : null}

      <section
        className="relative flex h-[min(72vh,56rem)] min-h-[42rem] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"
        aria-label="Deals kanban board"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
          <Briefcase className="h-4 w-4 text-brand-red" />
          Kanban board
          <ArrowRight className="ml-1 h-3 w-3 text-slate-400" />
          <span className="text-slate-500">Click a card to open detail</span>
        </div>
        {loading ? (
          <div className="p-6 text-sm font-semibold text-slate-500">Loading deal board...</div>
        ) : (
          <>
            <div
              ref={topScrollRef}
              onScroll={handleTopScroll}
              className="flex-shrink-0 overflow-x-auto overflow-y-hidden border-b border-slate-100"
              aria-hidden="true"
            >
              <div ref={innerWidthSpacerRef} style={{ height: 1 }} />
            </div>
            <div
              ref={mainScrollRef}
              onScroll={handleMainScroll}
              className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <div className="flex h-full gap-3 p-4" style={{ minWidth: "max-content" }}>
                {columns.map((column) => (
                  <DealsBoardColumn
                    key={`${column.stage.id}-${column.stage.slug}`}
                    column={column}
                    onOpenStage={openStage}
                    onOpenRecord={(id) => navigate(`/deals/${id}`)}
                    periodValue={
                      isTerminalOutcomeSlug(column.stage.slug) ? selectedPeriod ?? "__all__" : undefined
                    }
                    onPeriodChange={
                      isTerminalOutcomeSlug(column.stage.slug) ? updatePeriod : undefined
                    }
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      {dashboardView.showEmbeddedList ? (
        <>
          {isAtRiskDrilldown ? (
            <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
              Drill-down view: SLA filter applied to list and board.
            </section>
          ) : null}
          {isAtRiskDrilldown && !loading ? (
            <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-end justify-between gap-4 border-b border-slate-100 pb-4">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{dashboardView.eyebrow}</p>
                  <h2 className="mt-2 text-2xl font-black uppercase tracking-tight text-slate-950">{dashboardView.title}</h2>
                  <p className="mt-1 text-sm font-medium text-slate-500">{dashboardView.subtitle}</p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Filtered results</p>
                  <p className="mt-1 text-2xl font-black text-slate-950">{drilldownDeals.length}</p>
                </div>
              </div>
              <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(7rem,0.65fr)_minmax(7rem,0.65fr)_minmax(5.5rem,0.55fr)] gap-4 border-b border-slate-100 px-1 py-3 text-[10px] font-black uppercase tracking-[0.16em] text-slate-500 lg:grid">
                <span>Project</span>
                <span>Stage</span>
                <span>Project owner</span>
                <span>Time in stage</span>
                <span>Last updated</span>
                <span className="text-right">Value</span>
              </div>
              <div className="divide-y divide-slate-100">
                {paginatedDrilldownDeals.map((deal) => (
                  <button
                    key={deal.id}
                    type="button"
                    onClick={() => navigate(`/deals/${deal.id}`)}
                    aria-label={`Open project ${deal.name}; stage ${deal.boardStageName}; project owner ${dealOwnerLabel(deal)}; time in stage ${stageAgeDaysLabel(deal)}; last updated ${formatDateInput(new Date(deal.updatedAt))}; value ${USD_COMPACT(moneyValue(deal))}`}
                    className="grid w-full grid-cols-2 items-start gap-x-4 gap-y-3 px-1 py-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-red/40 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(7rem,0.65fr)_minmax(7rem,0.65fr)_minmax(5.5rem,0.55fr)] lg:items-center"
                  >
                    <div className="col-span-2 min-w-0 lg:col-span-1">
                      <p className="truncate text-sm font-black text-slate-950">{deal.name}</p>
                    </div>
                    <div className="min-w-0">
                      <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500 lg:hidden">Stage</span>
                      <p className="mt-1 truncate text-xs font-bold uppercase tracking-[0.1em] text-slate-600 lg:mt-0">{deal.boardStageName}</p>
                    </div>
                    <div className="min-w-0">
                      <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500 lg:hidden">Project owner</span>
                      <p className="mt-1 truncate text-sm font-semibold text-slate-700 lg:mt-0">{dealOwnerLabel(deal)}</p>
                    </div>
                    <div>
                      <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500 lg:hidden">Time in stage</span>
                      <p className="mt-1 text-sm font-semibold text-slate-500 lg:mt-0">{stageAgeDaysLabel(deal)} in stage</p>
                    </div>
                    <div>
                      <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500 lg:hidden">Last updated</span>
                      <p className="mt-1 text-sm font-semibold text-slate-500 lg:mt-0">{formatDateInput(new Date(deal.updatedAt))}</p>
                    </div>
                    <div className="col-span-2 lg:col-span-1 lg:text-right">
                      <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500 lg:hidden">Value</span>
                      <p className="mt-1 text-sm font-black text-slate-950 lg:mt-0">{USD_COMPACT(moneyValue(deal))}</p>
                    </div>
                  </button>
                ))}
                {paginatedDrilldownDeals.length === 0 ? (
                  <div className="px-1 py-8 text-sm font-semibold text-slate-500">No deals match this SLA drill-down.</div>
                ) : null}
              </div>
              {drilldownTotalPages > 1 ? (
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
                  <p className="text-sm font-medium text-slate-500">
                    Page {drilldownPage} of {drilldownTotalPages}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" onClick={() => setDrilldownPage((page) => Math.max(1, page - 1))} disabled={drilldownPage <= 1}>
                      Previous
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setDrilldownPage((page) => Math.min(drilldownTotalPages, page + 1))} disabled={drilldownPage >= drilldownTotalPages}>
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : isAtRiskDrilldown ? (
            <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <div className="text-sm font-semibold text-slate-500">Loading SLA drill-down...</div>
            </section>
          ) : dashboardView.filter === null ? (
            // BASE /deals view: the SAME shared FilterBar as /pipeline's working list (signed-off shape).
            // Inherits Scope (page toggle) + Rep (header → baseFilters); the header's Estimate-Sent stays
            // a cards/board control and is intentionally NOT layered here (decoupled — the list's date
            // axis is the FilterBar's outcome-aware Date). dl_-namespaced so list filters never collide
            // with the header's bare ?assignedRepId/?scope/?period. Drill-downs keep the legacy list below
            // (YELLOW's surface, untouched). Cards + read-only board above are unchanged.
            <DealsListSection
              workflowFamily="deal"
              scope={scope}
              enableExport
              // Running-total card (#4): the summed effective value of the WHOLE filtered set across all
              // pages (server SUM over the list's exact WHERE), so it updates live as filters narrow and
              // can never disagree with the list. Frontend-only flip — the includeValueTotal aggregate is
              // surface-agnostic, computed only when a mount opts in via showValueTotal.
              showValueTotal
              pageSize={20}
              title={dashboardView.title}
              subtitle={dashboardView.subtitle}
              eyebrow={dashboardView.eyebrow}
              // Inherit the header Rep AND the header ?period window (outcome-aware dateFrom/dateTo) as the
              // list baseline, so the top period scopes cards+board+list together. The FilterBar's own Date
              // then narrows the list WITHIN it: the section intersects baseFilters' date with the bar's via
              // laterDate/earlierDate (the merged date-floor), so the bar Date can't widen past ?period — the
              // same nesting model as Rep (period control).
              baseFilters={
                selectedRepFilter || selectedPeriodRange?.from || selectedPeriodRange?.to
                  ? {
                      ...(selectedRepFilter ? { assignedRepId: selectedRepFilter } : {}),
                      ...(selectedPeriodRange?.from ? { dateFrom: selectedPeriodRange.from } : {}),
                      ...(selectedPeriodRange?.to ? { dateTo: selectedPeriodRange.to } : {}),
                    }
                  : undefined
              }
              // Preserve the base list's prior default ordering (updated_at desc) when no dl_sort is set,
              // so it still surfaces recently-touched deals first (Codex #589).
              initialSort={dashboardView.listInitialSort}
              // Gate the FilterBar mount on stage metadata: on a cold load usePipelineStages returns
              // stages:[], so dealsBaseListStageScope.defaultStageIds would be [] and the first request would
              // be unscoped/active-only. Until stages arrive, pass NO filterBar — the section stays in legacy
              // mode, which gates the query on stage loading (mirrors #590's drill-down gate) (Codex).
              filterBar={stages.length === 0 ? undefined : {
                // Nest the bar Rep within the header Rep: when the header is "All reps" the bar offers the
                // Rep dimension (narrow the list to one rep within the all-reps cards/board). When the
                // header PINS a concrete rep, drop the Rep dimension entirely — a bar Rep control could
                // only re-offer that same rep (a no-op) and would still surface an "Unassigned" option that
                // reconciliation clamps back to the pinned rep (misleading); the header owns it then
                // (Codex #589 P2).
                dimensions: selectedRepFilter
                  ? DEALS_BASE_LIST_FILTERBAR_DIMENSIONS.filter((dimension) => dimension !== "rep")
                  : DEALS_BASE_LIST_FILTERBAR_DIMENSIONS,
                paramPrefix: "dl_",
                options: {
                  reps: assignees.map((assignee) => ({ value: assignee.id, label: assignee.displayName })),
                  regions: regions.map((region) => ({ value: region.id, label: region.name })),
                  projectTypes: projectTypes.map((type) => ({ value: type.id, label: type.name })),
                  stages: boardColumns
                    // Exclude the synthetic Pending RFP column: its id ("canonical-pending_rfp") is not a
                    // real deals.stage_id, so offering it as a stage filter would send stageIds the server
                    // matches against nothing and return an empty list. Its deals stay reachable via the
                    // Opportunity option (they share that real stage_id) and the dedicated /deals/pending-rfp page.
                    .filter(
                      (column) =>
                        column.stage.slug !== "pending_rfp" && isBoardVisibleStage(column.stage.slug, true)
                    )
                    .map((column) => ({ value: column.stage.id, label: column.stage.name })),
                  sortOptions: DEAL_LIST_SORT_OPTIONS,
                },
                // ENABLE_STAGE_ENTRY_DATE_FILTER is on in prod (matches /pipeline): open rows are
                // date-windowed, so Stalled is offered and the date axis is labeled outcome-aware.
                stageEntryDateEnabled: true,
                defaultStageIds: dealsBaseListStageScope.defaultStageIds,
                terminalStageIds: dealsBaseListStageScope.terminalStageIds,
                // Expand an explicit canonical stage pick to its full workflow-family (Codex #589 P1).
                stageIdFamilies: dealsBaseListStageScope.stageIdFamilies,
                // Seed the bar's default ordering (the base list's updated_at desc) when no dl_sort is set
                // — the shared component now seeds FilterBar-mode sort from filterBar.defaultSort (#590).
                defaultSort: dashboardView.listInitialSort,
              }}
            />
          ) : (
            <DealsListSection
              workflowFamily="deal"
              scope={scope}
              enableExport
              // Running-total card (#4) on the dashboard drill-down lists (Won / Active / Bid Board …) too.
              showValueTotal
              enableDateFilter={false}
              showFilterButton
              pageSize={20}
              searchPlaceholder="Search deals or accounts"
              title={dashboardView.title}
              subtitle={dashboardView.subtitle}
              eyebrow={dashboardView.eyebrow}
              visibleStages={drilldownVisibleStages}
              baseFilters={drilldownFilterBar ? drilldownListBaseFilters : layeredListBaseFilters}
              filterBar={drilldownFilterBar}
              dateField={dashboardView.listDateField}
              initialSort={dashboardView.listInitialSort}
              initialStageSlugs={dashboardView.initialStageSlugs}
              lockedOwnerId={selectedRepFilter}
              hideOwnerFilter
              paginationCountSummary={
                dashboardView.filter === "active" || dashboardView.filter === "active_pipeline"
                  ? { active: totalCount, total: totalVisibleCount }
                  : undefined
              }
            />
          )}
        </>
      ) : (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          The filtered board above is the source of truth for this dashboard drill-down. The paginated deal list is hidden here because the
          current deal-list API does not expose stale or at-risk filters without changing the protected deals service.
        </section>
      )}
      </>
    </div>
  );
}
