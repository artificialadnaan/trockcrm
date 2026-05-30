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
import type { PipelineScope } from "@/lib/pipeline-scope";
import { resolvePreferredScope, writeStoredScopePreference } from "@/lib/scope-preferences";
import { derivePipelineBoardView } from "./pipeline-board-view";

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

const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "team", label: "Team" },
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
  const scope = resolvePreferredScope({
    requestedScope: searchParams.get("scope"),
    userId: user?.id,
    fallback: "mine",
  });
  const updateScope = (nextScope: PipelineScope) => {
    writeStoredScopePreference(user?.id, nextScope);
    const next = new URLSearchParams(searchParams);
    next.set("scope", nextScope);
    setSearchParams(next);
  };

  if (authLoading || !user) {
    return <div className="space-y-4 p-6 text-sm font-semibold text-gray-500">Loading pipeline...</div>;
  }

  if (scope === "team") {
    return (
      <div className="-m-4 space-y-5 bg-[#f5f6f8] p-4 md:-m-6 md:p-6">
        <header className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-6 py-5">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-gray-900">Deal Pipeline</h1>
            <p className="mt-0.5 text-xs text-gray-500">Team view is not yet configured.</p>
          </div>
          <ScopeToggle options={SCOPE_OPTIONS} value={scope} onChange={updateScope} ariaLabel="Pipeline scope" />
        </header>
        <section className="rounded-3xl border border-dashed border-slate-300 bg-white px-8 py-14 text-center">
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-slate-500">Team Scope</p>
          <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">Team view is not yet configured.</h2>
          <p className="mt-2 text-sm font-medium text-slate-500">Contact your admin to set up team groupings.</p>
        </section>
      </div>
    );
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
    // syncing back into state on a browser back/forward.
    setTerminalDateFilters(readTerminalDateFiltersFromSearchParams(searchParams));
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

  return (
    <div className="-m-4 space-y-5 bg-[#f5f6f8] p-4 md:-m-6 md:p-6">
      <header className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-6 py-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-gray-900">Deal Pipeline</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {totalDeals} deals · {formatCurrencyCompact(totalValue)} total
          </p>
        </div>

        <div className="flex items-center gap-4">
          <ScopeToggle options={SCOPE_OPTIONS} value={scope} onChange={updateScope} ariaLabel="Pipeline scope" />
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

      <section className="relative flex h-[min(72vh,56rem)] min-h-[42rem] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
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

      <footer className="rounded-lg border border-gray-200 bg-white px-6 py-3">
        <dl className="flex items-center gap-8">
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

      <DealsListSection
        scope={scope}
        enableDateFilter
        enableExport
        excludeStageSlugs={showDd ? [] : ["dd", "due_diligence"]}
        visibleStages={columns.map((column) => ({
          id: column.stage.id,
          slug: column.stage.slug,
          name: column.stage.name,
          isTerminal: column.stage.isTerminal,
        }))}
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
