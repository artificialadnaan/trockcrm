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
import { Plus, GripVertical } from "lucide-react";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { api } from "@/lib/api";
import { formatCurrencyCompact, bestEstimate, daysInStage } from "@/lib/deal-utils";
import type { Deal } from "@/hooks/use-deals";

interface PipelineColumn {
  stage: {
    id: string;
    name: string;
    slug: string;
    color: string | null;
    displayOrder: number;
    isActivePipeline: boolean;
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
  const won = terminalStages
    .filter((ts) => ["sent_to_production", "service_sent_to_production"].includes(ts.stage.slug))
    .reduce((sum, ts) => sum + ts.count, 0);
  const lost = terminalStages
    .filter((ts) => ["production_lost", "service_lost"].includes(ts.stage.slug))
    .reduce((sum, ts) => sum + ts.count, 0);

  return { won, lost };
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

  const metaParts = [`TR-${deal.dealNumber}`];
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
}: {
  column: PipelineColumn;
  activeDealId: string | null;
  onOpenStage: (stageId: string) => void;
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
          </button>
          <span className="text-xs font-medium text-gray-600 bg-gray-200/70 px-1.5 py-0.5 rounded-sm tabular-nums">
            {column.count}
          </span>
        </div>
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
      }>(`/deals/pipeline?includeDd=${showDd}`);
      setColumns(data.pipelineColumns);
      setTerminalStages(data.terminalStages ?? []);
      setLastRefreshed(new Date());
    } catch (err) {
      console.error("Failed to load pipeline:", err);
      setError("Failed to load pipeline data. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [showDd]);

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

  const totalDeals = columns.reduce((sum, col) => sum + col.count, 0);
  const totalValue = columns.reduce((sum, col) => sum + col.totalValue, 0);

  const avgVelocity = (() => {
    const allDeals = columns.flatMap((col) => col.deals);
    if (allDeals.length === 0) return 0;
    const totalDays = allDeals.reduce((sum, d) => sum + daysInStage(d.stageEnteredAt), 0);
    return Math.round(totalDays / allDeals.length);
  })();

  const { won, lost } = summarizeTerminalStageCounts(terminalStages);
  const successRate = (() => {
    const total = won + lost;
    if (total === 0) return null;
    return Math.round((won / total) * 100);
  })();

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
    <div className="flex flex-col h-[calc(100vh-4rem)] -m-4 md:-m-6">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 px-6 pt-5 pb-4 border-b border-gray-200 bg-white flex-shrink-0">
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
      <div className="relative flex-1 flex flex-col min-h-0 bg-white">
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
                  onOpenStage={(stageId) => navigate(`/deals/stages/${stageId}`)}
                />
              ))}
            </div>

            <DragOverlay>
              {activeDeal && <PipelineCard deal={activeDeal} isDragging />}
            </DragOverlay>
          </DndContext>
        </div>
      </div>

      {/* Footer */}
      <footer className="flex-shrink-0 border-t border-gray-200 bg-white px-6 py-3">
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
