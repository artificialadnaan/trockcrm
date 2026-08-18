import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Briefcase, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import { USD_COMPACT } from "@/components/shared/formatters";
import { useDealBoard, type Deal, type DealBoardColumn } from "@/hooks/use-deals";
import { usePipelineStages, useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import { useRepRoster } from "@/hooks/use-rep-roster";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { buildRepFilterOptions } from "@/lib/rep-filter-options";
import { buildCanonicalDealBoardColumns, buildCanonicalDealStageFamilies } from "@/lib/canonical-deal-board";
import { isBoardVisibleStage, DEAL_LIST_SORT_OPTIONS } from "@/components/deals/deals-filterbar-adapter";
import type { FilterDimension } from "@/components/filters/filter-bar";
import { useAuth } from "@/lib/auth";
import { formatDealDisplayName } from "@/lib/deal-utils";
import { getEffectiveDealValue, isServiceProjectDeal, WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import {
  buildDealStageWorkspacePath,
  clampDateToToday,
  daysAgo,
  getActivePipelineColumns,
  isTerminalStage,
  isTerminalOutcomeSlug,
  resolveDatePreset,
  terminalDateFiltersEqual,
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
  isBareDealsView,
  readStoredDealView,
  writeStoredDealView,
} from "@/lib/deals-view-preferences";

// Team scope is parked (PR #512) and not configured anywhere, so it is not offered here. The pills are
// Mine | All plus the two deals-only filter pseudo-scopes Watched and On Hold. "On Hold" matches deals
// that are explicitly held OR have a hold horizon date more than 90 days out (effectiveOnHoldSqlPredicate) —
// that horizon is the close target in every stage except estimating, where it is the bid due date. The shared
// PipelineScope union still includes "team" for URL coercion (see DealListPage); do not change it.
const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
  { value: "watched", label: "Watched" },
  { value: "on_hold", label: "On Hold" },
] as const satisfies readonly ScopeToggleOption<PipelineScope>[];

/**
 * The AT-RISK DRILL-DOWN still asks for the server maximum, and has to.
 *
 * That view's LIST is built by flattening the board's cards and paginating them client-side
 * (`drilldownDeals`), so unlike the board its rows genuinely are the card array. It is also a deliberate
 * click-through rather than the default page load, so its cost is paid once, on purpose. If this ever
 * needs to come down, the prerequisite is a server-side at-risk ROW feed, not a smaller number here.
 */
const SLA_DRILLDOWN_PREVIEW_LIMIT = 1000;
/**
 * How many cards the BOARD loads per column — deliberately a slice, not the whole column.
 *
 * It used to be 1000 (the server maximum). With includeDd the board answers 12 columns, each selecting
 * all 153 deal columns, so a single load could ship several thousand full deal rows — measured at
 * 1.6–2.5s per request in production, and the page issues this request more than once.
 *
 * ORDERING — read this before assuming the slice is "the top 50". buildPipelineStageCardsOrder sorts by
 * [billing-attention on Won], then the active/non-zero liveness TIER, then `created_at DESC`, then
 * `id DESC`. Effective value enters only as that 0/1 tier, never as a magnitude. So the slice is the 50
 * NEWEST live deals, and a column's largest-value deals can be entirely absent from it while the header
 * total still counts them. Keeping that order was a deliberate product call — it is the order reps see
 * every day — which makes the "view all" escape hatch load-bearing rather than decorative: it is the
 * only route to the deals the slice hides. It must therefore render whenever the column has more rows
 * than cards, and its denominator must describe the same population the cards came from.
 *
 * What does NOT change: every NUMBER on the page. Column count/total come from backend aggregates and
 * always did; the At-Risk KPI counts and the Pending RFP column now come from `boardSummary`, computed
 * server-side over every matching row. The one honest trade-off is the board's client-side text search,
 * which filters the cards in memory and therefore searches this slice — the list below the board
 * searches server-side over everything.
 */
const BOARD_CARDS_PER_STAGE_LIMIT = 50;
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
  | "at_risk_service"
  | "at_risk_non_service"
  | "opportunities"
  | "bid_board"
  | null;

/**
 * The workflow-route split of the at-risk cohort, shared by the three At-Risk KPI cards and by the
 * drill-down each one links to.
 *
 * "service" is `deals.workflow_route === "service"`. "non_service" is its exact complement — which
 * DELIBERATELY includes a deal whose route is null/absent. The column is `.default("normal").notNull()`
 * so a real row always has a route, but the client `Deal` type still declares `workflowRoute` as
 * `WorkflowRoute | null` (a payload could omit it). A route-less deal is NOT service, so it belongs on
 * the non-service side; putting it in neither bucket would silently break Service + Non-service === All.
 */
export type AtRiskRouteBucket = "all" | "service" | "non_service";

/** The three at-risk cohorts. Service + Non-service partition All exactly. */
export const AT_RISK_ROUTE_BUCKETS = ["service", "non_service", "all"] as const satisfies readonly AtRiskRouteBucket[];

/** The two ROUTE cohorts, in the order they read as sub-links under the At Risk headline. */
export const AT_RISK_ROUTE_SUBLINK_BUCKETS = ["service", "non_service"] as const satisfies readonly AtRiskRouteBucket[];

/**
 * A deal is on the SERVICE side when the PLATFORM's definition says so — project type first, the route
 * only as a fallback. Delegates to the shared `isServiceProjectDeal` so this page and the reports cannot
 * answer the same question differently.
 *
 * This used to test `workflowRoute === "service"` alone. That column is NOT NULL DEFAULT 'normal' and
 * nothing derived it from the project type, so it put deals whose own numbers read DFW-4-… (4 IS the
 * service code) on the non-service side of this split — while the Monday Showcase, fixed first, counted
 * them as service. Two surfaces, same words, different answers.
 */
export function isServiceRouteDeal(deal: Pick<Deal, "workflowRoute" | "projectType" | "projectTypeCode">): boolean {
  return isServiceProjectDeal(deal);
}

/**
 * The ONE route predicate every at-risk surface uses — the card counts, the kanban narrowing, and the
 * drill-down list all call this, so a card can never count a deal the list it links to would drop.
 * Total partition: every deal matches exactly one of "service" / "non_service", and always "all".
 */
export function matchesAtRiskRouteBucket(
  deal: Pick<Deal, "workflowRoute" | "projectType" | "projectTypeCode">,
  bucket: AtRiskRouteBucket
): boolean {
  if (bucket === "all") return true;
  return isServiceRouteDeal(deal) === (bucket === "service");
}

/**
 * The two halves of the card↔list contract, and inverses of each other: a card links to
 * `atRiskFilterForRouteBucket(bucket)`, and the destination re-derives the SAME bucket from that
 * ?filter via `atRiskRouteBucketForFilter`. Keeping the mapping in one round-trippable pair is what
 * makes "the number on the card" and "the rows on the page it opens" the same set by construction.
 */
export function atRiskFilterForRouteBucket(
  bucket: AtRiskRouteBucket
): "at_risk" | "at_risk_service" | "at_risk_non_service" {
  if (bucket === "service") return "at_risk_service";
  if (bucket === "non_service") return "at_risk_non_service";
  return "at_risk";
}

export function atRiskRouteBucketForFilter(filter: DashboardDealListFilter): AtRiskRouteBucket {
  if (filter === "at_risk_service") return "service";
  if (filter === "at_risk_non_service") return "non_service";
  return "all";
}

/**
 * Copy per cohort — one source so the visible sub-link text and the accessible name agree.
 *
 * `shortLabel` is what the reader sees ("Service 3"); `ariaLabel` is the accessible name and must name
 * the COHORT, never just the number, so a screen-reader user hears which drill-down a link opens rather
 * than a bare "3". The three names are distinct for the same reason.
 */
export const AT_RISK_CARD_LABELS: Record<AtRiskRouteBucket, { shortLabel: string; ariaLabel: string }> = {
  service: { shortLabel: "Service", ariaLabel: "View service at-risk deals" },
  non_service: { shortLabel: "Non-service", ariaLabel: "View non-service at-risk deals" },
  all: { shortLabel: "All", ariaLabel: "View at-risk deals" },
};

/**
 * The SLA drill-downs are CURRENT-STATE views where ?period is a deliberate no-op (see
 * getDashboardDealListView / buildDealsPageKpiDrilldownPath). All three at-risk routes share that
 * property with "stale" — splitting the card by workflow route changes WHICH deals are shown, never
 * the date axis.
 */
export function isCurrentStateDrilldownFilter(filter: DashboardDealListFilter): boolean {
  return filter === "stale" || filter === "at_risk" || filter === "at_risk_service" || filter === "at_risk_non_service";
}

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
    case "at_risk_service":
    case "at-risk-service":
      return "at_risk_service";
    case "at_risk_non_service":
    case "at-risk-non-service":
      return "at_risk_non_service";
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

  if (isCurrentStateDrilldownFilter(filter)) {
    // The three at-risk routes are the SAME cohort narrowed by workflow route, so they share one branch:
    // identical boardMode / base filters / sort, differing only in title+subtitle and in the route bucket
    // the page re-derives from `filter` (atRiskRouteBucketForFilter). Sharing the branch is what keeps the
    // route split from accidentally acquiring a second date axis or a second at-risk predicate.
    const atRiskTitle =
      filter === "at_risk_service"
        ? "Service Deals At Risk"
        : filter === "at_risk_non_service"
          ? "Non-service Deals At Risk"
          : "Deals At Risk";
    const atRiskSubtitle =
      filter === "at_risk_service"
        ? "Service-route open-stage deals over SLA and needing attention."
        : filter === "at_risk_non_service"
          ? "Non-service-route open-stage deals over SLA and needing attention."
          : "Open-stage deals over SLA and needing attention.";
    return {
      filter,
      eyebrow: "Dashboard drill-down",
      title: filter === "stale" ? "Stale Deals" : atRiskTitle,
      // "Stale"/"Deals At Risk" are CURRENT-STATE views — ?period is a deliberate no-op here. Period-
      // windowing by updated_at would hide the stalest (least-recently-touched, i.e. MOST at-risk) deals,
      // which is backwards for an SLA surface. So the subtitle never claims a period, and listBaseFilters
      // carries no updated-at window — the card, kanban, list, and link all show the full current cohort.
      // The route split inherits this unchanged: it narrows WHICH deals, never the date axis.
      subtitle: filter === "stale" ? "Open-stage deals past their stage SLA." : atRiskSubtitle,
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
        // Office context is URL-driven: api() reads ?officeId from window.location.search and sends it as
        // x-office-id. A KPI card that drops it silently returns a cross-office viewer to their ACTIVE
        // office, so the drill-down lists a DIFFERENT office's deals than the card counted. Forward it on
        // every drill-down (this was missing for all of them — Active Pipeline and Won too, not just the
        // at-risk cards). Same-office users carry no ?officeId, so their links are unchanged.
        key === "officeId" ||
        // Keep the header period scope through outcome-aware drill-downs (active pipeline / Won), but NOT
        // the SLA drill-downs (at_risk / at_risk_service / at_risk_non_service / stale): those are
        // CURRENT-STATE views where ?period is a deliberate no-op (getDashboardDealListView gives them no
        // updated-at window — period-filtering an SLA surface by updated_at would hide the stalest, most
        // at-risk deals). So the link must NOT carry a period either. All THREE at-risk route cards share
        // this.
        //
        // KNOWN GAP (not fixed here): "omitting it keeps the destination matching the card" holds only
        // while ENABLE_STAGE_ENTRY_DATE_FILTER is OFF (its default). With that flag ON *and* a ?period
        // selected, getDealsForPipeline additionally bounds the OPEN columns by stage_entered_at, so the
        // board this page counts from is period-scoped while the destination it links to is not — the
        // destination can then hold MORE rows than the card shows. That affects the pre-existing "All at
        // risk" card exactly as it affects the two new route cards. Closing it needs an unwindowed count
        // source (a second board fetch, or dropping the board period), which changes what "All at risk"
        // displays — a product decision, deliberately left out of this change.
        // won_*/lost_* are NOT forwarded — the Won drill-down inherits the single shared ?period (already
        // set above), not a collapsed per-column override.
        (key === "period" && !isCurrentStateDrilldownFilter(filter))
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
 * These columns' count/value are recomputed from the column's CARDS, and that is now a DIFFERENT source
 * from the At-Risk KPI cards, which read the server's `boardSummary` (a count over every matching row).
 * The two agree only because this drill-down raises the request to SLA_DRILLDOWN_PREVIEW_LIMIT (1000),
 * so nothing is truncated at the volumes this board sees. The invariant is therefore NO LONGER
 * "reconciled by construction" — it RESTS ON that limit, and a stage that ever exceeded it would make
 * the kanban and the list under-count while the KPI above them stayed correct. The real fix, if that
 * becomes reachable, is a server-side at-risk ROW feed for this view, not a smaller number here.
 *
 * `routeBucket` narrows the SAME set by workflow route for the Service / Non-service drill-downs. The
 * at-risk predicate is untouched — this composes isEngineAtRiskDeal with matchesAtRiskRouteBucket, the
 * one route predicate the KPI counts also use, so a route drill-down can never show a different cohort
 * than the card that linked to it. The default "all" is byte-identical to the pre-split behaviour.
 */
export function getAtRiskBoardColumns(
  boardColumns: DealBoardColumn[],
  routeBucket: AtRiskRouteBucket = "all"
): DealBoardColumn[] {
  return boardColumns
    .filter((column) => !isTerminalStage(column.stage.slug))
    .map((column) =>
      recountColumnFromCards(
        column,
        column.cards.filter((deal) => isEngineAtRiskDeal(deal) && matchesAtRiskRouteBucket(deal, routeBucket))
      )
    );
}

/**
 * The At-Risk KPI card count for one route bucket, over whatever columns the current view shows.
 *
 * This is the ONE counter behind all three cards, and it applies exactly the pair of predicates
 * getAtRiskBoardColumns applies (terminal-column exclusion + isEngineAtRiskDeal + matchesAtRiskRouteBucket).
 * That is the reconciliation guarantee: the number rendered on a card and the rows on the drill-down the
 * card links to come from the same two predicates, not from two hand-rolled copies that can drift.
 *
 * Because matchesAtRiskRouteBucket is a total partition of the deals,
 *   count(cols,"service") + count(cols,"non_service") === count(cols,"all")
 * holds for ANY column set, by construction (asserted in at-risk-summary.runtime.test.ts).
 */
export function countAtRiskDeals(
  columns: DealBoardColumn[],
  routeBucket: AtRiskRouteBucket,
  /**
   * The server's per-canonical-column at-risk counts, computed over EVERY matching row. When present it
   * is authoritative: the card array is a capped slice, so counting it would under-report the moment a
   * column holds more deals than the board fetches. Omitted (older payload / unit tests without a
   * summary) falls back to the original card count, which is exact whenever nothing was truncated.
   */
  atRiskByStageSlug?: Record<string, { service: number; nonService: number }> | null
): number {
  return columns.reduce((sum, column) => {
    if (isTerminalStage(column.stage.slug)) return sum;
    const serverBucket = atRiskByStageSlug?.[column.stage.slug];
    if (serverBucket) {
      return (
        sum +
        (routeBucket === "service"
          ? serverBucket.service
          : routeBucket === "non_service"
            ? serverBucket.nonService
            : serverBucket.service + serverBucket.nonService)
      );
    }
    // A canonical column with no server entry has no at-risk rows at all (the server only emits a bucket
    // when it counted one) — EXCEPT when there is no summary, where this is the original card count.
    if (atRiskByStageSlug) return sum;
    return (
      sum +
      column.cards.filter((deal) => isEngineAtRiskDeal(deal) && matchesAtRiskRouteBucket(deal, routeBucket))
        .length
    );
  }, 0);
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
 *
 * On a ROUTE drill-down the card displays the route-narrowed at-risk set (the page feeds it the same
 * route-filtered columns the kanban renders), so it must link back to that same route — linking to the
 * unsplit `at_risk` would open a strictly larger set than the number printed on the card.
 */
export function activePipelineDrilldownFilter(
  boardMode: "all" | "active" | "won" | "at_risk",
  atRiskRouteBucket: AtRiskRouteBucket = "all"
): "at_risk" | "at_risk_service" | "at_risk_non_service" | "active_pipeline" {
  return boardMode === "at_risk" ? atRiskFilterForRouteBucket(atRiskRouteBucket) : "active_pipeline";
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
  //
  // `!== 0`, not `> 0` — the exact twin of the server tier, aliasedActiveNonZeroDealSortTierSql in
  // server/src/modules/shared/deal-value-sql.ts, which carries the full rationale. In short: the tier
  // demotes DEAD rows (parked or valueless), and a DEDUCTIVE change order is a live deal at a NEGATIVE
  // value, so it belongs in the top tier and sorts by whatever column the user asked for — including by
  // value, where being the smallest number already places it correctly in both directions.
  const tierOf = (deal: DrilldownListRow) => (!deal.onHold && moneyValue(deal) !== 0 ? 0 : 1);
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
  const visibleCardCount = column.cards.length;
  /**
   * The population the CARDS were drawn from — every matching row, on-hold included.
   *
   * NOT `count`: that is the ACTIVE figure (the server filters `COALESCE(on_hold,false)=false`) while
   * the card query applies no on-hold filter. Comparing cards against `count` made a truncated column
   * look complete whenever enough of it was on hold — 70 rows with 25 held gives count=45 against 50
   * cards, `50 < 45` is false, no "view all", 20 deals unreachable. Falling back to `count` at all is a
   * last resort for a payload without a total; `Math.max` keeps the notice from ever claiming fewer
   * rows than it is visibly rendering.
   */
  const cardPopulationCount =
    column.totalCount === undefined ? undefined : Math.max(column.totalCount, visibleCardCount);
  /** What the "view all" target will list; undefined when that target's size is unknowable (Pending RFP). */
  const drilldownTotalCount = column.drilldownTotalCount;
  /**
   * Only claim truncation when the row total is KNOWN. An API that does not send totalCount leaves this
   * undefined, and inventing a denominator from `count` is the exact bug the notice exists to fix — so
   * the notice stays hidden rather than quoting a number that might be wrong. That window is also the
   * one where the board stops truncating at all (see the preview-limit latch on DealListPageContent),
   * so there is nothing to escape from.
   */
  const isTruncated = cardPopulationCount !== undefined && visibleCardCount < cardPopulationCount;
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
      {/*
        The board loads a SLICE of each column (BOARD_CARDS_PER_STAGE_LIMIT), so a column holding more
        has to say so rather than look complete at N cards. The header count above already shows the true
        total; this names the gap and opens the stage drill-down, which is paginated, sortable and
        filterable over the full set. Mirrors the same affordance on the shared pipeline board column.
      */}
      {isTruncated ? (
        <button
          type="button"
          className="mt-1 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900"
          onClick={() => onOpenStage(column)}
        >
          {/*
            Two shapes, because the destination is not always countable. A stage drill-down lists
            `drilldownTotalCount` rows, so the link may name it. The Pending RFP column instead opens the
            office-wide CROSS-REP queue while this column is scope-filtered (PR #834) — naming a number
            there would promise a set size the board cannot know, so it names none.
          */}
          Showing {visibleCardCount} of {cardPopulationCount}
          {drilldownTotalCount != null ? ` — view all ${drilldownTotalCount}` : " — open full queue"}
        </button>
      ) : null}
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

  return <DealListPageContent role={user.role} userId={user.id} activeOfficeId={user.activeOfficeId ?? user.officeId ?? null} />;
}

function DealListPageContent({
  role,
  userId,
  activeOfficeId,
}: {
  role: string;
  userId: string;
  activeOfficeId: string | null;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Effective view context — the office and scope can BOTH be overridden by the URL for supported
  // cross-office viewing (?officeId=) and shared/bookmarked links (?scope=). Hoisted here so the persistence
  // layer AND the board/header below read one value.
  const effectiveOfficeId = searchParams.get("officeId") ?? activeOfficeId;
  const requestedScope = resolvePreferredScope({
    requestedScope: searchParams.get("scope"),
    userId,
    fallback: getScope(searchParams, role),
  });
  // Team is not offered (see SCOPE_OPTIONS); coerce a stored/URL ?scope=team to a scope we actually render so
  // the toggle and board never reach the dead "team" placeholder state.
  const scope: PipelineScope = requestedScope === "team" ? "mine" : requestedScope;
  // Key the rep list to the effective office so it reloads when the view switches offices (?officeId=)
  // — otherwise a rep is validated / the picker is populated against the previous office's users.
  //
  // The sales ROSTER, not every assignable account: this filter used to offer all 32 active users in the
  // office because it read the task-assignee feed. See useRepRoster.
  const {
    reps: repOptions,
    loading: repOptionsLoading,
    loadedOfficeId: repOptionsOfficeId,
  } = useRepRoster({ officeId: effectiveOfficeId });
  // Name resolution only — never the dropdown's contents. An off-roster owner can still be pinned by a
  // URL or a bookmark, and the shared FilterSelect labels an unmatched value with its allLabel, i.e. it
  // renders "All reps" over a list that IS filtered (Codex P2). Naming them is what stops that.
  const { assignees, error: assigneesError } = useTaskAssignees({ officeId: effectiveOfficeId });
  const assigneeNameById = useMemo(
    () => new Map(assignees.map((assignee) => [assignee.id, assignee.displayName])),
    [assignees]
  );

  /**
   * Whether the saved-view restore below has DECIDED — either it had nothing to apply, or it applied it.
   *
   * The board fetch waits on this. Restoring a stored Rep/timeframe rewrites the URL, which changes the
   * board's own query parameters, so fetching first meant every cold load of /deals issued the
   * 1.6–2.5s pipeline query TWICE: once for the default view and once for the restored one, with the
   * first response thrown away by useDealBoard's latest-wins guard. This does not change WHAT the board
   * shows; it stops the page from asking for the wrong thing first.
   */
  const [storedViewResolved, setStoredViewResolved] = useState(false);
  /**
   * Latched true once a board response comes back WITHOUT a usable `boardSummary`.
   *
   * A client and a server ship in one PR but deploy as two services at different moments. During a
   * rolling deploy — or if the frontend rolls first — this bundle talks to an API that predates
   * `boardSummary`, and then EVERY aggregate on this page falls back to counting the card array: the
   * three At-Risk KPI counts, the Pending RFP column, and the Opportunity total it is subtracted from.
   * Those fallbacks are correct, but only over an UNTRUNCATED card set — which is what they had before
   * this PR shrank the slice to 50. Left alone they would quietly under-report for the length of the
   * deploy, and an under-reported KPI is displayed to someone as if it were true.
   *
   * So when the server cannot supply the aggregates, the board stops truncating and asks for the full
   * per-stage set again, exactly as it did before this PR. One extra request, once, inside the deploy
   * window; the latch is monotonic so a failed refetch (which nulls `board`) cannot oscillate the limit,
   * and it never engages against an API that sends the summary.
   */
  const [serverOmitsBoardSummary, setServerOmitsBoardSummary] = useState(false);

  // Remember the standing dashboard header filters (Rep + timeframe) per (user, effective office), the same
  // way Mine/All already persists — so opening a deal and returning to /deals restores the last selection.
  // This effect only RESTORES (reads the store); it never writes, so no navigation can wipe the saved
  // selection. Writes happen only in the Rep/Period control handlers (persistDealViewParam) — the reliable
  // signal of an intentional change. Only a BARE view (no query beyond scope/officeId) hydrates; a `?filter=`
  // drill-down, a `dl_*` base-list link, or an explicit period/rep is authoritative.
  useEffect(() => {
    if (searchParams.has("filter")) return void setStoredViewResolved(true);
    if (!isBareDealsView(searchParams.toString())) return void setStoredViewResolved(true);
    const stored = readStoredDealView(userId, effectiveOfficeId);
    // A saved Rep is only meaningful under scopes that narrow by rep. Under Mine (which the shared scope
    // preference can flip to from another page) it intersects the viewer's own deals and empties the board,
    // so drop it there; Watched/On Hold/All keep it. The timeframe is always restored.
    if (scope === "mine") delete stored.assignedRepId;
    if (stored.assignedRepId) {
      // Don't inject a rep who is no longer selectable (deactivated, not in this office, or unticked from
      // the sales roster) — it would show an unresolved "Selected rep" and silently narrow the board. That
      // last case is how unticking "Generates Sales" takes effect for someone who still owns deals: their
      // deals stay on the board, but a saved filter pinned to them is released rather than left stuck.
      // Defer the WHOLE hydration until the rep list has settled FOR THE CURRENT office: while loading, and
      // while the loaded list still belongs to a previous office (on an office switch the hook briefly
      // reports the old list with loading=false before its reload effect fires). Once settled — even to an
      // empty or errored list — drop just the rep and still restore the office-independent timeframe.
      // The ONLY path that leaves the view unresolved, and deliberately so: a saved rep still has to be
      // validated against this office's roster. Every other exit settles immediately, so the board is
      // gated on a pending roster request ONLY for a user who actually has a rep filter saved.
      if (repOptionsLoading || repOptionsOfficeId !== effectiveOfficeId) return;
      if (!repOptions.some((rep) => rep.id === stored.assignedRepId)) delete stored.assignedRepId;
    }
    const next = applyStoredDealView(searchParams.toString(), stored);
    if (next !== null) setSearchParams(next, { replace: true });
    setStoredViewResolved(true);
  }, [searchParams, setSearchParams, userId, effectiveOfficeId, scope, repOptions, repOptionsLoading, repOptionsOfficeId]);

  // Persist a single header control (Rep or timeframe) as a per-(user, office) preference. Per-key so
  // changing one control never drops the other — important on a drill-down whose URL omits ?period.
  const persistDealViewParam = useCallback(
    (key: "period" | "assignedRepId", value: string | null) => {
      const stored = readStoredDealView(userId, effectiveOfficeId);
      if (value) stored[key] = value;
      else delete stored[key];
      writeStoredDealView(userId, effectiveOfficeId, stored);
    },
    [userId, effectiveOfficeId],
  );

  const [search, setSearch] = useState("");
  const [drilldownPage, setDrilldownPage] = useState(1);
  const [terminalDateFilters, setTerminalDateFilters] = useState<Record<TerminalOutcome, TerminalDateFilter>>(() =>
    resolveDrilldownTerminalDateFilters(searchParams)
  );
  const selectedPeriod = useMemo(() => normalizeDashboardPeriod(searchParams.get("period")), [searchParams]);
  const selectedPeriodRange = useMemo(() => getDashboardPeriodDateRange(selectedPeriod), [selectedPeriod]);
  const scopeOptions = SCOPE_OPTIONS;
  const { stages } = usePipelineStages("deal");
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
  // The roster plus the current selection when that falls outside it, so the control can name and clear a
  // pinned off-roster owner instead of pretending nothing is selected.
  const headerRepOptions = useMemo(
    () => buildRepFilterOptions(repOptions, selectedRepFilter, (id) => assigneeNameById.get(id)),
    [repOptions, selectedRepFilter, assigneeNameById]
  );
  // The nested FilterBar keys off its OWN dl_-prefixed param, not the header's, so it needs its own
  // reconciliation — a bookmarked dl_assignedRepId is exactly where the "All reps" mislabel showed up.
  const listRepFilterId = searchParams.get("dl_assignedRepId") || undefined;
  const listRepOptions = useMemo(
    () => buildRepFilterOptions(repOptions, listRepFilterId, (id) => assigneeNameById.get(id)),
    [repOptions, listRepFilterId, assigneeNameById]
  );
  const selectedRepLabel =
    selectedRepId === "__all__"
      ? "All reps"
      : headerRepOptions.find((rep) => rep.id === selectedRepId)?.displayName ?? "Selected rep";
  const dashboardView = useMemo(
    () =>
      getDashboardDealListView({
        filterParam: searchParams.get("filter"),
        periodParam: searchParams.get("period"),
      }),
    [searchParams]
  );
  const isAtRiskDrilldown = isCurrentStateDrilldownFilter(dashboardView.filter);
  // The route bucket THIS view is scoped to, re-derived from ?filter. It is the same value the card that
  // linked here passed to atRiskFilterForRouteBucket, so the board, the drill-down list, and that card's
  // number are all narrowed by one route predicate. "all" on every non-route view (incl. plain at_risk).
  const atRiskRouteBucket = atRiskRouteBucketForFilter(dashboardView.filter);
  const { board, loading, error } = useDealBoard(
    scope,
    true,
    terminalDateFilters,
    isAtRiskDrilldown || serverOmitsBoardSummary
      ? SLA_DRILLDOWN_PREVIEW_LIMIT
      : BOARD_CARDS_PER_STAGE_LIMIT,
    // Deals-at-Risk is a CURRENT-STATE view: ?period is a no-op. The board period serializes as
    // won_period_from/to, which the server applies to OPEN columns as a stage-entry-date window
    // (getDealsForPipeline) — so sending it here would still drop at-risk deals outside the window at the
    // SOURCE, even though the client no longer filters by it. Send no board period on this drill-down so
    // the at-risk cohort (card/kanban/list) is the full current set. (Won columns are hidden here anyway.)
    isAtRiskDrilldown ? null : selectedPeriodRange,
    selectedRepFilter,
    undefined,
    { enabled: storedViewResolved }
  );

  useEffect(() => {
    // `summary === null` covers both "field absent" and "field malformed" — either way the client cannot
    // trust a truncated card set, so widen the request. Monotonic: never set back to false.
    if (board !== null && board.summary === null) setServerOmitsBoardSummary(true);
  }, [board]);

  // Sync the board's terminal (Won/Lost) date state from the URL — but key on the BOARD params only, so a
  // list-namespaced (dl_/fb_) FilterBar edit never churns this state and refetches the kanban above it
  // (Codex #589). searchParams is read live inside; it is current whenever the key changes.
  const boardParamKey = boardRelevantParamKey(searchParams.toString());
  useEffect(() => {
    // Set only on a REAL change. This resolver returns a fresh object every call, and that object is a
    // dependency of useDealBoard's fetch callback — so re-setting a structurally identical value fired a
    // second /deals/pipeline request on every mount, and again on any board-param edit that did not
    // touch the terminal dates. Same value in, same identity out, no refetch.
    setTerminalDateFilters((current) => {
      const next = resolveDrilldownTerminalDateFilters(searchParams);
      return terminalDateFiltersEqual(current, next) ? current : next;
    });
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
    const repValue = !repId || repId === "__all__" ? null : repId;
    persistDealViewParam("assignedRepId", repValue); // remember the selection (incl. from a drill-down)
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (repValue) next.set("assignedRepId", repValue);
      else next.delete("assignedRepId");
      return next;
    });
  }, [persistDealViewParam, setSearchParams]);

  // The header period dropdown writes ?period, which already drives the KPI cards + read-only board
  // board-wide (selectedPeriodRange → useDealBoard wonPeriodRange → won_period_from/to, the outcome-aware
  // D-11 window) AND scopes the base list (fed into its baseFilters below). "__all__" clears the param.
  // The single shared "set board date" setter — used by BOTH the header Period dropdown and the Won/Lost
  // column date controls (Option A). One action -> one ?period write -> the board, KPIs, list, and both
  // terminal columns all follow it.
  const updatePeriod = useCallback((value: string) => {
    const periodValue = !value || value === "__all__" ? null : value;
    persistDealViewParam("period", periodValue); // remember the timeframe (incl. from a drill-down)
    const next = new URLSearchParams(searchParams);
    if (periodValue) next.set("period", periodValue);
    else next.delete("period");
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
    setTerminalDateFilters((current) => {
      const resolved = resolveDrilldownTerminalDateFilters(next);
      return terminalDateFiltersEqual(current, resolved) ? current : resolved;
    });
  }, [searchParams, setSearchParams, persistDealViewParam]);

  // The SAME limit the request asked for, re-imposed after alias merging: the server caps per raw stage,
  // and four of the six non-terminal columns merge two raw stages each, so a "50-card" column could
  // otherwise render 100.
  const boardCardsPerColumnLimit = isAtRiskDrilldown || serverOmitsBoardSummary
    ? SLA_DRILLDOWN_PREVIEW_LIMIT
    : BOARD_CARDS_PER_STAGE_LIMIT;
  const boardColumns = useMemo(
    () =>
      buildCanonicalDealBoardColumns(
        board?.columns,
        stages,
        board?.summary,
        board?.pendingRfpCards,
        boardCardsPerColumnLimit
      ),
    [board?.columns, board?.pendingRfpCards, board?.summary, boardCardsPerColumnLimit, stages]
  );
  /**
   * Server-side at-risk counts, keyed by canonical column slug and counted over EVERY matching row.
   *
   * The three At-Risk KPI cards used to be counted from `column.cards`, which is a capped slice — the
   * board asks for BOARD_CARDS_PER_STAGE_LIMIT per column, so any column holding more than that would
   * have silently under-reported all three numbers. Null on a payload without a summary, which puts
   * countAtRiskDeals back on the card count.
   */
  const boardAtRiskByStageSlug = board?.summary?.atRiskByStageSlug ?? null;
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
      return getAtRiskBoardColumns(boardColumns, atRiskRouteBucket);
    }
    return boardColumns;
  }, [atRiskRouteBucket, boardColumns, dashboardView.boardMode, dashboardView.boardStageSlugs]);
  /**
   * The column set the three At-Risk KPI cards count over: `unsearchedColumns` with the view's ROUTE
   * narrowing removed. Each card then applies its OWN bucket to this one set, which is what makes
   * Service + Non-service === All hold on every view — including while standing on a route drill-down,
   * where narrowing the counters too would zero the other card while its link still opened a non-empty
   * list (exactly the card/list divergence this split has to avoid).
   *
   * On every non-route view the bucket is "all", so this IS `unsearchedColumns` and the "All at risk"
   * number is byte-identical to the single pre-split card's.
   *
   * KNOWN GAP (not fixed here): on a STAGE-SCOPED view — Won, Opportunities, Bid Board —
   * `unsearchedColumns` is only that view's columns, while every at-risk link opens the ALL-STAGE
   * cohort. On the Won drill-down the visible columns are terminal, so all three cards read 0 while
   * their destinations hold rows. This is pre-existing behaviour of the single "At risk" card (it read 0
   * there before this split too), not something the route split introduced. The fix is to count from
   * `getAtRiskBoardColumns(boardColumns, "all")` unconditionally — one line — but that CHANGES the
   * number "All at risk" displays on those three views (0 -> the real cohort size), so it is a product
   * decision rather than a bug fix and is deliberately not taken here.
   */
  const kpiAtRiskColumns = useMemo(
    () => (atRiskRouteBucket === "all" ? unsearchedColumns : getAtRiskBoardColumns(boardColumns, "all")),
    [atRiskRouteBucket, boardColumns, unsearchedColumns]
  );
  /**
   * The kanban's columns: `unsearchedColumns` with ONLY the text search layered on.
   *
   * This is DERIVED from unsearchedColumns rather than re-selecting the stage/at-risk/route set a second
   * time. The two used to be separate copies of the same selection chain, which meant the route narrowing
   * had to be added in two places to stay correct — the board and list would otherwise have shown the full
   * at-risk cohort under a route card's number. One selection, one place, no drift.
   */
  const columns = useMemo(() => {
    const searchTerm = search.trim().toLowerCase();
    if (!searchTerm) return unsearchedColumns;
    return unsearchedColumns.map((column) => {
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
  }, [search, unsearchedColumns]);
  // On the at-risk drill-down the Active Pipeline KPI card aggregates the SAME at-risk-filtered set that
  // feeds the kanban (unsearchedColumns) — not the whole open board. Those columns are recounted from
  // CARDS, so this card's reconciliation with the At-Risk KPI (which reads the server summary) holds
  // because this route requests SLA_DRILLDOWN_PREVIEW_LIMIT cards, not because the two share a source.
  // See getAtRiskBoardColumns. Everywhere else it stays the full active (non-terminal) pipeline.
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
  // The three At-Risk KPI numbers, all from ONE counter over ONE column set. countAtRiskDeals("all") is
  // the exact reduce the single pre-split card used, so "All at risk" keeps today's number verbatim; the
  // other two are that same count with the route partition applied, so they sum back to it.
  const atRiskCounts: Record<AtRiskRouteBucket, number> = {
    service: countAtRiskDeals(kpiAtRiskColumns, "service", boardAtRiskByStageSlug),
    non_service: countAtRiskDeals(kpiAtRiskColumns, "non_service", boardAtRiskByStageSlug),
    all: countAtRiskDeals(kpiAtRiskColumns, "all", boardAtRiskByStageSlug),
  };
  // On the at-risk drill-down the Active Pipeline card DISPLAYS the at-risk cohort, so its click-through
  // must land on that same cohort — not the full active pipeline (which would show a larger, different set
  // than the number on the card). Everywhere else it drills into the full active pipeline.
  const activePipelineDestination = buildDealsPageKpiDrilldownPath(
    activePipelineDrilldownFilter(dashboardView.boardMode, atRiskRouteBucket),
    scope,
    undefined,
    { queryParams: searchParams }
  );
  const wonDestination = buildDealsPageKpiDrilldownPath("won", scope, selectedPeriod, {
    queryParams: searchParams,
  });
  // One destination per bucket, built through atRiskFilterForRouteBucket — the inverse of the
  // atRiskRouteBucketForFilter the destination page uses to narrow its board and list. That round trip
  // is the card↔list contract: whatever bucket produced the number also produces the rows.
  const atRiskDestinations: Record<AtRiskRouteBucket, string> = {
    service: buildDealsPageKpiDrilldownPath(atRiskFilterForRouteBucket("service"), scope, undefined, {
      queryParams: searchParams,
    }),
    non_service: buildDealsPageKpiDrilldownPath(atRiskFilterForRouteBucket("non_service"), scope, undefined, {
      queryParams: searchParams,
    }),
    all: buildDealsPageKpiDrilldownPath(atRiskFilterForRouteBucket("all"), scope, undefined, {
      queryParams: searchParams,
    }),
  };
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
              {headerRepOptions.map((rep) => (
                <SelectItem key={rep.id} value={rep.id}>
                  {rep.displayName}
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
        {/*
          ONE At Risk card carrying THREE destinations.

          The headline is All at risk, and the card body opens the all-at-risk drill-down — exactly the
          pre-split number, behaviour, and destination. Service / Non-service are small sub-links to
          their own route drill-downs, with their counts shown beside the total so the reader can SEE
          Service + Non-service adding up to the headline; that is the reconciliation made self-evident.

          ANCHORS ARE SIBLINGS, NEVER NESTED. MetricCard wraps its whole body in a Link, so it cannot
          host sub-links — hence this bespoke card (MetricCard is left untouched for its other callers).
          The All link is a stretched overlay (absolute inset-0) that sits FIRST in the DOM, so tab order
          is All -> Service -> Non-service, matching the reading order. The card body is
          pointer-events-none so clicks over the text fall through to that overlay, and the two route
          links re-enable pointer events and sit above it (relative z-10) — so all three are separately
          focusable, separately named, and their hit targets never overlap.

          Counts and destinations are both indexed by the SAME bucket key, so no sub-link can end up
          paired with another cohort's number or href.
        */}
        <Card
          className={`group relative overflow-hidden transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md ${
            atRiskCounts.all > 0 ? "border-0 bg-brand-red text-white shadow-md" : "border-slate-200 bg-white shadow-none"
          }`}
        >
          <Link
            to={atRiskDestinations.all}
            aria-label={AT_RISK_CARD_LABELS.all.ariaLabel}
            // ring-INSET is load-bearing, not decoration. This link is `absolute inset-0`, so its box is
            // exactly the card's box, and the Card is `overflow-hidden` — a default (outset) ring paints
            // OUTSIDE that box and is clipped away entirely. Combined with `focus:outline-none` removing
            // the browser fallback, a keyboard user tabbing to the first at-risk link would get NO visible
            // focus state at all. Drawing the ring inside the box is what makes it survive the clip.
            className={`absolute inset-0 z-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-inset ${
              atRiskCounts.all > 0 ? "focus-visible:ring-white" : "focus-visible:ring-brand-red"
            }`}
          />
          <CardContent className="pointer-events-none p-5">
            <p
              className={`text-[11px] font-bold uppercase tracking-[0.2em] ${
                atRiskCounts.all > 0 ? "text-white/80" : "text-slate-500"
              }`}
            >
              At risk
            </p>
            <p
              data-testid="at-risk-total"
              className={`mt-2 text-4xl font-black leading-none ${atRiskCounts.all > 0 ? "text-white" : "text-slate-950"}`}
            >
              {atRiskCounts.all}
            </p>
            <div className="mt-3 flex items-center gap-3">
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                  atRiskCounts.all > 0
                    ? "bg-white/15 ring-1 ring-white/20"
                    : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                }`}
              >
                Over SLA
              </span>
              <p
                className={`text-[11px] font-semibold uppercase tracking-wide ${
                  atRiskCounts.all > 0 ? "text-white/70" : "text-slate-500"
                }`}
              >
                Needs touch
              </p>
            </div>
            <div
              className={`mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold ${
                atRiskCounts.all > 0 ? "text-white/90" : "text-slate-600"
              }`}
            >
              {AT_RISK_ROUTE_SUBLINK_BUCKETS.map((bucket, index) => (
                <Fragment key={bucket}>
                  {index > 0 ? (
                    <span aria-hidden="true" className={atRiskCounts.all > 0 ? "text-white/40" : "text-slate-300"}>
                      ·
                    </span>
                  ) : null}
                  <Link
                    to={atRiskDestinations[bucket]}
                    aria-label={AT_RISK_CARD_LABELS[bucket].ariaLabel}
                    className={`pointer-events-auto relative z-10 rounded underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 ${
                      atRiskCounts.all > 0 ? "focus-visible:ring-white" : "focus-visible:ring-brand-red"
                    }`}
                  >
                    {AT_RISK_CARD_LABELS[bucket].shortLabel}{" "}
                    <span className="font-black tabular-nums">{atRiskCounts[bucket]}</span>
                  </Link>
                </Fragment>
              ))}
            </div>
          </CardContent>
          {atRiskCounts.all > 0 ? null : (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-brand-red" aria-hidden="true" />
          )}
        </Card>
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
                {/* A change-order child is STORED as "<Parent> — Change Order N", so this truncating row
                    title reads as its parent. Display-only reorder; the stored name is untouched. */}
                {paginatedDrilldownDeals.map((deal) => (
                  <button
                    key={deal.id}
                    type="button"
                    onClick={() => navigate(`/deals/${deal.id}`)}
                    aria-label={`Open project ${formatDealDisplayName(deal.name, deal.isChangeOrder)}; stage ${deal.boardStageName}; project owner ${dealOwnerLabel(deal)}; time in stage ${stageAgeDaysLabel(deal)}; last updated ${formatDateInput(new Date(deal.updatedAt))}; value ${USD_COMPACT(moneyValue(deal))}`}
                    className="grid w-full grid-cols-2 items-start gap-x-4 gap-y-3 px-1 py-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-red/40 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(7rem,0.65fr)_minmax(7rem,0.65fr)_minmax(5.5rem,0.55fr)] lg:items-center"
                  >
                    <div className="col-span-2 min-w-0 lg:col-span-1">
                      <p className="truncate text-sm font-black text-slate-950">{formatDealDisplayName(deal.name, deal.isChangeOrder)}</p>
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
              // Hand down the assignee list this page already loaded, so the section does not re-issue
              // /tasks/assignees on every /deals load (it is name resolution + CSV only; the owner
              // FILTER is the sales roster and is gated separately inside the section).
              //
              // UNDEFINED when our own load FAILED, which hands the fetch back to the section. Passing
              // the empty array unconditionally would have removed its independent retry: owner names
              // and the CSV export would degrade to "Unassigned" for every row with no way back.
              assignees={assigneesError ? undefined : assignees}
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
                  reps: listRepOptions.map((rep) => ({ value: rep.id, label: rep.displayName })),
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
              // Hand down the assignee list this page already loaded, so the section does not re-issue
              // /tasks/assignees on every /deals load (it is name resolution + CSV only; the owner
              // FILTER is the sales roster and is gated separately inside the section).
              //
              // UNDEFINED when our own load FAILED, which hands the fetch back to the section. Passing
              // the empty array unconditionally would have removed its independent retry: owner names
              // and the CSV export would degrade to "Unassigned" for every row with no way back.
              assignees={assigneesError ? undefined : assignees}
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
