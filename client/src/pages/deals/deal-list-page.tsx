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
import { TerminalDateFilterControl } from "@/components/pipeline/terminal-date-filter-control";
import {
  buildDealStageWorkspacePath,
  clampDateToToday,
  daysAgo,
  getActivePipelineColumns,
  getTerminalDateFilterLabel,
  isTerminalStage,
  isTerminalOutcomeSlug,
  readTerminalDateFiltersFromSearchParams,
  resolveDatePreset,
  setTerminalDateFilterSearchParams,
  toDatePresetRange,
  writeTerminalDateFilter,
  type TerminalDateFilter,
  type TerminalOutcome,
} from "@/lib/pipeline-terminal-filters";
import type { PipelineScope } from "@/lib/pipeline-scope";
import { KanbanScrollColumn } from "@/components/deals/kanban-scroll-column";
import { DecoratedKanbanCard } from "@/components/deals/decorated-kanban-card";
import { DealsListSection } from "@/components/deals/deals-list-section";
import { buildDrilldownListFilterBar } from "@/components/deals/deals-filterbar-adapter";
import type { DealFilters } from "@/hooks/use-deals";
import type { DealListSortState } from "@/components/deals/deals-list-section";
import { resolvePreferredScope, writeStoredScopePreference } from "@/lib/scope-preferences";

// Team scope is parked (PR #512) and not configured anywhere, so it is not offered here
// -- only Mine | All (mirrors the director dashboard). The shared PipelineScope union still
// includes "team" for URL coercion (see DealListPage); do not change it.
const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
] as const satisfies readonly ScopeToggleOption<PipelineScope>[];

const SLA_DRILLDOWN_PREVIEW_LIMIT = 1000;

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

// D-7: a Won/period drill-down arrives as ?filter=won&period=qtd with NO explicit won_* param,
// so the Won terminal filter would default to "all" — the column's date chip then reads "All time"
// while the data is windowed by won_period (the contradictory all_time+period the audit flagged).
// Seed the Won filter FROM the inherited period instead, so the chip reads "QTD" and the board
// request emits won_since/until via the preset (never won_all_time). An explicit won_* in the URL
// always wins (the user's own choice, e.g. after changing the chip).
export function resolveDrilldownTerminalDateFilters(
  params: URLSearchParams,
  now = new Date()
): Record<TerminalOutcome, TerminalDateFilter> {
  const base = readTerminalDateFiltersFromSearchParams(params);
  const period = normalizeDashboardPeriod(params.get("period"));
  if (!period) return base;
  const isWonDrilldown = normalizeDashboardDealFilter(params.get("filter")) === "won";
  const hasExplicitWon =
    params.has("won_preset") || params.has("won_all_time") || params.has("won_since");
  const hasExplicitLost =
    params.has("lost_preset") || params.has("lost_all_time") || params.has("lost_since");
  const result = { ...base };
  // Won column: seed from the period ONLY on the Won drill-down (the surface D-7 flags); other views keep
  // the Won column current-state and let won_period window the board-wide aggregate.
  if (isWonDrilldown && !hasExplicitWon) {
    result.won = periodToTerminalDateFilter(period, now);
  }
  // Lost column: the header period must window it too. won_period covers Won + open columns server-side,
  // but the Lost column reads lost_since/lost_until — so seed it from the period whenever ?period is set
  // and no explicit Lost filter is present, or Lost shows all-time under a board-wide period (Codex #600 P2).
  if (!hasExplicitLost) {
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
      subtitle:
        filter === "stale"
          ? period
            ? `Open-stage deals past their stage SLA for ${periodLabel}.`
            : "Open-stage deals past their stage SLA."
          : period
            ? `Open-stage deals over SLA and needing attention for ${periodLabel}.`
            : "Open-stage deals over SLA and needing attention.",
      boardMode: "at_risk",
      listBaseFilters: periodRange
        ? {
            updatedFrom: periodRange.from,
            updatedTo: periodRange.to,
          }
        : {},
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
    subtitle: "KPIs and drill-downs over your deals. Use Pipeline for the kanban + filterable working list.",
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
  const scope = searchParams.get("scope");
  if (scope === "mine" || scope === "team" || scope === "all") return scope;
  return "mine";
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
        // the SLA drill-downs: getDashboardDealListView turns ?period into updatedFrom/updatedTo, which the
        // at-risk/stale lists filter via matchesUpdatedRange — a different axis than the SLA card's count, so
        // carrying period there drops at-risk deals the card counted but that weren't updated in the window
        // (cohort mismatch, Codex #600 P2).
        (key === "period" && filter !== "at_risk" && filter !== "stale") ||
        (filter === "won" && key.startsWith("won_"))
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

function isEngineAtRiskDeal(deal: Deal) {
  return deal.atRisk?.isAtRisk === true && deal.atRisk.status === "at_risk";
}

function stageAgeDaysLabel(deal: Deal) {
  return deal.atRisk ? `${deal.atRisk.effectiveStageAgeDays}d` : "N/A";
}

function compareDrilldownDeals(left: DrilldownListRow, right: DrilldownListRow, sort: DealListSortState) {
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
  terminalFilter,
  onTerminalFilterChange,
}: {
  column: DealBoardColumn;
  onOpenStage: (column: DealBoardColumn) => void;
  onOpenRecord: (id: string) => void;
  terminalFilter?: TerminalDateFilter;
  onTerminalFilterChange?: (filter: TerminalDateFilter) => void;
}) {
  const totalValue =
    column.totalValue ?? sumNonOnHoldDealValues(column.cards);
  const terminalOutcome = isTerminalOutcomeSlug(column.stage.slug) ? column.stage.slug : null;
  const terminalLabel = terminalFilter ? getTerminalDateFilterLabel(terminalFilter) : null;
  const emptyText = terminalOutcome && terminalFilter?.preset !== "all" ? "No deals in selected range" : "No deals";

  const header = (
    <>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="truncate text-left text-xs font-medium uppercase tracking-wide text-gray-500 hover:text-gray-900"
          onClick={() => onOpenStage(column)}
        >
          {column.stage.name}
          {terminalLabel ? <span className="ml-1 text-slate-400">· {terminalLabel}</span> : null}
        </button>
        <span className="rounded-sm bg-gray-200/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-gray-600">
          {column.count}/{column.totalCount ?? column.count}
        </span>
      </div>
      {terminalOutcome && terminalFilter && onTerminalFilterChange ? (
        <TerminalDateFilterControl
          stageName={column.stage.name}
          filter={terminalFilter}
          onFilterChange={onTerminalFilterChange}
          className="mt-2"
          buttonClassName="rounded-sm text-xs"
          inputClassName="rounded-sm text-xs"
        />
      ) : null}
      <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900">
        {USD_COMPACT(totalValue)}
      </p>
    </>
  );

  return (
    <KanbanScrollColumn header={header} childCount={column.cards.length}>
      {column.cards.length > 0 ? (
        column.cards.map((deal) => (
          <DecoratedKanbanCard
            key={deal.id}
            deal={deal}
            stageSlug={column.stage.slug}
            onClick={() => onOpenRecord(deal.id)}
          />
        ))
      ) : (
        <div className="border border-dashed border-gray-200 py-8 text-center text-xs text-gray-400">
          {emptyText}
        </div>
      )}
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
    isAtRiskDrilldown ? SLA_DRILLDOWN_PREVIEW_LIMIT : 8,
    selectedPeriodRange,
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

  // The Estimate-Sent control was replaced by the header Period dropdown. Strip any stale estimate_sent_*
  // params from the URL on load so a bookmarked/shared link can neither invisibly filter the board (the
  // range is no longer read here) NOR be forwarded into a stage-page drill-down — which still passes the
  // full searchParams and would otherwise apply an invisible, control-less filter there (Codex #600 P2).
  useEffect(() => {
    const stale = [...searchParams.keys()].filter((key) => key.startsWith("estimate_sent_"));
    if (stale.length === 0) return;
    const next = new URLSearchParams(searchParams);
    for (const key of stale) next.delete(key);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const updateTerminalDateFilter = useCallback((outcome: TerminalOutcome, filter: TerminalDateFilter) => {
    writeTerminalDateFilter(outcome, filter);
    setTerminalDateFilters((current) => ({ ...current, [outcome]: filter }));
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      setTerminalDateFilterSearchParams(next, outcome, filter);
      return next;
    });
  }, [setSearchParams]);

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
  const updatePeriod = useCallback((value: string) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === "__all__") next.delete("period");
    else next.set("period", value);
    // Write ?period AND the period-derived terminal (Won/Lost) filters in LOCKSTEP. If we only wrote
    // ?period and let the boardParamKey effect re-sync terminalDateFilters a render later, the board would
    // fire one fetch with the NEW won_period_from/to but STALE lost_since/until (and stale Won filters) — a
    // mixed window; useDealBoard does not cancel or order responses, so that stale fetch could win and leave
    // the board/cards on a blended date range (Codex #600 P2).
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
      const { updatedFrom, updatedTo } = dashboardView.listBaseFilters;
      const sourceColumns =
        dashboardView.boardStageSlugs.length > 0
          ? boardColumns.filter((column) => dashboardView.boardStageSlugs.includes(column.stage.slug))
          : dashboardView.boardMode === "active"
          ? boardColumns.filter((column) => !isTerminalStage(column.stage.slug))
          : dashboardView.boardMode === "won"
            ? boardColumns.filter((column) => column.stage.slug === "won")
            : dashboardView.boardMode === "at_risk"
              ? boardColumns
                  .filter((column) => !isTerminalStage(column.stage.slug))
                  .map((column) => {
                    const cards = column.cards.filter((deal) => {
                      return isEngineAtRiskDeal(deal) && matchesUpdatedRange(deal, updatedFrom, updatedTo);
                    });
                    return {
                      ...column,
                      totalCount: cards.length,
                      count: cards.filter((deal) => !deal.onHold).length,
                      cards,
                      totalValue: sumNonOnHoldDealValues(cards),
                    };
                  })
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
          return {
            ...column,
            totalCount: cards.length,
            count: cards.filter((deal) => !deal.onHold).length,
            cards,
            totalValue: sumNonOnHoldDealValues(cards),
          };
        });
    },
    [boardColumns, dashboardView.boardMode, dashboardView.boardStageSlugs, dashboardView.listBaseFilters, search]
  );
  const unsearchedColumns = useMemo(() => {
    const { updatedFrom, updatedTo } = dashboardView.listBaseFilters;
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
      return boardColumns
        .filter((column) => !isTerminalStage(column.stage.slug))
        .map((column) => {
          const cards = column.cards.filter((deal) => {
            return isEngineAtRiskDeal(deal) && matchesUpdatedRange(deal, updatedFrom, updatedTo);
          });
          return {
            ...column,
            totalCount: cards.length,
            count: cards.filter((deal) => !deal.onHold).length,
            cards,
            totalValue: sumNonOnHoldDealValues(cards),
          };
        });
    }
    return boardColumns;
  }, [boardColumns, dashboardView.boardMode, dashboardView.boardStageSlugs, dashboardView.listBaseFilters]);
  const activePipelineColumns = getActivePipelineColumns(boardColumns);
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
  const totalCount = activePipelineColumns.reduce((sum, column) => sum + column.count, 0);
  const totalVisibleCount = activePipelineColumns.reduce((sum, column) => sum + (column.totalCount ?? column.count), 0);
  const totalValue = activePipelineColumns.reduce((sum, column) => sum + column.totalValue, 0);
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
  const activePipelineDestination = buildDealsPageKpiDrilldownPath("active_pipeline", scope, undefined, {
    queryParams: searchParams,
  });
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

  const openStage = (column: DealBoardColumn) => {
    navigate(buildDealStageNavigationPath(column, scope, terminalDateFilters, searchParams));
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
                    terminalFilter={
                      isTerminalOutcomeSlug(column.stage.slug)
                        ? terminalDateFilters[column.stage.slug]
                        : undefined
                    }
                    onTerminalFilterChange={
                      isTerminalOutcomeSlug(column.stage.slug)
                        ? (filter) => updateTerminalDateFilter(column.stage.slug as TerminalOutcome, filter)
                        : undefined
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
              <div className="divide-y divide-slate-100">
                {paginatedDrilldownDeals.map((deal) => (
                  <button
                    key={deal.id}
                    type="button"
                    onClick={() => navigate(`/deals/${deal.id}`)}
                    className="grid w-full gap-3 px-1 py-4 text-left transition-colors hover:bg-slate-50 md:grid-cols-[minmax(0,1.4fr)_auto_auto_auto]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-slate-950">{deal.name}</p>
                      <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{deal.boardStageName}</p>
                    </div>
                    <p className="text-sm font-semibold text-slate-500">{stageAgeDaysLabel(deal)} in stage</p>
                    <p className="text-sm font-semibold text-slate-500">{formatDateInput(new Date(deal.updatedAt))}</p>
                    <p className="text-sm font-black text-slate-950">{USD_COMPACT(moneyValue(deal))}</p>
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
                    .filter((column) => isBoardVisibleStage(column.stage.slug, true))
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
