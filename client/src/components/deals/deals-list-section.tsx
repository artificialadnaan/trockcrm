import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Download, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
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
import { useDeals, type Deal } from "@/hooks/use-deals";
import { usePipelineStages, type PipelineStage } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { bestEstimate, daysInStage, formatCurrencyCompact } from "@/lib/deal-utils";
import {
  daysAgo,
  type TerminalDateFilter,
} from "@/lib/pipeline-terminal-filters";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { getDealDisplayNumber } from "@/components/deals/kanban-deal-card";

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

type SortKey = "name" | "stage_entered_at" | "awarded_amount" | "updated_at";
type SortState = { key: SortKey; dir: "asc" | "desc" };
type DealListActiveFilter = boolean | "all" | "pipeline";

interface DealsListSectionProps {
  scope?: "mine" | "team" | "all";
  enableDateFilter?: boolean;
  enableExport?: boolean;
  visibleStages?: Array<Pick<PipelineStage, "id" | "slug" | "name">>;
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  pageSize?: number;
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
}) {
  if (input.stagesLoading || input.stagesError) {
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

export function buildDealListParams(input: {
  search: string;
  stageIds: string[];
  inactiveStageIds?: string[];
  assignedRepId?: string;
  dateRange: { from?: string; to?: string };
  isActive: DealListActiveFilter;
  sort: SortState;
  page: number;
  limit: number;
  scope?: "mine" | "team" | "all";
}) {
  const params = new URLSearchParams();
  if (input.search) params.set("search", input.search);
  if (input.stageIds.length) params.set("stageIds", input.stageIds.join(","));
  if (input.inactiveStageIds?.length) params.set("inactiveStageIds", input.inactiveStageIds.join(","));
  if (input.assignedRepId) params.set("assignedRepId", input.assignedRepId);
  if (input.dateRange.from) params.set("updatedFrom", input.dateRange.from);
  if (input.dateRange.to) params.set("updatedTo", input.dateRange.to);
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
  isActive: DealListActiveFilter;
  sort: SortState;
  scope?: "mine" | "team" | "all";
  apiClient?: typeof api;
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

export function DealsListSection({
  scope,
  enableDateFilter = false,
  enableExport = false,
  visibleStages,
  eyebrow = "Deal list",
  title = "Pipeline records",
  subtitle = "Filter and scan deals without changing the kanban above.",
  pageSize = DEFAULT_PAGE_SIZE,
}: DealsListSectionProps) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [stageSlugs, setStageSlugs] = useState<string[]>([]);
  const [ownerId, setOwnerId] = useState("__all__");
  const [dateFilter, setDateFilter] = useState<TerminalDateFilter>({ preset: "all" });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "updated_at", dir: "desc" });

  const { stages, loading: stagesLoading, error: stagesError } = usePipelineStages();
  const { assignees } = useTaskAssignees();

  const stageFilterOptions = useMemo(() => {
    const sourceStages = visibleStages ?? stages.filter((stage) => stage.isActivePipeline !== false);
    const sortedStages = [...sourceStages].sort((left, right) => {
      const leftIndex = DEAL_STAGE_ORDER.indexOf(left.slug);
      const rightIndex = DEAL_STAGE_ORDER.indexOf(right.slug);
      const leftRank = leftIndex === -1 ? 999 : leftIndex;
      const rightRank = rightIndex === -1 ? 999 : rightIndex;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftDisplayOrder =
        "displayOrder" in left && typeof left.displayOrder === "number" ? left.displayOrder : 0;
      const rightDisplayOrder =
        "displayOrder" in right && typeof right.displayOrder === "number" ? right.displayOrder : 0;
      return leftDisplayOrder - rightDisplayOrder;
    });
    const seen = new Set<string>();
    return sortedStages
      .filter((stage) => {
        if (seen.has(stage.slug)) return false;
        seen.add(stage.slug);
        return true;
      })
      .map((stage) => ({ id: stage.id, slug: stage.slug, name: stage.name }));
  }, [stages, visibleStages]);

  const selectedStageIds = useMemo(
    () =>
      stageFilterOptions
        .filter((stage) => stageSlugs.includes(stage.slug))
        .map((stage) => stage.id),
    [stageSlugs, stageFilterOptions]
  );
  const dateRange = useMemo(
    () => (enableDateFilter ? dateRangeFromTerminalFilter(dateFilter) : {}),
    [enableDateFilter, dateFilter]
  );

  const terminalStageIds = useMemo(
    () => getVisibleTerminalStageIds(stages, stageFilterOptions),
    [stages, stageFilterOptions]
  );
  const listQueryState = useMemo(
    () =>
      getPipelineListQueryState({
        selectedStageIds,
        terminalStageIds,
        stagesLoading,
        stagesError,
      }),
    [selectedStageIds, stagesError, stagesLoading, terminalStageIds]
  );
  const isActiveFilter = listQueryState.isActive;
  const inactiveStageIds = listQueryState.inactiveStageIds;

  const {
    deals,
    pagination,
    loading,
    error,
  } = useDeals({
    search,
    stageIds: selectedStageIds,
    inactiveStageIds,
    assignedRepId: ownerId === "__all__" ? undefined : ownerId,
    updatedFrom: dateRange.from,
    updatedTo: dateRange.to,
    isActive: isActiveFilter,
    sortBy: sort.key,
    sortDir: sort.dir,
    page,
    limit: pageSize,
    scope,
  }, { enabled: listQueryState.enabled });

  const stageNameById = useMemo(() => buildStageNameById(stages), [stages]);
  const assigneeNameById = useMemo(
    () => new Map(assignees.map((assignee) => [assignee.id, assignee.displayName])),
    [assignees]
  );

  const toggleStage = (slug: string) => {
    setPage(1);
    setStageSlugs((current) =>
      current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]
    );
  };

  const updateSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      dir: current.key === key && current.dir === "desc" ? "asc" : "desc",
    }));
  };

  const exportCsv = async () => {
    if (!listQueryState.enabled) {
      toast.error(stagesError ? "Pipeline stage metadata failed to load." : "Pipeline stages are still loading.");
      return;
    }
    const exportResult = await fetchAllFilteredDeals({
      search,
      stageIds: selectedStageIds,
      inactiveStageIds,
      assignedRepId: ownerId === "__all__" ? undefined : ownerId,
      dateRange,
      isActive: isActiveFilter,
      sort,
      scope,
    });
    if (exportResult.truncated) {
      toast.info(
        `Exported first ${exportResult.maxRows.toLocaleString()} rows (${exportResult.pagesFetched} pages). Narrow filters for full export.`
      );
    }
    const rows = [
      ["Deal", "Project Number", "Owner", "Stage", "Days", "Value", "Last Touch"],
      ...exportResult.deals.map((deal) => {
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
    anchor.download = "deals-list.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const sortHeader = (key: SortKey, label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-black uppercase tracking-[0.16em] text-slate-500 hover:text-brand-red"
      onClick={() => updateSort(key)}
    >
      {label}
      {sort.key === key ? <span>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
    </button>
  );

  const tableColumns: Array<PipelineStageTableColumn<Deal>> = [
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
              {deal.companyName ||
                [deal.propertyCity, deal.propertyState].filter(Boolean).join(", ") ||
                "Account pending"}
            </p>
          </div>
        );
      },
    },
    {
      key: "owner",
      header: "Owner",
      render: (deal) =>
        deal.assignedRepName ?? assigneeNameById.get(deal.assignedRepId) ?? "Unassigned",
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
        <span className="font-black tabular-nums text-slate-950">
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

      <div className={cn("grid gap-3 border-b border-gray-200 bg-[#f7f8fb] p-4", filterGridClass)}>
        <label className="space-y-2">
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => {
                setPage(1);
                setSearch(event.target.value);
              }}
              placeholder="Deal name, number, company, address"
              className="pl-9"
            />
          </div>
        </label>

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
      </div>

      <div className="p-4">
        {error ? (
          <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
            {error}
          </div>
        ) : stagesError ? (
          <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
            Pipeline stage metadata failed to load.
          </div>
        ) : !listQueryState.enabled || loading ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
            Loading deals...
          </div>
        ) : (
          <PipelineStageTable
            rows={deals}
            columns={tableColumns}
            pagination={{
              page: pagination.page,
              pageSize: pagination.limit,
              total: pagination.total,
              totalPages: pagination.totalPages,
            }}
            onPageChange={setPage}
            onRowClick={(deal) => navigate(`/deals/${deal.id}`)}
            getRowKey={(deal) => deal.id}
          />
        )}
      </div>
    </section>
  );
}
