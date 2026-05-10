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
import { GripVertical, Plus } from "lucide-react";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { TerminalDateFilterControl } from "@/components/pipeline/terminal-date-filter-control";
import { DealsListSection } from "@/components/deals/deals-list-section";
import { KanbanScrollColumn } from "@/components/deals/kanban-scroll-column";
import { KanbanDealCard, getDealDisplayNumber } from "@/components/deals/kanban-deal-card";
import { api } from "@/lib/api";
import { formatCurrencyCompact, daysInStage } from "@/lib/deal-utils";
import {
  buildDealStageWorkspacePath,
  buildPipelineRequestPath,
  getActivePipelineColumns,
  getTerminalDateFilterLabel,
  isTerminalOutcomeSlug,
  readTerminalDateFilter,
  writeTerminalDateFilter,
  type TerminalDateFilter,
  type TerminalOutcome,
} from "@/lib/pipeline-terminal-filters";
import type { Deal } from "@/hooks/use-deals";

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
  const { isOver, setNodeRef } = useDroppable({ id: column.stage.id });
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
        <PipelineCard key={deal.id} deal={deal} isDragging={activeDealId === deal.id} />
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
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

  if (loading) {
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
          <span className="hidden text-xs tabular-nums text-gray-500 md:inline">
            {refreshedLabel}
          </span>

          <div className="flex items-center gap-2 rounded-sm border border-gray-200 px-3 py-1.5">
            <label htmlFor="show-dd-toggle" className="select-none text-xs text-gray-600">
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
            className="inline-flex items-center gap-1.5 bg-brand-red px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-red/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" />
            New Deal
          </button>
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
        enableDateFilter
        enableExport
        visibleStages={columns.map((column) => ({
          id: column.stage.id,
          slug: column.stage.slug,
          name: column.stage.name,
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
