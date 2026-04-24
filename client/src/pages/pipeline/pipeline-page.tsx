import { useState, useCallback, useEffect } from "react";
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
import { Plus, Clock, GripVertical, RefreshCw, Zap } from "lucide-react";
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

// Column accent colors by display order index
const COLUMN_ACCENTS = [
  "#CC0000", // brand-red for first column
  "#F97316", // orange
  "#EAB308", // yellow
  "#3B82F6", // blue
  "#8B5CF6", // purple
  "#06B6D4", // cyan
  "#10B981", // green
];

function getAccentColor(index: number): string {
  return COLUMN_ACCENTS[index % COLUMN_ACCENTS.length];
}

// Determine if a deal is "hot" (high priority) based on win probability or other signals
function isHotDeal(deal: Deal): boolean {
  return (deal.winProbability ?? 0) >= 75 || deal.awardedAmount != null;
}

// Inline draggable card — keeps all dnd-kit logic, just new visual style
function PipelineCard({
  deal,
  isDragging,
  isCloseOut,
  isInProduction,
}: {
  deal: Deal;
  isDragging?: boolean;
  isCloseOut?: boolean;
  isInProduction?: boolean;
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
  const hot = isHotDeal(deal);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative bg-white border border-gray-100 shadow-sm hover:shadow-md transition-all cursor-pointer
        border-l-2 ${hot ? "border-l-brand-red" : "border-l-gray-200"}
        ${isDragging ? "shadow-xl opacity-60 rotate-1" : ""}
        ${isCloseOut ? "opacity-70 grayscale-[0.5]" : ""}
      `}
      onClick={() => navigate(`/deals/${deal.id}`)}
    >
      {/* Drag handle — visible on hover */}
      <button
        {...attributes}
        {...listeners}
        className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <div className="p-3 pl-5">
        {/* Top row: deal number pill + value */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="text-[10px] font-mono bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-sm tracking-wide">
            {deal.dealNumber}
          </span>
          <span className="text-lg font-black text-gray-900 tabular-nums">
            {formatCurrencyCompact(value)}
          </span>
        </div>

        {/* Deal name */}
        <p className="text-sm font-bold text-gray-800 truncate leading-tight mb-2">
          {deal.name}
        </p>

        {/* Days in stage */}
        <div className="flex items-center gap-1 text-[11px] text-gray-400">
          <Clock className="h-3 w-3" />
          <span>{days}d in stage</span>
          {deal.propertyCity && (
            <span className="ml-1 truncate text-gray-400">· {deal.propertyCity}</span>
          )}
        </div>

        {/* Progress bar for In Production stage */}
        {isInProduction && deal.winProbability != null && (
          <div className="mt-2">
            <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-red rounded-full"
                style={{ width: `${deal.winProbability}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 mt-0.5 block">{deal.winProbability}% complete</span>
          </div>
        )}
      </div>
    </div>
  );
}

function DroppableColumn({
  column,
  index,
  showDd,
  activeDealId,
  onOpenStage,
}: {
  column: PipelineColumn;
  index: number;
  showDd: boolean;
  activeDealId: string | null;
  onOpenStage: (stageId: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: column.stage.id });
  const accent = getAccentColor(index);

  const slug = column.stage.slug;
  const isCloseOut = false;
  const isInProduction =
    slug === "sent_to_production" ||
    slug === "service_sent_to_production";
  const isFirstColumn = index === 0;

  return (
    <div
      ref={setNodeRef}
      className={`flex-shrink-0 w-80 flex flex-col transition-colors ${
        isOver ? "ring-2 ring-offset-1" : ""
      }`}
      style={isOver ? { "--tw-ring-color": accent } as React.CSSProperties : undefined}
    >
      {/* Column header */}
      <div
        className="bg-gray-50 px-3 pt-3 pb-2 border-b-2"
        style={{ borderBottomColor: accent }}
      >
        <div className="flex items-center justify-between mb-1">
          <button
            type="button"
            className="text-left text-xs font-black uppercase tracking-widest text-gray-500 hover:text-gray-900"
            onClick={() => onOpenStage(column.stage.id)}
          >
            {column.stage.name}
          </button>
          <span
            className="text-xs font-bold px-1.5 py-0.5 rounded-sm text-white"
            style={{ backgroundColor: accent }}
          >
            {column.count}
          </span>
        </div>
        <p className="text-xl font-bold text-gray-900">
          {formatCurrencyCompact(column.totalValue)}
        </p>
      </div>

      {/* Cards list */}
      <div className="flex-1 p-2 space-y-2 overflow-y-auto min-h-0 bg-gray-50/50">
        {column.deals.map((deal) => (
          <PipelineCard
            key={deal.id}
            deal={deal}
            isDragging={activeDealId === deal.id}
            isCloseOut={isCloseOut}
            isInProduction={isInProduction}
          />
        ))}

        {column.deals.length === 0 && (
          <div className="text-center py-8 text-xs text-gray-400 border border-dashed border-gray-200">
            No deals
          </div>
        )}

        {/* Quick lead placeholder on first column */}
        {isFirstColumn && (
          <div className="border border-dashed border-gray-300 p-2 text-center text-xs text-gray-400 hover:border-brand-red hover:text-brand-red transition-colors cursor-pointer">
            + Insert Quick Lead
          </div>
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

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

  // Footer stats computed from pipeline data
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

  const minutesAgo = Math.floor((Date.now() - lastRefreshed.getTime()) / 60000);

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="h-10 w-64 bg-gray-100 animate-pulse rounded" />
        <div className="flex gap-4 overflow-x-auto">
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

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] -m-4 md:-m-6">
      {/* Header */}
      <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b bg-white flex-shrink-0">
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-gray-900">Deal Pipeline</h1>
          <div className="flex items-center gap-4 mt-1.5">
            {/* Live Engine indicator */}
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-red opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-red" />
              </span>
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                <Zap className="h-3 w-3 text-brand-red" />
                Live Engine
              </span>
            </div>
            {/* Total managed */}
            <span className="text-sm font-semibold text-gray-600">
              Total Managed:{" "}
              <span className="text-gray-900 font-black">
                {formatCurrencyCompact(totalValue)}
              </span>
            </span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {/* Show DD toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Show DD</span>
            <button
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                if (showDd) next.delete("showDd");
                else next.set("showDd", "1");
                setSearchParams(next);
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                showDd ? "bg-brand-red" : "bg-gray-200"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                  showDd ? "translate-x-4" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* New Deal button */}
          <button
            onClick={() => navigate("/deals/new")}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-brand-red/30 hover:shadow-xl hover:shadow-brand-red/40 transition-all"
            style={{
              background: "linear-gradient(135deg, #CC0000 0%, #990000 100%)",
            }}
          >
            <Plus className="h-4 w-4" />
            New Deal
          </button>
        </div>
      </div>

      {/* Kanban board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden min-h-0">
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-3 p-4 h-full" style={{ minWidth: "max-content" }}>
            {columns.map((column, index) => (
              <DroppableColumn
                key={column.stage.id}
                column={column}
                index={index}
                showDd={showDd}
                activeDealId={activeDeal?.id ?? null}
                onOpenStage={(stageId) => navigate(`/deals/stages/${stageId}`)}
              />
            ))}
          </div>

          <DragOverlay>
            {activeDeal && (
              <PipelineCard deal={activeDeal} isDragging />
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Summary footer */}
      <div className="flex-shrink-0 bg-white border-t px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Active Leads</p>
            <p className="text-2xl font-black text-gray-900">{totalDeals}</p>
          </div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Avg. Velocity</p>
            <p className="text-2xl font-black text-gray-900">{avgVelocity}<span className="text-sm font-semibold text-gray-400 ml-1">days</span></p>
          </div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Success Rate</p>
            <p className="text-2xl font-black text-gray-900">
              {successRate != null ? `${successRate}%` : "--"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <RefreshCw className="h-3 w-3" />
          <span>
            Data refreshed {minutesAgo === 0 ? "just now" : `${minutesAgo}m ago`}
          </span>
        </div>
      </div>

      {/* Stage Change Dialog (from drag-and-drop) */}
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
