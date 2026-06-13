import { useState, useCallback, useEffect, useRef, useLayoutEffect } from "react";
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
import { GripVertical } from "lucide-react";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { TerminalDateFilterControl } from "@/components/pipeline/terminal-date-filter-control";
import { DealsListSection } from "@/components/deals/deals-list-section";
import { KanbanScrollColumn } from "@/components/deals/kanban-scroll-column";
import { KanbanDealCard, getDealDisplayNumber } from "@/components/deals/kanban-deal-card";
import { PipelineStageSummary } from "@/components/deals/pipeline-stage-summary";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrencyCompact, daysInStage } from "@/lib/deal-utils";
import {
  buildDealStageWorkspacePath,
  buildPipelineRequestPath,
  getActivePipelineColumns,
  getTerminalDateFilterLabel,
  getTerminalStageOutcome,
  isTerminalOutcomeSlug,
  readTerminalDateFiltersFromSearchParams,
  setTerminalDateFilterSearchParams,
  writeTerminalDateFilter,
  type TerminalDateFilter,
  type TerminalOutcome,
} from "@/lib/pipeline-terminal-filters";
import type { Deal } from "@/hooks/use-deals";
import { containNonDealsScope, type PipelineScope } from "@/lib/pipeline-scope";
import { resolvePreferredScope, writeStoredScopePreference } from "@/lib/scope-preferences";
import { derivePipelineBoardView } from "./pipeline-board-view";
import { useSalesReps } from "@/hooks/use-sales-reps";
import { useRegions, useProjectTypes } from "@/hooks/use-pipeline-config";
import {
  DEAL_LIST_SORT_OPTIONS,
  getBoardVisibleStageScope,
  isBoardVisibleStage,
} from "@/components/deals/deals-filterbar-adapter";
import type { FilterDimension } from "@/components/filters/filter-bar";

// Slice 7 proving ground: the deals list under the kanban gets the richest shared FilterBar set.
// (Stalled is enabled now that ENABLE_STAGE_ENTRY_DATE_FILTER is on; the bar shows it while
// stageEntryDateEnabled is true. Scope is inherited from the page's scope toggle, not duplicated.)
const DEAL_LIST_FILTERBAR_DIMENSIONS: FilterDimension[] = [
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

// Re-exports kept for test compatibility (pipeline-page.test.ts imports these
// helpers; they live in the shared deals-list-section module now).
export { getDealDisplayNumber };
export {
  MAX_EXPORT_PAGES,
  buildDealListParams,
  buildStageNameById,
  fetchAllFilteredDeals,
  getPipelineListIsActiveFilter,
  getPipelineListQueryState,
  getVisibleTerminalStageIds,
} from "@/components/deals/deals-list-section";

// Team scope is parked (PR #512) and not configured anywhere, so it is not offered here
// -- only Mine | All (mirrors the director dashboard). The shared PipelineScope union still
// includes "team" for URL coercion (see PipelinePage); do not change it.
const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
] as const satisfies readonly ScopeToggleOption<PipelineScope>[];

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
  count: number;
  totalValue?: number;
}

interface PendingPipelineMove {
  deal: Deal;
  targetStageId: string;
}

export function summarizeTerminalStageCounts(terminalStages: TerminalStageInfo[]) {
  const won = terminalStages
    .filter((ts) => getTerminalStageOutcome(ts.stage.slug) === "won")
    .reduce((sum, ts) => sum + ts.count, 0);
  const lost = terminalStages
    .filter((ts) => getTerminalStageOutcome(ts.stage.slug) === "lost")
    .reduce((sum, ts) => sum + ts.count, 0);

  return { won, lost };
}

export function summarizeActivePipelineColumns(columns: PipelineColumn[]) {
  const activeColumns = getActivePipelineColumns(columns);
  const totalDeals = activeColumns.reduce((sum, col) => sum + col.count, 0);
  const totalValue = activeColumns.reduce((sum, col) => sum + col.totalValue, 0);
  const allDeals = activeColumns.flatMap((col) => col.deals);
  const velocityDeals = allDeals.filter(
    (deal) => !deal.bidBoardStageSlug || getTerminalStageOutcome(deal.bidBoardStageSlug) === null
  );
  const averageVelocity =
    velocityDeals.length === 0
      ? 0
      : Math.round(velocityDeals.reduce((sum, deal) => sum + daysInStage(deal.stageEnteredAt), 0) / velocityDeals.length);

  return {
    totalDeals,
    totalValue,
    averageVelocity,
  };
}

export function resolvePipelinePageMove(
  columns: PipelineColumn[],
  deal: Deal,
  targetStageId: string
): PendingPipelineMove | null {
  if (deal.stageId === targetStageId) return null;

  const targetColumn = columns.find((column) => column.stage.id === targetStageId);
  if (!targetColumn || targetColumn.stage.isActivePipeline === false) return null;

  return { deal, targetStageId };
}

// Open a stage column's drill-down at the SAME scope + terminal window the board is showing. The bug was
// that the pipeline navigated with ONLY the terminal date filters, so the drill-down dropped the active
// scope and defaulted to mine. Forward scope + the terminal filters so the drill-down matches the column
// the user clicked. Deliberately NOT forwarding the URL's bare assignedRepId: the pipeline BOARD is fetched
// all-rep (buildPipelineRequestPath takes only showDd/terminalDateFilters/scope — no rep), so the column
// counts/values the user clicked are all-rep. The rep lives only on the under-kanban LIST's FilterBar;
// forwarding it would open a rep-scoped drill-down that no longer matches the all-rep card (Codex P2).
export function buildPipelineStageNavigationPath(
  stageId: string,
  stageSlug: string,
  scope: PipelineScope,
  terminalDateFilters: Record<TerminalOutcome, TerminalDateFilter>
) {
  return buildDealStageWorkspacePath({
    stageId,
    stageSlug,
    scope,
    filters: terminalDateFilters,
  });
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
  stageSlug,
  isDragging,
}: {
  deal: Deal;
  stageSlug?: string;
  isDragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: deal.id,
    data: { deal },
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 50 }
    : undefined;

  return (
    <KanbanDealCard
      deal={deal}
      stageSlug={stageSlug}
      isDragging={isDragging}
      containerRef={setNodeRef}
      containerStyle={style}
      dragHandle={
        <button
          {...attributes}
          {...listeners}
          className="absolute left-1 top-1/2 z-10 -translate-y-1/2 cursor-grab text-gray-300 opacity-0 transition-opacity hover:text-gray-500 active:cursor-grabbing group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
          aria-label="Drag deal"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      }
    />
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
  const isInactiveDealStage = column.stage.isActivePipeline === false;
  const { isOver, setNodeRef } = useDroppable({
    id: column.stage.id,
    disabled: isInactiveDealStage,
  });
  const terminalOutcome = isTerminalOutcomeSlug(column.stage.slug) ? column.stage.slug : null;
  const terminalLabel = terminalFilter ? getTerminalDateFilterLabel(terminalFilter) : null;

  const header = (
    <>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="truncate text-left text-xs font-medium uppercase tracking-wide text-gray-500 hover:text-gray-900"
          onClick={() => onOpenStage(column.stage.id)}
        >
          {column.stage.name}
          {terminalLabel ? <span className="ml-1 text-gray-400">· {terminalLabel}</span> : null}
        </button>
        <span className="rounded-sm bg-gray-200/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-gray-600">
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
      <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900">
        {formatCurrencyCompact(column.totalValue)}
      </p>
    </>
  );

  return (
    <KanbanScrollColumn
      ref={setNodeRef}
      header={header}
      className={isOver ? "ring-2 ring-brand-red/40 ring-offset-1" : undefined}
      childCount={column.deals.length}
    >
      {column.deals.map((deal) => (
        <PipelineCard key={deal.id} deal={deal} stageSlug={column.stage.slug} isDragging={activeDealId === deal.id} />
      ))}

      {column.deals.length === 0 && (
        <div className="border border-dashed border-gray-200 py-8 text-center text-xs text-gray-400">
          No deals
        </div>
      )}
    </KanbanScrollColumn>
  );
}

export function PipelinePage() {
  const { user, loading: authLoading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedScope = resolvePreferredScope({
    requestedScope: searchParams.get("scope"),
    userId: user?.id,
    fallback: "mine",
  });
  // /pipeline offers Mine|All only; coerce the parked "team" and the deals-dashboard-only "watched"
  // (carried via the shared scope preference) to "mine". (A Watched pill here is a deferred v1 expansion.)
  const scope = containNonDealsScope(requestedScope);
  const updateScope = (nextScope: PipelineScope) => {
    writeStoredScopePreference(user?.id, nextScope);
    const next = new URLSearchParams(searchParams);
    next.set("scope", nextScope);
    // Changing scope changes the list's result set, so drop the FilterBar list page — otherwise a
    // user on ?page=4 stays on page 4 for the new scope and sees an empty/misleading list (the
    // legacy setPage(1) effect no longer drives the URL-backed page in FilterBar mode). Codex r2.
    next.delete("page");
    setSearchParams(next);
  };

  if (authLoading || !user) {
    return <div className="space-y-4 p-6 text-sm font-semibold text-gray-500">Loading pipeline...</div>;
  }

  const navigate = useNavigate();
  const [columns, setColumns] = useState<PipelineColumn[]>([]);
  const [terminalStages, setTerminalStages] = useState<TerminalStageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // No-blank: track whether we have a SUCCESSFULLY-loaded board and the request identity
  // (scope + Show-DD) it was loaded for (columns is seeded to [], so it cannot itself
  // signal "loaded"). Keep the current board visible with an "Updating..." hint on a
  // SAME-IDENTITY refetch (Won/Lost date-filter); show the skeleton on first load, after a
  // failed load, AND on a scope or Show-DD change -- both change which columns the API
  // returns and the board is interactive, so never leave a stale cross-identity board live.
  const hasLoadedRef = useRef(false);
  const loadedScopeRef = useRef<PipelineScope | null>(null);
  const loadedShowDdRef = useRef<boolean | null>(null);
  // Monotonic request token: a scope/Show-DD/date change can leave an earlier request in
  // flight, and responses may arrive out of order. Only the latest request may mutate the
  // board + loaded identity; a superseded (stale) completion is ignored, so it can never set
  // loadedShowDd/loadedScope back to a value that no longer matches the live selection (which
  // would strand the page on a skeleton with no fetch in flight).
  const requestIdRef = useRef(0);
  // Derive Show-DD straight from the URL (like `scope` above), NOT a local state synced by a
  // passive effect. Otherwise, on the render right after setSearchParams (switch click, browser
  // back/forward, any navigation) searchParams is already new while a synced state would still
  // hold the old value -- so loadedShowDd === showDd would look current and the stale board
  // would paint for one frame before the effect caught up.
  const showDd = searchParams.get("showDd") === "1";
  // See derivePipelineBoardView: the skeleton is keyed on the request identity (NOT on
  // `loading`) so the pre-loading render right after a scope/Show-DD change shows the skeleton
  // instead of flashing the stale previous-identity board for one frame.
  const { showSkeleton, isRefreshing } = derivePipelineBoardView({
    hasLoaded: hasLoadedRef.current,
    loadedScope: loadedScopeRef.current,
    loadedShowDd: loadedShowDdRef.current,
    scope,
    showDd,
    loading,
    error,
  });
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<PendingPipelineMove | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [now, setNow] = useState<Date>(new Date());
  // Option sources for the shared FilterBar on the deals list below the board (Slice 7).
  const { salesReps } = useSalesReps();
  const { regions } = useRegions();
  const { projectTypes } = useProjectTypes();
  const [terminalDateFilters, setTerminalDateFilters] = useState<Record<TerminalOutcome, TerminalDateFilter>>(() =>
    readTerminalDateFiltersFromSearchParams(searchParams)
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const mainScrollRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const innerWidthSpacerRef = useRef<HTMLDivElement>(null);
  const isSyncingScrollRef = useRef(false);

  const fetchPipeline = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isStale = () => requestIdRef.current !== requestId;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{
        pipelineColumns: PipelineColumn[];
        terminalStages: TerminalStageInfo[];
      }>(buildPipelineRequestPath(showDd, terminalDateFilters, scope));
      if (isStale()) return; // a newer request superseded this one -> drop its result
      setColumns(data.pipelineColumns);
      setTerminalStages(data.terminalStages ?? []);
      setLastRefreshed(new Date());
      hasLoadedRef.current = true;
      loadedScopeRef.current = scope; // the scope these columns were fetched for
      loadedShowDdRef.current = showDd; // ...and the Show-DD state (affects the column set)
    } catch (err) {
      if (isStale()) return; // a newer request is in flight -> let it own the outcome
      console.error("Failed to load pipeline:", err);
      setError("Failed to load pipeline data. Please try again.");
    } finally {
      // Only the latest request clears loading; a stale completion must not flip the page out
      // of the in-flight state the current request is still in.
      if (!isStale()) setLoading(false);
    }
  }, [scope, showDd, terminalDateFilters]);

  const updateTerminalDateFilter = useCallback((outcome: TerminalOutcome, filter: TerminalDateFilter) => {
    writeTerminalDateFilter(outcome, filter);
    setTerminalDateFilters((current) => ({ ...current, [outcome]: filter }));
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      setTerminalDateFilterSearchParams(next, outcome, filter);
      return next;
    });
  }, [setSearchParams]);

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  useEffect(() => {
    // showDd is derived from searchParams directly (above); only the terminal date filters need
    // syncing back into state on a browser back/forward. Keep the SAME object reference when the
    // terminal-date params are unchanged so that list-only FilterBar params (search, stage, status,
    // …) sharing this URL do not churn this state and needlessly refetch the kanban board
    // (fetchPipeline depends on terminalDateFilters).
    const next = readTerminalDateFiltersFromSearchParams(searchParams);
    setTerminalDateFilters((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next
    );
  }, [searchParams]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

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
    const pendingMove = resolvePipelinePageMove(columns, deal, over.id as string);
    if (!pendingMove) return;

    setPendingMove(pendingMove);
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

  // The under-kanban list mirrors the board it sits under (Slice 7 design sign-off): its default stage
  // scope IS the board's visible columns (Show-DD-filtered), and the visible terminal columns flow
  // through as inactive stages so the list shows active + terminal deals like the board. isTerminalOutcomeSlug
  // classifies the Won/Lost columns; isBoardVisibleStage is the single Show-DD predicate (also drives the
  // stage options below) so the list and the board can never disagree about which stages are on the page.
  const boardStageScope = getBoardVisibleStageScope(
    columns.map((column) => ({ id: column.stage.id, slug: column.stage.slug })),
    showDd,
    isTerminalOutcomeSlug
  );

  if (showSkeleton) {
    return (
      <div className="space-y-4 p-6">
        <div className="h-8 w-48 animate-pulse rounded bg-gray-100" />
        <div className="flex gap-3 overflow-x-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-[500px] w-80 flex-shrink-0 animate-pulse bg-gray-100" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="border border-red-200 bg-red-50 p-6 text-center text-sm text-red-600">
          {error}
          <button
            onClick={fetchPipeline}
            className="ml-3 font-medium underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const refreshedLabel = formatRefreshedLabel(lastRefreshed, now);

  // Mobile board summary (md:hidden): which stage, if any, is the SOLE active list filter — so its
  // chip can highlight. A multi-stage `stageIds` (set from the FilterBar's stage multi-select) maps
  // to no single highlighted chip, which is correct.
  const activeSummaryStageId = (() => {
    const raw = searchParams.get("stageIds");
    if (!raw) return null;
    const ids = raw.split(",").filter(Boolean);
    return ids.length === 1 ? ids[0] : null;
  })();
  // Tapping a summary chip filters the deals list below to that stage by writing the FilterBar's
  // URL-backed `stageIds` (the bar re-derives from the URL — see use-filter-state); tapping the
  // active chip again clears it back to the board's default stage scope. Drop `page` so the list
  // does not stay on a now-out-of-range page (mirrors updateScope), and `replace` to match the
  // bar's own filter-write history semantics.
  const handleSelectSummaryStage = (stageId: string) => {
    const next = new URLSearchParams(searchParams);
    if (activeSummaryStageId === stageId) {
      next.delete("stageIds");
    } else {
      next.set("stageIds", stageId);
    }
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="-m-4 space-y-5 bg-[#f5f6f8] p-4 md:-m-6 md:p-6">
      {/* On phones the title stacks above the controls and the padding tightens; >=md reverts to the
          original single-row header (md:flex-row/items-center/justify-between/gap-4/px-6/py-5). */}
      <header className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white px-4 py-4 md:flex-row md:items-center md:justify-between md:gap-4 md:px-6 md:py-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-gray-900">Deal Pipeline</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {totalDeals} deals · {formatCurrencyCompact(totalValue)} total
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <ScopeToggle options={SCOPE_OPTIONS} value={scope} onChange={updateScope} ariaLabel="Pipeline scope" size="touch" />
          <span className="hidden text-xs tabular-nums text-gray-500 md:inline">
            {refreshedLabel}{isRefreshing ? " · Updating..." : ""}
          </span>

          <div className="flex items-center gap-2 rounded-sm border border-gray-200 px-3 py-1.5">
            <label htmlFor="show-dd-toggle" className="select-none text-xs text-gray-600">
              Show DD stages
            </label>
            <button
              id="show-dd-toggle"
              role="switch"
              aria-checked={showDd}
              aria-label="Show due diligence stages in the pipeline"
              title="Includes due diligence stages in the pipeline view"
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
        </div>
      </header>

      {/* The full drag-and-drop board is desktop-only. On phones it is replaced by the compact
          PipelineStageSummary below (drag-across-stages is unusable on a phone; the board's value
          there is the at-a-glance breakdown). `hidden ... md:flex` keeps >=md byte-identical. */}
      <section className="relative hidden h-[min(72vh,56rem)] min-h-[42rem] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white md:flex">
        <div
          ref={topScrollRef}
          onScroll={handleTopScroll}
          className="flex-shrink-0 overflow-x-auto overflow-y-hidden border-b border-gray-100"
          aria-hidden="true"
        >
          <div ref={innerWidthSpacerRef} style={{ height: 1 }} />
        </div>

        <div
          ref={mainScrollRef}
          onScroll={handleMainScroll}
          className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex h-full gap-3 p-4" style={{ minWidth: "max-content" }}>
              {columns.map((column) => (
                <DroppableColumn
                  key={column.stage.id}
                  column={column}
                  activeDealId={activeDeal?.id ?? null}
                  onOpenStage={(stageId) =>
                    navigate(
                      buildPipelineStageNavigationPath(
                        stageId,
                        column.stage.slug,
                        scope,
                        terminalDateFilters
                      )
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

      <PipelineStageSummary
        columns={columns}
        activeStageId={activeSummaryStageId}
        onSelectStage={handleSelectSummaryStage}
      />

      <footer className="rounded-lg border border-gray-200 bg-white px-4 py-3 md:px-6">
        <dl className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <div className="flex items-baseline gap-2">
            <dt className="text-xs uppercase tracking-wide text-gray-500">Active</dt>
            <dd className="text-base font-semibold tabular-nums text-gray-900">{totalDeals}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-xs uppercase tracking-wide text-gray-500">Avg velocity</dt>
            <dd className="text-base font-semibold tabular-nums text-gray-900">
              {avgVelocity}
              <span className="ml-1 text-xs font-normal text-gray-500">days</span>
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-xs uppercase tracking-wide text-gray-500">Success</dt>
            <dd className="text-base font-semibold tabular-nums text-gray-900">
              {successRate != null ? `${successRate}%` : "—"}
            </dd>
          </div>
        </dl>
      </footer>

      {/* Slice 7 proving ground: the deals list under the kanban, driven by the shared URL-backed
          FilterBar. CSV export is FilterBar-aware (fast-follow): in filterBar mode it exports the same
          #546 filters the list shows + the canonical displayDate axis (see DealsListSection.exportCsv /
          fetchAllDealsForFilters), not the legacy created/updated export axis. */}
      <DealsListSection
        scope={scope}
        enableExport
        filterBar={{
          dimensions: DEAL_LIST_FILTERBAR_DIMENSIONS,
          options: {
            reps: salesReps.map((rep) => ({ value: rep.id, label: rep.displayName })),
            regions: regions.map((region) => ({ value: region.id, label: region.name })),
            projectTypes: projectTypes.map((type) => ({ value: type.id, label: type.name })),
            stages: columns
              .filter((column) => isBoardVisibleStage(column.stage.slug, showDd))
              .map((column) => ({ value: column.stage.id, label: column.stage.name })),
            sortOptions: DEAL_LIST_SORT_OPTIONS,
          },
          // ENABLE_STAGE_ENTRY_DATE_FILTER is on in prod: open rows are date-windowed, so the bar
          // exposes the Stalled (days-in-stage) control and labels the date axis as outcome-aware.
          stageEntryDateEnabled: true,
          // Mirror the board: default to its visible columns (Q2 Show-DD) + let terminal deals through
          // (Q1 active+terminal) unless the user picks an explicit Status.
          defaultStageIds: boardStageScope.defaultStageIds,
          terminalStageIds: boardStageScope.terminalStageIds,
        }}
      />

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
