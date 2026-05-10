import { useState, useCallback, useEffect, useRef, useLayoutEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDroppable, useDraggable } from "@dnd-kit/core";
import { ArrowRight, Download, GripVertical, Plus, Search } from "lucide-react";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { TerminalDateFilterControl } from "@/components/pipeline/terminal-date-filter-control";
import { PipelineStageTable, type PipelineStageTableColumn } from "@/components/pipeline/pipeline-stage-table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatCurrencyCompact, bestEstimate, daysInStage } from "@/lib/deal-utils";
import {
  buildDealStageWorkspacePath,
  buildPipelineRequestPath,
  daysAgo,
  getActivePipelineColumns,
  getTerminalDateFilterLabel,
  isTerminalOutcomeSlug,
  readTerminalDateFilter,
  writeTerminalDateFilter,
  type TerminalDateFilter,
  type TerminalOutcome,
} from "@/lib/pipeline-terminal-filters";
import { useDeals, type Deal } from "@/hooks/use-deals";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { cn } from "@/lib/utils";

interface PipelineColumn {
  stage: {
    id: string;
    name: string;
    slug: string;
    color: string | null;
    displayOrder: number;
    isActivePipeline: boolean;
    isTerminal?: boolean;
  };
  deals: Deal[];
  totalValue: number;
  count: number;
}

interface TerminalStageInfo {
  stage: { id: string; name: string; slug: string };
  deals: Deal[];
  count: number;
}

const PIPELINE_LIST_PAGE_SIZE = 25;
const DEAL_STAGE_ORDER = [
  "opportunity",
  "estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
];

type SortKey = "name" | "stage_entered_at" | "awarded_amount" | "updated_at";
type SortState = { key: SortKey; dir: "asc" | "desc" };

export function getDealDisplayNumber(deal: Pick<Deal, "dealNumber" | "projectNumber">) {
  const projectNumber = deal.projectNumber?.trim();
  if (projectNumber) return { label: projectNumber, isFallback: false };
  return { label: deal.dealNumber ?? "", isFallback: true };
}

function dateRangeFromTerminalFilter(filter: TerminalDateFilter) {
  if (filter.preset === "all") return {};
  if (filter.preset === "custom") {
    return { from: filter.customStart || undefined, to: filter.customEnd || undefined };
  }
  return { from: daysAgo(Number(filter.preset)) };
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function escapeCsvCell(value: string | number | null | undefined) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildDealListParams(input: {
  search: string;
  stageIds: string[];
  assignedRepId?: string;
  dateRange: { from?: string; to?: string };
  sort: SortState;
  page: number;
  limit: number;
}) {
  const params = new URLSearchParams();
  if (input.search) params.set("search", input.search);
  if (input.stageIds.length) params.set("stageIds", input.stageIds.join(","));
  if (input.assignedRepId) params.set("assignedRepId", input.assignedRepId);
  if (input.dateRange.from) params.set("updatedFrom", input.dateRange.from);
  if (input.dateRange.to) params.set("updatedTo", input.dateRange.to);
  params.set("isActive", "true");
  params.set("sortBy", input.sort.key);
  params.set("sortDir", input.sort.dir);
  params.set("page", String(input.page));
  params.set("limit", String(input.limit));
  return params;
}

export function summarizeTerminalStageCounts(terminalStages: TerminalStageInfo[]) {
  const wonStageSlugs = ["won", "sent_to_production", "service_sent_to_production", "closed_won"];
  const lostStageSlugs = ["lost", "production_lost", "service_lost", "closed_lost"];
  const won = terminalStages
    .filter((ts) => wonStageSlugs.includes(ts.stage.slug))
    .reduce((sum, ts) => sum + ts.count, 0);
  const lost = terminalStages
    .filter((ts) => lostStageSlugs.includes(ts.stage.slug))
    .reduce((sum, ts) => sum + ts.count, 0);

  return { won, lost };
}

export function summarizeActivePipelineColumns(columns: PipelineColumn[]) {
  const activeColumns = getActivePipelineColumns(columns);
  const totalDeals = activeColumns.reduce((sum, col) => sum + col.count, 0);
  const totalValue = activeColumns.reduce((sum, col) => sum + col.totalValue, 0);
  const allDeals = activeColumns.flatMap((col) => col.deals);
  const averageVelocity =
    allDeals.length === 0
      ? 0
      : Math.round(
          allDeals.reduce((sum, deal) => sum + daysInStage(deal.stageEnteredAt), 0) / allDeals.length
        );

  return { totalDeals, totalValue, averageVelocity };
}

async function fetchAllFilteredDeals(input: {
  search: string;
  stageIds: string[];
  assignedRepId?: string;
  dateRange: { from?: string; to?: string };
  sort: SortState;
}) {
  const limit = 500;
  const firstParams = buildDealListParams({ ...input, page: 1, limit });
  const first = await api<{ deals: Deal[]; pagination: { totalPages: number } }>(
    `/deals?${firstParams.toString()}`
  );
  const pages = [first.deals];
  const totalPages = Math.max(1, first.pagination.totalPages || 1);

  for (let page = 2; page <= totalPages; page += 1) {
    const params = buildDealListParams({ ...input, page, limit });
    const next = await api<{ deals: Deal[]; pagination: { totalPages: number } }>(
      `/deals?${params.toString()}`
    );
    pages.push(next.deals);
  }

  return pages.flat();
}

function formatRefreshedLabel(date: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes === 1) return "Updated 1m ago";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "Updated 1h ago" : `Updated ${hours}h ago`;
}

function PipelineCard({
  deal,
  isDragging,
}: {
  deal: Deal;
  isDragging?: boolean;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: deal.id,
    data: { deal },
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 50 }
    : undefined;

  const days = daysInStage(deal.stageEnteredAt);
  const value = bestEstimate(deal);
  const displayNumber = getDealDisplayNumber(deal);

  const metaParts = [];
  if (deal.propertyCity) metaParts.push(deal.propertyCity);
  metaParts.push(`${days}d in stage`);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative bg-white border border-gray-200 cursor-pointer hover:border-gray-300 ${
        isDragging ? "opacity-60" : ""
      }`}
      onClick={() => navigate(`/deals/${deal.id}`)}
    >
      <button
        {...attributes}
        {...listeners}
        className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 z-10"
        onClick={(e) => e.stopPropagation()}
        aria-label="Drag deal"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <div className="px-3 py-2.5 pl-5">
        {displayNumber.label ? (
          <p
            className={cn(
              "mb-1 truncate text-[10px] font-black uppercase tracking-[0.16em]",
              displayNumber.isFallback ? "text-gray-400" : "text-brand-red"
            )}
          >
            {displayNumber.label}
          </p>
        ) : null}
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-gray-900 truncate">{deal.name}</p>
          <span className="text-sm font-semibold text-gray-900 tabular-nums whitespace-nowrap">
            {formatCurrencyCompact(value)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-gray-500 truncate">{metaParts.join(" · ")}</p>
      </div>
    </div>
  );
}

function DroppableColumn({
  column,
  activeDealId,
  onOpenStage,
  terminalFilter,
  onTerminalFilterChange,
}: {
  column: PipelineColumn;
  activeDealId: string | null;
  onOpenStage: (stageId: string) => void;
  terminalFilter?: TerminalDateFilter;
  onTerminalFilterChange?: (filter: TerminalDateFilter) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: column.stage.id });
  const cardsRef = useRef<HTMLDivElement>(null);
  const [overflowState, setOverflowState] = useState<{
    showTopFade: boolean;
    showBottomFade: boolean;
  }>({ showTopFade: false, showBottomFade: false });

  const recomputeOverflow = useCallback(() => {
    const el = cardsRef.current;
    if (!el) {
      setOverflowState({ showTopFade: false, showBottomFade: false });
      return;
    }
    const overflow = el.scrollHeight > el.clientHeight + 1;
    if (!overflow) {
      setOverflowState({ showTopFade: false, showBottomFade: false });
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    setOverflowState({
      showTopFade: el.scrollTop > 1,
      showBottomFade: distanceFromBottom > 1,
    });
  }, []);

  useLayoutEffect(() => {
    const el = cardsRef.current;
    if (!el) return;
    recomputeOverflow();
    const observer = new ResizeObserver(recomputeOverflow);
    observer.observe(el);
    for (const child of Array.from(el.children)) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [column.deals.length, recomputeOverflow]);
  const terminalOutcome = isTerminalOutcomeSlug(column.stage.slug) ? column.stage.slug : null;
  const terminalLabel = terminalFilter ? getTerminalDateFilterLabel(terminalFilter) : null;

  return (
    <div
      ref={setNodeRef}
      className={`flex-shrink-0 w-80 h-full flex flex-col bg-gray-50/60 border border-gray-200 ${
        isOver ? "ring-2 ring-brand-red/40 ring-offset-1" : ""
      }`}
    >
      <div className="sticky top-0 z-10 bg-gray-50/95 backdrop-blur-sm border-b border-gray-200 px-3 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="text-left text-xs font-medium uppercase tracking-wide text-gray-500 hover:text-gray-900 truncate"
            onClick={() => onOpenStage(column.stage.id)}
          >
            {column.stage.name}
            {terminalLabel ? <span className="ml-1 text-gray-400">· {terminalLabel}</span> : null}
          </button>
          <span className="text-xs font-medium text-gray-600 bg-gray-200/70 px-1.5 py-0.5 rounded-sm tabular-nums">
            {column.count}
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
        <p className="mt-1 text-xl font-semibold text-gray-900 tabular-nums">
          {formatCurrencyCompact(column.totalValue)}
        </p>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={cardsRef}
          onScroll={recomputeOverflow}
          className="absolute inset-0 px-2 py-2 space-y-2 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        >
          {column.deals.map((deal) => (
            <PipelineCard
              key={deal.id}
              deal={deal}
              isDragging={activeDealId === deal.id}
            />
          ))}

          {column.deals.length === 0 && (
            <div className="text-center py-8 text-xs text-gray-400 border border-dashed border-gray-200">
              No deals
            </div>
          )}
        </div>

        {overflowState.showTopFade && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-gray-50 to-transparent"
          />
        )}
        {overflowState.showBottomFade && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-gray-50 to-transparent"
          />
        )}
      </div>
    </div>
  );
}

export function PipelinePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [columns, setColumns] = useState<PipelineColumn[]>([]);
  const [terminalStages, setTerminalStages] = useState<TerminalStageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDd, setShowDd] = useState(searchParams.get("showDd") === "1");
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ deal: Deal; targetStageId: string } | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [now, setNow] = useState<Date>(new Date());
  const [terminalDateFilters, setTerminalDateFilters] = useState<Record<TerminalOutcome, TerminalDateFilter>>(() => ({
    won: readTerminalDateFilter("won"),
    lost: readTerminalDateFilter("lost"),
  }));
  const [listSearch, setListSearch] = useState("");
  const [listStageSlugs, setListStageSlugs] = useState<string[]>([]);
  const [listOwnerId, setListOwnerId] = useState("__all__");
  const [listDateFilter, setListDateFilter] = useState<TerminalDateFilter>({ preset: "all" });
  const [listPage, setListPage] = useState(1);
  const [listSort, setListSort] = useState<SortState>({ key: "updated_at", dir: "desc" });
  const { assignees } = useTaskAssignees();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const stageFilterOptions = useMemo(() => {
    return [...columns]
      .sort((left, right) => {
        const leftIndex = DEAL_STAGE_ORDER.indexOf(left.stage.slug);
        const rightIndex = DEAL_STAGE_ORDER.indexOf(right.stage.slug);
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      })
      .filter((column, index, all) => all.findIndex((item) => item.stage.slug === column.stage.slug) === index)
      .map((column) => ({ id: column.stage.id, slug: column.stage.slug, name: column.stage.name }));
  }, [columns]);

  const selectedStageIds = useMemo(
    () =>
      stageFilterOptions
        .filter((stage) => listStageSlugs.includes(stage.slug))
        .map((stage) => stage.id),
    [listStageSlugs, stageFilterOptions]
  );
  const listDateRange = useMemo(() => dateRangeFromTerminalFilter(listDateFilter), [listDateFilter]);
  const {
    deals: listDeals,
    pagination: listPagination,
    loading: listLoading,
    error: listError,
  } = useDeals({
    search: listSearch,
    stageIds: selectedStageIds,
    assignedRepId: listOwnerId === "__all__" ? undefined : listOwnerId,
    updatedFrom: listDateRange.from,
    updatedTo: listDateRange.to,
    isActive: true,
    sortBy: listSort.key,
    sortDir: listSort.dir,
    page: listPage,
    limit: PIPELINE_LIST_PAGE_SIZE,
  });
  const assigneeNameById = useMemo(
    () => new Map(assignees.map((assignee) => [assignee.id, assignee.displayName])),
    [assignees]
  );
  const stageNameById = useMemo(
    () => new Map(stageFilterOptions.map((stage) => [stage.id, stage.name])),
    [stageFilterOptions]
  );

  const mainScrollRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const innerWidthSpacerRef = useRef<HTMLDivElement>(null);
  const isSyncingScrollRef = useRef(false);

  const fetchPipeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{
        pipelineColumns: PipelineColumn[];
        terminalStages: TerminalStageInfo[];
      }>(buildPipelineRequestPath(showDd, terminalDateFilters));
      setColumns(data.pipelineColumns);
      setTerminalStages(data.terminalStages ?? []);
      setLastRefreshed(new Date());
    } catch (err) {
      console.error("Failed to load pipeline:", err);
      setError("Failed to load pipeline data. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [showDd, terminalDateFilters]);

  const updateTerminalDateFilter = useCallback((outcome: TerminalOutcome, filter: TerminalDateFilter) => {
    writeTerminalDateFilter(outcome, filter);
    setTerminalDateFilters((current) => ({ ...current, [outcome]: filter }));
  }, []);

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  useEffect(() => {
    setShowDd(searchParams.get("showDd") === "1");
  }, [searchParams]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  // Sync top scroll proxy width to the main scroll container's content width.
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
  }, [columns.length]);

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

  const handleDragStart = (event: DragStartEvent) => {
    const deal = event.active.data.current?.deal as Deal;
    setActiveDeal(deal);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDeal(null);
    const { active, over } = event;
    if (!over) return;

    const deal = active.data.current?.deal as Deal;
    const targetStageId = over.id as string;

    if (deal.stageId === targetStageId) return;

    setPendingMove({ deal, targetStageId });
    setStageChangeOpen(true);
  };

  const handleStageChangeSuccess = () => {
    setStageChangeOpen(false);
    setPendingMove(null);
    fetchPipeline();
  };

  const {
    totalDeals,
    totalValue,
    averageVelocity: avgVelocity,
  } = summarizeActivePipelineColumns(columns);

  const { won, lost } = summarizeTerminalStageCounts(terminalStages);
  const successRate = (() => {
    const total = won + lost;
    if (total === 0) return null;
    return Math.round((won / total) * 100);
  })();

  const toggleListStage = (slug: string) => {
    setListPage(1);
    setListStageSlugs((current) =>
      current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]
    );
  };

  const updateListSort = (key: SortKey) => {
    setListSort((current) => ({
      key,
      dir: current.key === key && current.dir === "desc" ? "asc" : "desc",
    }));
  };

  const exportListCsv = async () => {
    const exportDeals = await fetchAllFilteredDeals({
      search: listSearch,
      stageIds: selectedStageIds,
      assignedRepId: listOwnerId === "__all__" ? undefined : listOwnerId,
      dateRange: listDateRange,
      sort: listSort,
    });
    const rows = [
      ["Deal", "Project Number", "Owner", "Stage", "Days", "Value", "Last Touch"],
      ...exportDeals.map((deal) => {
        const displayNumber = getDealDisplayNumber(deal);
        return [
          deal.name,
          displayNumber.label,
          deal.assignedRepName ?? assigneeNameById.get(deal.assignedRepId) ?? "",
          deal.stageName ?? stageNameById.get(deal.stageId) ?? "",
          daysInStage(deal.stageEnteredAt),
          bestEstimate(deal),
          deal.lastActivityAt ?? deal.updatedAt,
        ];
      }),
    ];
    const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "deals-pipeline-list.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const sortHeader = (key: SortKey, label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-black uppercase tracking-[0.16em] text-slate-500 hover:text-brand-red"
      onClick={() => updateListSort(key)}
    >
      {label}
      {listSort.key === key ? <span>{listSort.dir === "asc" ? "↑" : "↓"}</span> : null}
    </button>
  );

  const listColumns: Array<PipelineStageTableColumn<Deal>> = [
    {
      key: "name",
      header: sortHeader("name", "Deal"),
      render: (deal) => {
        const displayNumber = getDealDisplayNumber(deal);
        return (
          <div className="min-w-0 space-y-1">
            <p className="truncate font-black text-slate-950">{deal.name}</p>
            <p
              className={cn(
                "truncate text-xs font-bold uppercase tracking-[0.12em]",
                displayNumber.isFallback ? "text-slate-400" : "text-brand-red"
              )}
            >
              {displayNumber.label || "--"}
            </p>
            <p className="truncate text-xs font-medium text-slate-500">
              {deal.companyName || [deal.propertyCity, deal.propertyState].filter(Boolean).join(", ") || "Account pending"}
            </p>
          </div>
        );
      },
    },
    {
      key: "owner",
      header: "Owner",
      render: (deal) => deal.assignedRepName ?? assigneeNameById.get(deal.assignedRepId) ?? "Unassigned",
    },
    {
      key: "stage",
      header: "Stage",
      render: (deal) => (
        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
          {deal.stageName ?? stageNameById.get(deal.stageId) ?? deal.stageSlug ?? "Stage"}
        </span>
      ),
    },
    {
      key: "days",
      header: sortHeader("stage_entered_at", "Days"),
      render: (deal) => `${daysInStage(deal.stageEnteredAt)}d`,
    },
    {
      key: "value",
      header: sortHeader("awarded_amount", "Value"),
      render: (deal) => (
        <span className="tabular-nums font-black text-slate-950">
          {formatCurrencyCompact(bestEstimate(deal))}
        </span>
      ),
    },
    {
      key: "lastTouch",
      header: sortHeader("updated_at", "Last Touch"),
      render: (deal) => formatShortDate(deal.lastActivityAt ?? deal.updatedAt),
    },
  ];

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="h-8 w-48 bg-gray-100 animate-pulse rounded" />
        <div className="flex gap-3 overflow-x-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-80 h-[500px] bg-gray-100 animate-pulse flex-shrink-0" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="border border-red-200 bg-red-50 p-6 text-center text-red-600 text-sm">
          {error}
          <button
            onClick={fetchPipeline}
            className="ml-3 underline hover:no-underline font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const refreshedLabel = formatRefreshedLabel(lastRefreshed, now);

  return (
    <div className="space-y-5 -m-4 bg-[#f5f6f8] p-4 md:-m-6 md:p-6">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-6 py-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-gray-900">Deal Pipeline</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {totalDeals} deals · {formatCurrencyCompact(totalValue)} total
          </p>
        </div>

        <div className="flex items-center gap-4">
          <span className="hidden md:inline text-xs text-gray-500 tabular-nums">
            {refreshedLabel}
          </span>

          <div className="flex items-center gap-2 px-3 py-1.5 border border-gray-200 rounded-sm">
            <label htmlFor="show-dd-toggle" className="text-xs text-gray-600 select-none">
              Show DD
            </label>
            <button
              id="show-dd-toggle"
              role="switch"
              aria-checked={showDd}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                if (showDd) next.delete("showDd");
                else next.set("showDd", "1");
                setSearchParams(next);
              }}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red ${
                showDd ? "bg-brand-red" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  showDd ? "translate-x-3.5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          <button
            onClick={() => navigate("/deals/new")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-red hover:bg-brand-red/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" />
            New Deal
          </button>
        </div>
      </header>

      {/* Board: top scrollbar proxy + scroll container */}
      <section className="relative flex h-[min(72vh,56rem)] min-h-[42rem] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div
          ref={topScrollRef}
          onScroll={handleTopScroll}
          className="overflow-x-auto overflow-y-hidden border-b border-gray-100 flex-shrink-0"
          aria-hidden="true"
        >
          <div ref={innerWidthSpacerRef} style={{ height: 1 }} />
        </div>

        <div
          ref={mainScrollRef}
          onScroll={handleMainScroll}
          className="flex-1 overflow-x-auto overflow-y-hidden min-h-0 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        >
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex gap-3 p-4 h-full" style={{ minWidth: "max-content" }}>
              {columns.map((column) => (
                <DroppableColumn
                  key={column.stage.id}
                  column={column}
                  activeDealId={activeDeal?.id ?? null}
                  onOpenStage={(stageId) =>
                    navigate(
                      buildDealStageWorkspacePath({
                        stageId,
                        stageSlug: column.stage.slug,
                        filters: terminalDateFilters,
                      })
                    )
                  }
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

            <DragOverlay>
              {activeDeal && <PipelineCard deal={activeDeal} isDragging />}
            </DragOverlay>
          </DndContext>
        </div>
      </section>

      {/* Footer */}
      <footer className="rounded-lg border border-gray-200 bg-white px-6 py-3">
        <dl className="flex items-center gap-8">
          <div className="flex items-baseline gap-2">
            <dt className="text-xs text-gray-500 uppercase tracking-wide">Active</dt>
            <dd className="text-base font-semibold text-gray-900 tabular-nums">{totalDeals}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-xs text-gray-500 uppercase tracking-wide">Avg velocity</dt>
            <dd className="text-base font-semibold text-gray-900 tabular-nums">
              {avgVelocity}
              <span className="ml-1 text-xs font-normal text-gray-500">days</span>
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-xs text-gray-500 uppercase tracking-wide">Success</dt>
            <dd className="text-base font-semibold text-gray-900 tabular-nums">
              {successRate != null ? `${successRate}%` : "—"}
            </dd>
          </div>
        </dl>
      </footer>

      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="flex flex-col gap-4 border-b border-gray-200 p-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-red">
              Deal list
            </p>
            <h2 className="mt-1 text-xl font-black uppercase text-slate-950">Pipeline records</h2>
            <p className="mt-1 text-sm font-medium text-slate-500">
              Filter and scan deals without changing the kanban above.
            </p>
          </div>
          <button
            type="button"
            onClick={exportListCsv}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 hover:border-brand-red/40 hover:text-brand-red focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          >
            <Download className="h-4 w-4" />
            Export
          </button>
        </div>

        <div className="grid gap-3 border-b border-gray-200 bg-[#f7f8fb] p-4 lg:grid-cols-[minmax(18rem,1fr)_220px_220px]">
          <label className="space-y-2">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={listSearch}
                onChange={(event) => {
                  setListPage(1);
                  setListSearch(event.target.value);
                }}
                placeholder="Deal name, number, company, address"
                className="pl-9"
              />
            </div>
          </label>

          <label className="space-y-2">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Owner</span>
            <Select
              value={listOwnerId}
              onValueChange={(value) => {
                setListPage(1);
                setListOwnerId(value ?? "__all__");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="All reps" />
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

          <label className="space-y-2">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Date</span>
            <TerminalDateFilterControl
              stageName="List"
              filter={listDateFilter}
              onFilterChange={(filter) => {
                setListPage(1);
                setListDateFilter(filter);
              }}
              buttonClassName="h-10 w-full justify-between rounded-md"
            />
          </label>

        </div>

        <div className="flex flex-wrap gap-2 border-b border-gray-200 px-4 py-3">
          <button
            type="button"
            aria-pressed={listStageSlugs.length === 0}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
              listStageSlugs.length === 0
                ? "border-brand-red bg-brand-red text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
            )}
            onClick={() => {
              setListPage(1);
              setListStageSlugs([]);
            }}
          >
            All
          </button>
          {stageFilterOptions.map((stage) => {
            const active = listStageSlugs.includes(stage.slug);
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
                onClick={() => toggleListStage(stage.slug)}
              >
                {stage.name}
              </button>
            );
          })}
        </div>

        <div className="p-4">
          {listError ? (
            <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
              {listError}
            </div>
          ) : listLoading ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
              Loading deals...
            </div>
          ) : (
            <PipelineStageTable
              rows={listDeals}
              columns={listColumns}
              pagination={{
                page: listPagination.page,
                pageSize: listPagination.limit,
                total: listPagination.total,
                totalPages: listPagination.totalPages,
              }}
              onPageChange={setListPage}
              onRowClick={(deal) => navigate(`/deals/${deal.id}`)}
              getRowKey={(deal) => deal.id}
            />
          )}
        </div>
      </section>

      {stageChangeOpen && pendingMove && (
        <StageChangeDialog
          deal={pendingMove.deal}
          targetStageId={pendingMove.targetStageId}
          open={stageChangeOpen}
          onOpenChange={(open) => {
            setStageChangeOpen(open);
            if (!open) setPendingMove(null);
          }}
          onSuccess={handleStageChangeSuccess}
        />
      )}
    </div>
  );
}
