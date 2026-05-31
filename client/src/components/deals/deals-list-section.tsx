import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { CalendarDays, Clock3, Download, MapPin } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PipelineStageTable,
  type PipelineStageTableColumn,
} from "@/components/pipeline/pipeline-stage-table";
import { TerminalDateFilterControl } from "@/components/pipeline/terminal-date-filter-control";
import { buildDealsQueryParams, useDeals, type Deal, type DealFilters } from "@/hooks/use-deals";
import { SearchInput } from "@/components/ui/search-input";
import { useKeepPreviousData } from "@/hooks/use-keep-previous-data";
import { usePipelineStages, type PipelineStage } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { DealValue } from "@/components/deals/deal-value";
import {
  daysAgo,
  toDatePresetRange,
  type TerminalDateFilter,
} from "@/lib/pipeline-terminal-filters";
import { api } from "@/lib/api";
import {
  getEffectiveDealValue,
  getEffectiveStageAgeDeal,
  getEffectiveStageAgeDays,
  getOwnerInitialColor,
} from "@trock-crm/shared/types";
import { cn } from "@/lib/utils";
import { parseDisplayDate } from "@/lib/deal-utils";
import { getDealDisplayNumber } from "@/components/deals/kanban-deal-card";
import { listPaginationIconButtonClassName } from "@/components/shared/list-pagination";
import { AtRiskBadge } from "@/components/deals/at-risk-badge";
import { useFilterState } from "@/components/filters/use-filter-state";
import { FilterBar, type FilterDimension, type FilterBarOptions } from "@/components/filters/filter-bar";
import { applyBoardVisibilityDefaults, filterBarValueToDealFilters, getDealDisplayDate } from "./deals-filterbar-adapter";

const DEAL_STAGE_ORDER = [
  "opportunity",
  "estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
];

const DEFAULT_PAGE_SIZE = 25;
export const MAX_EXPORT_PAGES = 50;
const EXPORT_PAGE_SIZE = 500;
const DEFAULT_SORT_STATE = { key: "created_at", dir: "desc" } satisfies DealListSortState;
const EMPTY_STAGE_SLUGS: string[] = [];

type SortKey = "name" | "created_at" | "stage_entered_at" | "awarded_amount" | "updated_at";
export type DealListSortState = {
  key: SortKey | "expected_close_date" | "contract_signed_date" | "display_date";
  dir: "asc" | "desc";
};
type DealListActiveFilter = boolean | "all" | "pipeline";

interface DealsListSectionProps {
  scope?: "mine" | "team" | "all";
  workflowFamily?: Parameters<typeof usePipelineStages>[0];
  enableDateFilter?: boolean;
  enableExport?: boolean;
  showFilterButton?: boolean;
  visibleStages?: Array<Pick<PipelineStage, "id" | "slug" | "name"> & Partial<Pick<PipelineStage, "isTerminal" | "displayOrder">>>;
  excludeStageSlugs?: string[];
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  pageSize?: number;
  searchPlaceholder?: string;
  baseFilters?: Partial<DealFilters>;
  initialSort?: DealListSortState;
  initialStageSlugs?: string[];
  lockedOwnerId?: string;
  hideOwnerFilter?: boolean;
  dateField?: "updated" | "created" | "outcome";
  externalDateRange?: { from?: string; to?: string };
  paginationCountSummary?: { active: number; total: number };
  /**
   * Opt-in shared FilterBar mode (Slice 7 proving ground). When provided, the section reads/writes
   * its filter state from the URL (useFilterState) and renders the shared <FilterBar> in place of the
   * legacy inline controls; the filters map to getDeals via the #546 contract (outcome-aware date,
   * status, workflow, value, stalled). When ABSENT the legacy local-state controls render byte-for-
   * byte unchanged, so pipeline-page + rep-drilldown keep today's behavior until their rollout phase.
   */
  filterBar?: {
    dimensions: FilterDimension[];
    options?: FilterBarOptions;
    stageEntryDateEnabled?: boolean;
    /**
     * Board-mirroring defaults (Slice 7 design sign-off). When this list sits under a kanban, the
     * mount passes the board's visible column stage ids so the list shows the SAME deals as the board:
     *  - defaultStageIds: the visible columns (Show-DD-filtered) — used as the list's stageIds when the
     *    user has selected none, so DD deals hide exactly when the board hides the DD column (Q2);
     *  - terminalStageIds: the visible terminal subset — sent as inactiveStageIds with isActive
     *    "pipeline" (unless an explicit Status is chosen) so terminal deals show like the board's
     *    Won/Lost columns, overriding the contract's active-only default at THIS mount (Q1).
     */
    defaultStageIds?: string[];
    terminalStageIds?: string[];
  };
}

interface DealStageFilterOption {
  ids: string[];
  slug: string;
  name: string;
  isTerminal?: boolean;
}

export function dateRangeFromTerminalFilter(filter: TerminalDateFilter) {
  if (filter.preset === "all") return {};
  if (filter.preset === "custom") {
    return { from: filter.customStart || undefined, to: filter.customEnd || undefined };
  }
  if (
    filter.preset === "wtd" ||
    filter.preset === "mtd" ||
    filter.preset === "qtd" ||
    filter.preset === "ytd"
  ) {
    return toDatePresetRange(filter.preset);
  }
  return { from: daysAgo(Number(filter.preset)) };
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return "--";
  // parseDisplayDate anchors a date-only value (YYYY-MM-DD) to its literal calendar day so it never
  // renders a day early west of UTC (the won_closed_date "Jan 14 -> Jan 13" bug). Timestamps unchanged.
  const date = parseDisplayDate(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function initials(name: string | null | undefined) {
  return (name ?? "")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function getDealPropertyLabel(deal: Deal) {
  return (
    deal.propertyAddress ||
    [deal.propertyCity, deal.propertyState].filter(Boolean).join(", ") ||
    deal.companyName ||
    "Property pending"
  );
}

export function getDealCloseDate(deal: Deal) {
  return deal.actualCloseDate ?? deal.expectedCloseDate ?? null;
}

function renderStageChip(label: string) {
  return (
    <span
      className="inline-flex max-w-full items-center rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600"
      title={label}
      aria-label={label}
    >
      <span className="block truncate whitespace-nowrap">{label}</span>
    </span>
  );
}

export function escapeCsvCell(value: string | number | null | undefined) {
  // Numbers are never an injection vector and must stay numeric (don't neutralize e.g. -5).
  if (typeof value === "number") return String(value);
  const text = value == null ? "" : String(value);
  // CSV-injection hardening: a STRING cell beginning with a formula trigger (= + - @, or a leading
  // control char) can execute as a formula in Excel/Sheets. Prefix with ' so it renders as text.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Serialize rows to CSV and trigger a client-side download. Shared by the legacy and FilterBar export paths. */
function triggerCsvDownload(rows: (string | number | null | undefined)[][], filename: string) {
  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // Attach before clicking: a detached anchor's click() does not reliably start the download in some
  // browsers (e.g. Firefox). Remove it right after.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function DealsListPagination({
  page,
  total,
  totalPages,
  countSummary,
  onPageChange,
}: {
  page: number;
  total: number;
  totalPages: number;
  countSummary?: { active: number; total: number };
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-slate-200 pt-4">
      <div>
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
          {countSummary ? `${countSummary.active}/${countSummary.total} active records` : `${total} total records`}
        </p>
        <p className="text-sm font-medium text-slate-500">
          Page {page} of {totalPages || 1}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className={cn(
            "inline-flex h-11 w-11 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed md:h-9 md:w-9",
            listPaginationIconButtonClassName
          )}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className={cn(
            "inline-flex h-11 w-11 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed md:h-9 md:w-9",
            listPaginationIconButtonClassName
          )}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </div>
  );
}

function renderDescriptionPreview(description: string | null | undefined) {
  const value = description?.trim() ?? "";
  if (!value) {
    return <span className="text-xs font-medium text-slate-400">—</span>;
  }

  return (
    <span
      className="group relative block w-full max-w-[18rem] outline-none"
      tabIndex={0}
      aria-label={value}
      title={value}
    >
      <span className="block truncate text-xs font-medium text-slate-500">{value}</span>
      <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden max-w-sm rounded-md border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md ring-1 ring-foreground/10 group-hover:block group-focus:block">
        {value}
      </span>
    </span>
  );
}

function effectiveStageAgeDays(deal: Deal) {
  return getEffectiveStageAgeDays(getEffectiveStageAgeDeal(deal));
}

/**
 * Decides which `isActive` filter to send to /deals when listing pipeline records.
 * - No stages selected: "pipeline" (active stages + the named terminal stages we pass via inactiveStageIds).
 * - Selection includes any terminal stage: "pipeline" (so terminal hits flow through despite is_active=false).
 * - Selection is purely active stages: true (active-only).
 */
export function getPipelineListIsActiveFilter(
  selectedStageIds: string[],
  terminalStageIds: string[]
): DealListActiveFilter {
  if (selectedStageIds.length === 0) return "pipeline";
  return selectedStageIds.some((id) => terminalStageIds.includes(id)) ? "pipeline" : true;
}

export function getVisibleTerminalStageIds(
  stages: Array<Pick<PipelineStage, "id" | "isTerminal">>,
  visibleStages: Array<Pick<PipelineStage, "id" | "slug" | "name">>
) {
  const visibleStageIds = new Set(visibleStages.map((stage) => stage.id));
  return stages
    .filter((stage) => stage.isTerminal && visibleStageIds.has(stage.id))
    .map((stage) => stage.id);
}

export function getPipelineListQueryState(input: {
  selectedStageIds: string[];
  terminalStageIds: string[];
  stagesLoading: boolean;
  stagesError: string | null;
  selectedStageStatusKnown?: boolean;
}) {
  const hasSelectedStages = input.selectedStageIds.length > 0;
  const hasSelectedTerminalStage = input.selectedStageIds.some((id) => input.terminalStageIds.includes(id));
  const selectedStageStatusKnown = input.selectedStageStatusKnown ?? true;
  if (
    (input.stagesLoading || input.stagesError) &&
    (!hasSelectedStages || hasSelectedTerminalStage || !selectedStageStatusKnown)
  ) {
    return {
      enabled: false,
      isActive: "pipeline" as DealListActiveFilter,
      inactiveStageIds: [] as string[],
    };
  }

  const isActive = getPipelineListIsActiveFilter(input.selectedStageIds, input.terminalStageIds);
  return {
    enabled: true,
    isActive,
    inactiveStageIds:
      isActive !== "pipeline"
        ? []
        : input.selectedStageIds.length === 0
          ? input.terminalStageIds
          : input.selectedStageIds.filter((id) => input.terminalStageIds.includes(id)),
  };
}

export function buildStageNameById(stages: Array<Pick<PipelineStage, "id" | "name">>) {
  return new Map(stages.map((stage) => [stage.id, stage.name]));
}

function getStageRank(slug: string) {
  const index = DEAL_STAGE_ORDER.indexOf(slug);
  return index === -1 ? 999 : index;
}

export function buildDealStageFilterOptions(
  sourceStages: Array<Pick<PipelineStage, "id" | "slug" | "name"> & Partial<Pick<PipelineStage, "displayOrder" | "isTerminal">>>,
  excludeStageSlugs: string[] = []
): DealStageFilterOption[] {
  const excluded = new Set(excludeStageSlugs);
  const grouped = new Map<string, DealStageFilterOption & { displayOrder: number }>();
  const sortedStages = [...sourceStages]
    .filter((stage) => !excluded.has(stage.slug))
    .sort((left, right) => {
      const leftRank = getStageRank(left.slug);
      const rightRank = getStageRank(right.slug);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return (left.displayOrder ?? 0) - (right.displayOrder ?? 0);
    });

  for (const stage of sortedStages) {
    const existing = grouped.get(stage.slug);
    if (existing) {
      existing.ids.push(stage.id);
      existing.isTerminal = existing.isTerminal || stage.isTerminal;
      continue;
    }
    grouped.set(stage.slug, {
      ids: [stage.id],
      slug: stage.slug,
      name: stage.name,
      isTerminal: stage.isTerminal,
      displayOrder: stage.displayOrder ?? 0,
    });
  }

  return Array.from(grouped.values()).map(({ displayOrder: _displayOrder, ...option }) => option);
}

export function getSelectedDealStageIds(stageSlugs: string[], options: DealStageFilterOption[]) {
  const selected = new Set(stageSlugs);
  return options.flatMap((stage) => (selected.has(stage.slug) ? stage.ids : []));
}

export function getVisibleListTerminalStageIds(
  stages: Array<Pick<PipelineStage, "id" | "isTerminal">>,
  stageFilterOptions: DealStageFilterOption[]
) {
  return Array.from(
    new Set([
      ...getVisibleTerminalStageIds(
        stages,
        stageFilterOptions.flatMap((stage) => stage.ids.map((id) => ({ id, slug: stage.slug, name: stage.name })))
      ),
      ...stageFilterOptions
        .filter((stage) => stage.isTerminal === true)
        .flatMap((stage) => stage.ids),
    ])
  );
}

export function buildDealListParams(input: {
  search: string;
  stageIds: string[];
  inactiveStageIds?: string[];
  assignedRepId?: string;
  dateRange: { from?: string; to?: string };
  contractSignedFrom?: string;
  contractSignedTo?: string;
  wonClosedFrom?: string;
  wonClosedTo?: string;
  estimateSentFrom?: string;
  estimateSentTo?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  dateFrom?: string;
  dateTo?: string;
  isActive: DealListActiveFilter;
  sort: DealListSortState;
  page: number;
  limit: number;
  scope?: "mine" | "team" | "all";
  dateField?: "updated" | "created" | "outcome";
}) {
  const params = new URLSearchParams();
  if (input.search) params.set("search", input.search);
  if (input.stageIds.length) params.set("stageIds", input.stageIds.join(","));
  if (input.inactiveStageIds?.length) params.set("inactiveStageIds", input.inactiveStageIds.join(","));
  if (input.assignedRepId) params.set("assignedRepId", input.assignedRepId);
  const dateField = input.dateField ?? "updated";
  if (dateField === "outcome") {
    // D-15: the window narrows the CANONICAL outcome axis (#546 buildDealOutcomeDateScope) —
    // Won on won_closed_date, Lost on lost_at, open on stage_entered_at — never created/updated.
    // stage_entry_window forces open rows to be bounded regardless of the server flag, so the
    // CSV export matches the on-screen list (Codex #564).
    const dateFrom = input.dateFrom ?? input.dateRange.from;
    const dateTo = input.dateTo ?? input.dateRange.to;
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    params.set("stage_entry_window", "true");
  } else if (dateField === "created") {
    const createdFrom = input.createdFrom ?? input.dateRange.from;
    const createdTo = input.createdTo ?? input.dateRange.to;
    if (createdFrom) params.set("createdFrom", createdFrom);
    if (createdTo) params.set("createdTo", createdTo);
  } else {
    const updatedFrom = input.updatedFrom ?? input.dateRange.from;
    const updatedTo = input.updatedTo ?? input.dateRange.to;
    if (updatedFrom) params.set("updatedFrom", updatedFrom);
    if (updatedTo) params.set("updatedTo", updatedTo);
  }
  if (input.contractSignedFrom) params.set("contractSignedFrom", input.contractSignedFrom);
  if (input.contractSignedTo) params.set("contractSignedTo", input.contractSignedTo);
  if (input.wonClosedFrom) params.set("wonClosedFrom", input.wonClosedFrom);
  if (input.wonClosedTo) params.set("wonClosedTo", input.wonClosedTo);
  if (input.estimateSentFrom) params.set("estimateSentFrom", input.estimateSentFrom);
  if (input.estimateSentTo) params.set("estimateSentTo", input.estimateSentTo);
  params.set("isActive", String(input.isActive));
  params.set("sortBy", input.sort.key);
  params.set("sortDir", input.sort.dir);
  params.set("page", String(input.page));
  params.set("limit", String(input.limit));
  if (input.scope) params.set("scope", input.scope);
  return params;
}

export async function fetchAllFilteredDeals(input: {
  search: string;
  stageIds: string[];
  inactiveStageIds?: string[];
  assignedRepId?: string;
  dateRange: { from?: string; to?: string };
  contractSignedFrom?: string;
  contractSignedTo?: string;
  wonClosedFrom?: string;
  wonClosedTo?: string;
  estimateSentFrom?: string;
  estimateSentTo?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  dateFrom?: string;
  dateTo?: string;
  isActive: DealListActiveFilter;
  sort: DealListSortState;
  scope?: "mine" | "team" | "all";
  apiClient?: typeof api;
  dateField?: "updated" | "created" | "outcome";
}) {
  const apiClient = input.apiClient ?? api;
  const limit = EXPORT_PAGE_SIZE;
  const firstParams = buildDealListParams({ ...input, page: 1, limit });
  const first = await apiClient<{ deals: Deal[]; pagination: { totalPages: number } }>(
    `/deals?${firstParams.toString()}`
  );
  const pages = [first.deals];
  const totalPages = Math.max(1, first.pagination.totalPages || 1);
  const pagesToFetch = Math.min(totalPages, MAX_EXPORT_PAGES);

  for (let page = 2; page <= pagesToFetch; page += 1) {
    const params = buildDealListParams({ ...input, page, limit });
    const next = await apiClient<{ deals: Deal[]; pagination: { totalPages: number } }>(
      `/deals?${params.toString()}`
    );
    pages.push(next.deals);
  }

  return {
    deals: pages.flat(),
    totalPages,
    pagesFetched: pagesToFetch,
    truncated: totalPages > MAX_EXPORT_PAGES,
    maxRows: pagesToFetch * limit,
  };
}

/**
 * FilterBar-aware export fetch: paginate /api/deals with the SAME DealFilters the FilterBar list
 * queries (serialized by buildDealsQueryParams — the canonical #546 axis: outcome-aware dateFrom/dateTo,
 * status, value, workflow, region, the __unassigned__ sentinel, etc.), so the CSV reflects exactly
 * what the user is looking at — not the legacy created/updated axis. page/limit are overridden to walk
 * full pages from 1 (the list's page is ignored). Capped at MAX_EXPORT_PAGES like the legacy export.
 */
export async function fetchAllDealsForFilters(input: { filters: DealFilters; apiClient?: typeof api }) {
  const apiClient = input.apiClient ?? api;
  const limit = EXPORT_PAGE_SIZE;
  const query = (page: number) => buildDealsQueryParams({ ...input.filters, page, limit }).toString();
  const first = await apiClient<{ deals: Deal[]; pagination: { totalPages: number } }>(`/deals?${query(1)}`);
  const pages = [first.deals];
  const totalPages = Math.max(1, first.pagination.totalPages || 1);
  const pagesToFetch = Math.min(totalPages, MAX_EXPORT_PAGES);

  for (let page = 2; page <= pagesToFetch; page += 1) {
    const next = await apiClient<{ deals: Deal[]; pagination: { totalPages: number } }>(`/deals?${query(page)}`);
    pages.push(next.deals);
  }

  return {
    deals: pages.flat(),
    totalPages,
    pagesFetched: pagesToFetch,
    truncated: totalPages > MAX_EXPORT_PAGES,
    maxRows: pagesToFetch * limit,
  };
}

/** CSV rows for the FilterBar-mode export. The Date column is the canonical outcome-aware
 *  getDealDisplayDate (filter-axis == display-axis) — matching the list's Date column, not the legacy
 *  "Last Touch" (lastActivityAt) axis. */
export function buildFilterBarCsvRows(
  deals: Deal[],
  maps: { stageNameById: Map<string, string>; assigneeNameById: Map<string, string> }
): (string | number)[][] {
  return [
    ["Deal", "Project Number", "Owner", "Stage", "Days", "Value", "Date"],
    ...deals.map((deal) => [
      deal.name,
      getDealDisplayNumber(deal).label,
      deal.assignedRepName ?? (deal.assignedRepId ? maps.assigneeNameById.get(deal.assignedRepId) : undefined) ?? "",
      deal.stageName ?? maps.stageNameById.get(deal.stageId) ?? "",
      effectiveStageAgeDays(deal),
      getEffectiveDealValue(deal),
      getDealDisplayDate(deal) ?? "",
    ]),
  ];
}

export function DealsListSection({
  scope,
  workflowFamily = "deal",
  enableDateFilter = false,
  enableExport = false,
  visibleStages,
  excludeStageSlugs = [],
  eyebrow = "Deal list",
  title = "Pipeline records",
  subtitle = "Filter and scan deals without changing the kanban above.",
  pageSize = DEFAULT_PAGE_SIZE,
  searchPlaceholder = "Deal name, number, company, address",
  baseFilters,
  initialSort = DEFAULT_SORT_STATE,
  initialStageSlugs = EMPTY_STAGE_SLUGS,
  lockedOwnerId,
  hideOwnerFilter = false,
  dateField = "updated",
  externalDateRange,
  paginationCountSummary,
  filterBar,
}: DealsListSectionProps) {
  const navigate = useNavigate();
  // Slice 7: opt-in URL-backed filter state. useFilterState is always called (hooks can't be
  // conditional); its value only drives the query/UI when filterBarMode is on.
  const { filters: urlFilters, setFilters, resetFilters } = useFilterState();
  const filterBarMode = Boolean(filterBar);
  // D-15: legacy "outcome" axis — the rep drill-down feeds an externalDateRange that
  // must narrow the canonical outcome window (dateFrom/dateTo) and DISPLAY the same
  // outcome-aware date the server projects (displayDate), without the full FilterBar
  // UI. So this surface, like filterBarMode, shows the honest "Date" column.
  const outcomeDateAxis = dateField === "outcome";
  const showOutcomeDate = filterBarMode || outcomeDateAxis;
  // Scope is read from the URL ONLY when this surface actually renders a scope control (the bar owns
  // the "scope" dimension). At the pipeline mount the page owns scope (its toggle), so the list must
  // inherit the page's NORMALIZED scope prop — not a raw, possibly-stale ?scope from the URL (e.g. a
  // bookmarked ?scope=team the board has coerced to mine). Otherwise the list and board disagree.
  const filterBarOwnsScope = filterBar?.dimensions.includes("scope") ?? false;
  const [search, setSearch] = useState("");
  const [stageSlugs, setStageSlugs] = useState<string[]>(initialStageSlugs);
  const [ownerId, setOwnerId] = useState(lockedOwnerId ?? "__all__");
  const [dateFilter, setDateFilter] = useState<TerminalDateFilter>({ preset: "all" });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DealListSortState>(initialSort);
  const effectiveAssignedRepId = lockedOwnerId ?? (hideOwnerFilter ? undefined : ownerId === "__all__" ? undefined : ownerId);

  const { stages, loading: stagesLoading, error: stagesError } = usePipelineStages(workflowFamily);
  const { assignees } = useTaskAssignees();

  const stageFilterOptions = useMemo(() => {
    const sourceStages = visibleStages ?? stages.filter((stage) => stage.isActivePipeline !== false);
    return buildDealStageFilterOptions(sourceStages, excludeStageSlugs);
  }, [excludeStageSlugs, stages, visibleStages]);

  const selectedStageIds = useMemo(
    () => getSelectedDealStageIds(stageSlugs, stageFilterOptions),
    [stageSlugs, stageFilterOptions]
  );
  const dateRange = useMemo(() => {
    if (externalDateRange) return externalDateRange;
    return enableDateFilter ? dateRangeFromTerminalFilter(dateFilter) : {};
  }, [enableDateFilter, dateFilter, externalDateRange]);
  const drilldownContextKey = useMemo(
    () =>
      JSON.stringify({
        baseFilters: baseFilters ?? {},
        excludeStageSlugs,
        initialSort,
        initialStageSlugs,
        lockedOwnerId,
        dateField,
        externalDateRange,
        visibleStages: visibleStages?.map((stage) => `${stage.id}:${stage.slug}:${stage.name}`) ?? [],
      }),
    [baseFilters, dateField, excludeStageSlugs, externalDateRange, initialSort, initialStageSlugs, lockedOwnerId, visibleStages]
  );

  const terminalStageIds = useMemo(
    () => getVisibleListTerminalStageIds(stages, stageFilterOptions),
    [stages, stageFilterOptions]
  );
  const listQueryState = useMemo(
    () =>
      getPipelineListQueryState({
        selectedStageIds,
        terminalStageIds,
        stagesLoading,
        stagesError,
        selectedStageStatusKnown: selectedStageIds.every((id) =>
          stageFilterOptions.some((stage) => stage.ids.includes(id) && typeof stage.isTerminal === "boolean")
        ),
      }),
    [selectedStageIds, stageFilterOptions, stagesError, stagesLoading, terminalStageIds]
  );
  const isActiveFilter = listQueryState.isActive;
  const inactiveStageIds = listQueryState.inactiveStageIds;

  useEffect(() => {
    setStageSlugs((current) =>
      current.length === initialStageSlugs.length &&
      current.every((slug, index) => slug === initialStageSlugs[index])
        ? current
        : initialStageSlugs
    );
  }, [initialStageSlugs]);

  useEffect(() => {
    const nextOwnerId = lockedOwnerId ?? "__all__";
    setOwnerId((current) => (current === nextOwnerId ? current : nextOwnerId));
  }, [lockedOwnerId]);

  useEffect(() => {
    setSort((current) =>
      current.key === initialSort.key && current.dir === initialSort.dir ? current : initialSort
    );
  }, [initialSort]);

  // Pagination + query-enable diverge by mode: FilterBar mode reads page from the URL and never gates
  // on stage-slug loading (stageIds arrive directly from the URL); legacy keeps local page + the
  // stage-aware enable gate. goToPage writes wherever the page lives.
  const currentPage = filterBarMode ? urlFilters.page ?? 1 : page;
  const queryEnabled = filterBarMode ? true : listQueryState.enabled;
  const goToPage = filterBarMode ? (next: number) => setFilters({ page: next }) : setPage;

  const legacyDealsArgs: DealFilters = {
    ...baseFilters,
    search,
    stageIds: selectedStageIds,
    inactiveStageIds,
    assignedRepId: effectiveAssignedRepId,
    createdFrom: dateField === "created" ? dateRange.from ?? baseFilters?.createdFrom : baseFilters?.createdFrom,
    createdTo: dateField === "created" ? dateRange.to ?? baseFilters?.createdTo : baseFilters?.createdTo,
    updatedFrom: dateField === "updated" ? dateRange.from ?? baseFilters?.updatedFrom : baseFilters?.updatedFrom,
    updatedTo: dateField === "updated" ? dateRange.to ?? baseFilters?.updatedTo : baseFilters?.updatedTo,
    // D-15: outcome mode routes the window to the canonical outcome-aware filter
    // (dateFrom/dateTo -> buildDealOutcomeDateScope) instead of created/updated, and
    // forces open rows to be bounded on stage_entered_at regardless of the server flag
    // (Codex #564 — otherwise the window leaves every open deal in).
    dateFrom: outcomeDateAxis ? dateRange.from ?? baseFilters?.dateFrom : baseFilters?.dateFrom,
    dateTo: outcomeDateAxis ? dateRange.to ?? baseFilters?.dateTo : baseFilters?.dateTo,
    stageEntryDateWindow: outcomeDateAxis ? true : baseFilters?.stageEntryDateWindow,
    estimateSentFrom: baseFilters?.estimateSentFrom,
    estimateSentTo: baseFilters?.estimateSentTo,
    isActive: isActiveFilter,
    sortBy: sort.key,
    sortDir: sort.dir,
    page,
    limit: pageSize,
    scope,
  };
  // FilterBar mode: URL value -> contract DealFilters (outcome-aware date, status, workflow, value,
  // stalled). baseFilters still layer (parent presets); scope inherits from the page unless the URL
  // sets it; the section owns page/limit. filter-axis == display-axis (displayDate rendered below).
  const filterBarDealsArgs: DealFilters = {
    ...baseFilters,
    ...applyBoardVisibilityDefaults(filterBarValueToDealFilters(urlFilters), {
      defaultStageIds: filterBar?.defaultStageIds,
      terminalStageIds: filterBar?.terminalStageIds,
    }),
    scope: filterBarOwnsScope ? urlFilters.scope ?? scope : scope,
    page: currentPage,
    limit: pageSize,
  };
  const {
    deals: rawDeals,
    pagination,
    loading,
    error,
  } = useDeals(filterBarMode ? filterBarDealsArgs : legacyDealsArgs, { enabled: queryEnabled });

  // Keep the prior rows visible while a refetch is in flight so a search keystroke or
  // filter change never blanks/flashes the list (the hard no-blank requirement, paired
  // with the debounced SearchInput below). isInitialLoading is gated on whether a fetch
  // has settled yet — not on data presence — so the []-seeded hook still shows the first
  // skeleton instead of flashing empty.
  //
  // While the query is disabled (stages still loading) useDeals reports loading=false with
  // an empty []; treat that as "not settled yet" (OR in !enabled) so the empty idle array
  // is not mistaken for a settled fetch — otherwise the FIRST real fetch after stages load
  // would skip the skeleton and flash an empty list.
  const { data: deals, isInitialLoading, isRefreshing } = useKeepPreviousData(
    rawDeals,
    loading || !queryEnabled
  );

  const stageNameById = useMemo(() => buildStageNameById(stages), [stages]);
  const assigneeNameById = useMemo(
    () => new Map(assignees.map((assignee) => [assignee.id, assignee.displayName])),
    [assignees]
  );
  const selectedOwnerLabel =
    ownerId === "__all__" ? "All reps" : assigneeNameById.get(ownerId) ?? "Selected rep";
  const derivedCountSummary =
    paginationCountSummary ??
    (typeof pagination.activeCount === "number"
      ? { active: pagination.activeCount, total: pagination.total }
      : undefined);

  useEffect(() => {
    setPage(1);
  }, [scope]);

  useEffect(() => {
    setPage(1);
  }, [drilldownContextKey]);

  const toggleStage = (slug: string) => {
    setPage(1);
    setStageSlugs((current) =>
      current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]
    );
  };

  // Sort routing: in FilterBar mode the query reads sortBy/sortDir from the URL, so table-header
  // clicks must write the URL too (otherwise the arrow flips but the rows never re-sort). The bar's
  // Sort dropdown and the header clicks then stay in sync. Legacy mode keeps local sort state.
  const activeSort: { key: string | undefined; dir: "asc" | "desc" | undefined } = filterBarMode
    ? { key: urlFilters.sortBy, dir: urlFilters.sortDir }
    : { key: sort.key, dir: sort.dir };
  const updateSort = (key: DealListSortState["key"]) => {
    if (filterBarMode) {
      const dir = urlFilters.sortBy === key && urlFilters.sortDir === "desc" ? "asc" : "desc";
      setFilters({ sortBy: key, sortDir: dir });
      return;
    }
    setSort((current) => ({
      key,
      dir: current.key === key && current.dir === "desc" ? "asc" : "desc",
    }));
  };

  // D-15 (Codex #564): in outcome mode the Newest/Oldest pills order by the outcome
  // DISPLAY date (the axis the list filters + displays), not created_at — clicking them
  // must NOT revert to the created_at axis and re-introduce the filter!=display mismatch.
  const recencySortKey: DealListSortState["key"] = outcomeDateAxis ? "display_date" : "created_at";
  const setCreatedAtSort = (dir: "asc" | "desc") => {
    setPage(1);
    setSort({ key: recencySortKey, dir });
  };

  const restoreUpdatedSort = () => {
    setPage(1);
    setSort((current) => (
      current.key === "updated_at"
        ? { key: "updated_at", dir: current.dir === "desc" ? "asc" : "desc" }
        : { key: "updated_at", dir: "desc" }
    ));
  };

  const isUpdatedSortActive = sort.key === "updated_at";
  const isNewestSortActive = sort.key === recencySortKey && sort.dir === "desc";
  const isOldestSortActive = sort.key === recencySortKey && sort.dir === "asc";

  const exportCsv = async () => {
    // FilterBar mode: export EXACTLY what the list shows — the same #546 filters (outcome-aware date,
    // status, value, …) via fetchAllDealsForFilters, and the canonical displayDate axis in the Date
    // column. Mirrors the on-screen list instead of the legacy created/updated export axis.
    if (filterBarMode) {
      const result = await fetchAllDealsForFilters({ filters: filterBarDealsArgs });
      if (result.truncated) {
        toast.info(
          `Exported first ${result.maxRows.toLocaleString()} rows (${result.pagesFetched} pages). Narrow filters for full export.`
        );
      }
      triggerCsvDownload(buildFilterBarCsvRows(result.deals, { stageNameById, assigneeNameById }), "deals-list.csv");
      return;
    }
    if (!listQueryState.enabled) {
      toast.error(stagesError ? "Pipeline stage metadata failed to load." : "Pipeline stages are still loading.");
      return;
    }
    const exportResult = await fetchAllFilteredDeals({
      search,
      stageIds: selectedStageIds,
      inactiveStageIds,
      assignedRepId: effectiveAssignedRepId,
      dateRange,
      isActive: isActiveFilter,
      sort,
      scope,
      dateField,
      createdFrom: baseFilters?.createdFrom,
      createdTo: baseFilters?.createdTo,
      contractSignedFrom: baseFilters?.contractSignedFrom,
      contractSignedTo: baseFilters?.contractSignedTo,
      wonClosedFrom: baseFilters?.wonClosedFrom,
      wonClosedTo: baseFilters?.wonClosedTo,
      estimateSentFrom: baseFilters?.estimateSentFrom,
      estimateSentTo: baseFilters?.estimateSentTo,
      updatedFrom: baseFilters?.updatedFrom,
      updatedTo: baseFilters?.updatedTo,
      dateFrom: baseFilters?.dateFrom,
      dateTo: baseFilters?.dateTo,
    });
    if (exportResult.truncated) {
      toast.info(
        `Exported first ${exportResult.maxRows.toLocaleString()} rows (${exportResult.pagesFetched} pages). Narrow filters for full export.`
      );
    }
    // Codex #570: in outcome mode the on-screen Date column is the outcome displayDate,
    // so the export's date column must match it (not the legacy "Last Touch"/updated axis),
    // or the CSV won't reconcile with the drill-down it was exported from.
    const rows = [
      ["Deal", "Project Number", "Owner", "Stage", "Days", "Value", showOutcomeDate ? "Date" : "Last Touch"],
      ...exportResult.deals.map((deal) => {
        const displayNumber = getDealDisplayNumber(deal);
        return [
          deal.name,
          displayNumber.label,
          deal.assignedRepName ?? assigneeNameById.get(deal.assignedRepId) ?? "",
          deal.stageName ?? stageNameById.get(deal.stageId) ?? "",
          effectiveStageAgeDays(deal),
          getEffectiveDealValue(deal),
          showOutcomeDate ? getDealDisplayDate(deal) ?? "" : deal.lastActivityAt ?? deal.updatedAt,
        ];
      }),
    ];
    triggerCsvDownload(rows, "deals-list.csv");
  };

  const sortHeader = (key: DealListSortState["key"], label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-black uppercase tracking-[0.16em] text-slate-500 hover:text-brand-red"
      onClick={() => updateSort(key)}
    >
      {label}
      {activeSort.key === key ? <span>{activeSort.dir === "asc" ? "↑" : "↓"}</span> : null}
    </button>
  );

  const tableColumns: Array<PipelineStageTableColumn<Deal>> = [
    {
      key: "name",
      header: sortHeader("name", "Deal"),
      headClassName: "md:w-[13.5rem] md:!px-2 lg:w-[15rem] lg:!px-3",
      cellClassName: "md:w-[13.5rem] md:!px-2 lg:w-[15rem] lg:!px-3",
      render: (deal) => {
        const displayNumber = getDealDisplayNumber(deal);
        const propertyLabel = getDealPropertyLabel(deal);
        return (
          <div className="min-w-0 space-y-1">
            <p className="truncate whitespace-nowrap font-black text-slate-950" aria-label={deal.name} title={deal.name}>
              {deal.name}
            </p>
            <p
              className={cn(
                "truncate whitespace-nowrap text-xs font-bold uppercase tracking-[0.12em]",
                displayNumber.isFallback ? "text-slate-400" : "text-brand-red"
              )}
              aria-label={displayNumber.label || "--"}
              title={displayNumber.label || "--"}
            >
              {displayNumber.label || "--"}
            </p>
            <p
              className="truncate whitespace-nowrap text-xs font-medium text-slate-500"
              aria-label={propertyLabel}
              title={propertyLabel}
            >
              {propertyLabel}
            </p>
            <AtRiskBadge atRisk={deal.atRisk} compact />
          </div>
        );
      },
    },
    {
      key: "description",
      header: "Description",
      headClassName: "hidden lg:table-cell lg:w-[11rem] lg:!px-3",
      cellClassName: "hidden lg:table-cell lg:w-[11rem] lg:!px-3",
      render: (deal) => renderDescriptionPreview(deal.description),
    },
    {
      key: "owner",
      header: "Owner",
      headClassName: "md:w-[4rem] md:!px-2 lg:w-[7.5rem] lg:!px-3",
      cellClassName: "md:w-[4rem] md:!px-2 lg:w-[7.5rem] lg:!px-3",
      render: (deal) => {
        const ownerName = deal.assignedRepName ?? assigneeNameById.get(deal.assignedRepId) ?? "Unassigned";
        const ownerColor = getOwnerInitialColor(deal.assignedRepId ?? ownerName);
        return (
          <div className="flex items-center gap-2 md:justify-center lg:justify-start" aria-label={ownerName} title={ownerName}>
            <Avatar size="sm" className="bg-slate-100">
              <AvatarFallback style={{ backgroundColor: ownerColor.backgroundColor, color: ownerColor.textColor }}>
                {initials(ownerName)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden truncate whitespace-nowrap text-sm font-medium text-slate-700 lg:inline">
              {ownerName}
            </span>
          </div>
        );
      },
    },
    {
      key: "stage",
      header: "Stage",
      headClassName: "md:w-[8rem] md:!px-2 lg:w-[8.5rem] lg:!px-3",
      cellClassName: "md:w-[8rem] md:!px-2 lg:w-[8.5rem] lg:!px-3",
      render: (deal) =>
        renderStageChip(deal.stageName ?? stageNameById.get(deal.stageId) ?? deal.stageSlug ?? "Stage"),
    },
    {
      key: "days",
      header: sortHeader("stage_entered_at", "Days"),
      headClassName: "hidden lg:table-cell lg:w-[3rem] lg:!px-3 lg:text-right",
      cellClassName: "hidden lg:table-cell lg:w-[3rem] lg:!px-3 lg:text-right",
      render: (deal) => (
        <span className="inline-flex justify-end whitespace-nowrap font-medium tabular-nums text-slate-500">
          {effectiveStageAgeDays(deal)}d
        </span>
      ),
    },
    {
      key: "value",
      header: sortHeader("awarded_amount", "Value"),
      headClassName: "md:w-[5.75rem] md:!px-2 md:text-right lg:w-[6rem] lg:!px-3",
      cellClassName: "md:w-[5.75rem] md:!px-2 md:text-right lg:w-[6rem] lg:!px-3",
      render: (deal) => (
        <DealValue
          deal={deal}
          value={getEffectiveDealValue(deal)}
          compact
          className="inline-flex justify-end whitespace-nowrap font-black tabular-nums text-slate-950"
        />
      ),
    },
    {
      key: "closeDate",
      // FilterBar mode AND the legacy "outcome" axis (D-15 rep drill-down) show the
      // outcome-aware date axis (Won->signed, Lost->lost, open->stage-entry) that they
      // ALSO filter on, so the header is the honest "Date"; other legacy stays "Close".
      header: showOutcomeDate ? "Date" : "Close",
      headClassName: "md:w-[4.75rem] md:!px-2 md:text-right lg:w-[5rem] lg:!px-3",
      cellClassName: "md:w-[4.75rem] md:!px-2 md:text-right lg:w-[5rem] lg:!px-3",
      render: (deal) => (
        <span className="inline-flex justify-end whitespace-nowrap text-sm font-medium text-slate-600">
          {formatShortDate(showOutcomeDate ? getDealDisplayDate(deal) : getDealCloseDate(deal))}
        </span>
      ),
    },
  ];

  const filterGridClass = enableDateFilter
    ? "lg:grid-cols-[minmax(18rem,1fr)_220px_220px]"
    : "lg:grid-cols-[minmax(18rem,1fr)_220px]";

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-col gap-4 border-b border-gray-200 p-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-red">
            {eyebrow}
          </p>
          <h2 className="mt-1 text-xl font-black uppercase text-slate-950">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-sm font-medium text-slate-500">{subtitle}</p>
          ) : null}
        </div>
        {enableExport ? (
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 hover:border-brand-red/40 hover:text-brand-red focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          >
            <Download className="h-4 w-4" />
            Export
          </button>
        ) : null}
      </div>

      {filterBarMode && filterBar ? (
        <div className="border-b border-gray-200 bg-[#f7f8fb] p-4">
          <FilterBar
            dimensions={filterBar.dimensions}
            options={filterBar.options}
            value={urlFilters}
            onChange={setFilters}
            // Preserve any param the bar inherits but does not render (e.g. the board-owned `scope`
            // on the pipeline page) so Clear resets only this list's dimensions, not the kanban.
            onReset={() => resetFilters(filterBarOwnsScope ? [] : ["scope"])}
            stageEntryDateEnabled={filterBar.stageEntryDateEnabled}
          />
        </div>
      ) : null}

      {!filterBarMode && (
      <>
      <div className={cn("grid gap-3 border-b border-gray-200 bg-[#f7f8fb] p-4", filterGridClass)}>
        <label className="space-y-2">
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
          <SearchInput
            value={search}
            onChange={(value) => {
              setPage(1);
              setSearch(value);
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
        </label>

        {hideOwnerFilter ? null : (
          <label className="space-y-2">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Owner</span>
            <Select
              value={ownerId}
              onValueChange={(value) => {
                setPage(1);
                setOwnerId(value ?? "__all__");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="All reps">{selectedOwnerLabel}</SelectValue>
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
          </label>
        )}

        {enableDateFilter ? (
          <label className="space-y-2">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Date</span>
            <TerminalDateFilterControl
              stageName="List"
              filter={dateFilter}
              onFilterChange={(filter) => {
                setPage(1);
                setDateFilter(filter);
              }}
              buttonClassName="h-10 w-full justify-between rounded-md"
            />
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-b border-gray-200 px-4 py-3">
        <button
          type="button"
          aria-pressed={stageSlugs.length === 0}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
            stageSlugs.length === 0
              ? "border-brand-red bg-brand-red text-white"
              : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
          )}
          onClick={() => {
            setPage(1);
            setStageSlugs([]);
          }}
        >
          All
        </button>
        {stageFilterOptions.map((stage) => {
          const active = stageSlugs.includes(stage.slug);
          return (
            <button
              key={stage.slug}
              type="button"
              aria-pressed={active}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
                active
                  ? "border-brand-red bg-brand-red text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
              )}
              onClick={() => toggleStage(stage.slug)}
            >
              {stage.name}
            </button>
          );
        })}
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
              isNewestSortActive
                ? "border-brand-red bg-brand-red text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
            )}
            onClick={() => setCreatedAtSort("desc")}
          >
            Newest
          </button>
          <button
            type="button"
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
              isOldestSortActive
                ? "border-brand-red bg-brand-red text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
            )}
            onClick={() => setCreatedAtSort("asc")}
          >
            Oldest
          </button>
          {/* D-15 (Codex #564): the updated_at quick-sort is not the outcome axis, so
              it is hidden in outcome mode (Newest/Oldest already order by the outcome date). */}
          {outcomeDateAxis ? null : (
            <button
              type="button"
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
                isUpdatedSortActive
                  ? "border-brand-red bg-brand-red text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
              )}
              onClick={restoreUpdatedSort}
            >
              Updated {isUpdatedSortActive ? (sort.dir === "asc" ? "↑" : "↓") : null}
            </button>
          )}
        </div>
      </div>
      </>
      )}

      <div className="p-4" aria-busy={isRefreshing}>
        {error ? (
          <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
            {error}
          </div>
        ) : stagesError && !queryEnabled ? (
          <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
            Pipeline stage metadata failed to load.
          </div>
        ) : !queryEnabled || isInitialLoading ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
            Loading deals...
          </div>
        ) : (
          <>
            <div className="space-y-3 md:hidden" aria-label="Deals list cards">
              {deals.map((deal) => {
                const displayNumber = getDealDisplayNumber(deal);
                const ownerName = deal.assignedRepName ?? assigneeNameById.get(deal.assignedRepId) ?? "Unassigned";
                const ownerColor = getOwnerInitialColor(deal.assignedRepId ?? ownerName);
                const propertyLabel = getDealPropertyLabel(deal);
                const stageLabel = deal.stageName ?? stageNameById.get(deal.stageId) ?? deal.stageSlug ?? "Stage";
                return (
                  <button
                    key={deal.id}
                    type="button"
                    className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-left transition hover:border-brand-red/30 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
                    onClick={() => navigate(`/deals/${deal.id}`)}
                    aria-label={`Open deal ${deal.name}`}
                  >
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <p className="line-clamp-2 text-sm font-black leading-5 text-slate-950" aria-label={deal.name} title={deal.name}>
                          {deal.name}
                        </p>
                        <p
                          className={cn(
                            "truncate whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.12em]",
                            displayNumber.isFallback ? "text-slate-400" : "text-brand-red"
                          )}
                          aria-label={displayNumber.label || "--"}
                          title={displayNumber.label || "--"}
                        >
                          {displayNumber.label || "--"}
                        </p>
                      </div>

                      <div className="space-y-3">
                        <div className="flex min-w-0 items-start gap-2 text-xs font-medium text-slate-500">
                          <MapPin className="mt-0.5 h-3.5 w-3.5 flex-none text-slate-400" />
                          <span className="min-w-0 truncate" aria-label={propertyLabel} title={propertyLabel}>
                            {propertyLabel}
                          </span>
                        </div>

                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <Avatar size="sm" className="bg-slate-100">
                              <AvatarFallback style={{ backgroundColor: ownerColor.backgroundColor, color: ownerColor.textColor }}>
                                {initials(ownerName)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="truncate text-sm font-medium text-slate-700" aria-label={ownerName} title={ownerName}>
                              {ownerName}
                            </span>
                          </div>
                          <DealValue
                            deal={deal}
                            value={getEffectiveDealValue(deal)}
                            compact
                            className="whitespace-nowrap text-right text-sm font-black tabular-nums text-slate-950"
                          />
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {renderStageChip(stageLabel)}
                          <AtRiskBadge atRisk={deal.atRisk} compact />
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-3 text-xs font-medium text-slate-500">
                        <span className="inline-flex items-center gap-1 whitespace-nowrap">
                          <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
                          {formatShortDate(showOutcomeDate ? getDealDisplayDate(deal) : getDealCloseDate(deal))}
                        </span>
                        <span className="inline-flex items-center gap-1 whitespace-nowrap text-right">
                          <Clock3 className="h-3.5 w-3.5 text-slate-400" />
                          {effectiveStageAgeDays(deal)}d SLA
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <PipelineStageTable
                rows={deals}
                columns={tableColumns}
                tableClassName="table-fixed w-full md:min-w-[44rem] lg:min-w-[58rem] xl:min-w-0"
                showPagination={false}
                pagination={{
                  page: pagination.page,
                  pageSize: pagination.limit,
                  total: pagination.total,
                  totalPages: pagination.totalPages,
                }}
                onPageChange={goToPage}
                onRowClick={(deal) => navigate(`/deals/${deal.id}`)}
                getRowKey={(deal) => deal.id}
              />
            </div>
            <DealsListPagination
              page={pagination.page}
              total={pagination.total}
              totalPages={pagination.totalPages || 1}
              countSummary={derivedCountSummary}
              onPageChange={goToPage}
            />
          </>
        )}
      </div>
    </section>
  );
}
