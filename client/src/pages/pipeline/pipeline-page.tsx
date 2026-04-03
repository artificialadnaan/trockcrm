import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { Plus, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DealCard } from "@/components/deals/deal-card";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { api } from "@/lib/api";
import { formatCurrencyCompact } from "@/lib/deal-utils";
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

function DroppableColumn({ column, children }: { column: PipelineColumn; children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: column.stage.id });

  return (
    <div
      ref={setNodeRef}
      className={`flex-shrink-0 w-72 flex flex-col rounded-lg transition-colors ${
        isOver ? "bg-brand-red/5 ring-2 ring-brand-red/30" : "bg-muted/30"
      }`}
    >
      {/* Column Header */}
      <div className="p-3 border-b">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold">{column.stage.name}</h3>
          <Badge variant="outline" className="text-xs">
            {column.count}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatCurrencyCompact(column.totalValue)}
        </p>
      </div>

      {/* Cards */}
      <div className="flex-1 p-2 space-y-2 overflow-y-auto min-h-[200px] max-h-[calc(100vh-280px)]">
        {children}
      </div>
    </div>
  );
}

export function PipelinePage() {
  const navigate = useNavigate();
  const [columns, setColumns] = useState<PipelineColumn[]>([]);
  const [terminalStages, setTerminalStages] = useState<TerminalStageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDd, setShowDd] = useState(false);
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ deal: Deal; targetStageId: string } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
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

    // Don't process if dropped on the same stage
    if (deal.stageId === targetStageId) return;

    // Open stage change confirmation dialog
    setPendingMove({ deal, targetStageId });
    setStageChangeOpen(true);
  };

  const handleStageChangeSuccess = () => {
    setStageChangeOpen(false);
    setPendingMove(null);
    fetchPipeline(); // Refresh the board
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="flex gap-4 overflow-x-auto">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-72 h-96 bg-muted animate-pulse rounded-lg flex-shrink-0" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6 text-center text-destructive">
            {error}
            <Button onClick={fetchPipeline} className="ml-2" variant="outline" size="sm">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Pipeline</h2>
          <p className="text-sm text-muted-foreground">
            Drag deals between stages to advance them
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDd(!showDd)}
          >
            {showDd ? (
              <>
                <EyeOff className="h-4 w-4 mr-1" />
                Hide DD
              </>
            ) : (
              <>
                <Eye className="h-4 w-4 mr-1" />
                Show DD
              </>
            )}
          </Button>
          <Button onClick={() => navigate("/deals/new")}>
            <Plus className="h-4 w-4 mr-2" />
            New Deal
          </Button>
        </div>
      </div>

      {/* Pipeline Summary */}
      <div className="flex gap-2 text-sm">
        <Badge variant="secondary">
          {columns.reduce((sum, col) => sum + col.count, 0)} deals
        </Badge>
        <Badge variant="secondary">
          {formatCurrencyCompact(
            columns.reduce((sum, col) => sum + col.totalValue, 0)
          )}{" "}
          total pipeline
        </Badge>
      </div>

      {/* Kanban Board */}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((column) => (
            <DroppableColumn key={column.stage.id} column={column}>
              {column.deals.length === 0 ? (
                <div className="text-center py-8 text-xs text-muted-foreground">
                  No deals
                </div>
              ) : (
                column.deals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    isDragging={activeDeal?.id === deal.id}
                  />
                ))
              )}
            </DroppableColumn>
          ))}
        </div>

        {/* Drag Overlay */}
        <DragOverlay>
          {activeDeal && <DealCard deal={activeDeal} isDragging />}
        </DragOverlay>
      </DndContext>

      {/* Terminal Stages Summary (Closed Won / Closed Lost) */}
      {terminalStages.length > 0 && (
        <div className="grid grid-cols-2 gap-4 pt-2 border-t">
          {terminalStages.map((ts) => (
            <Card key={ts.stage.id} className={`p-4 ${
              ts.stage.slug === "closed_won"
                ? "border-green-200 bg-green-50/50"
                : "border-red-200 bg-red-50/50"
            }`}>
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold">{ts.stage.name}</h4>
                  <p className="text-xs text-muted-foreground">
                    {ts.count} deal{ts.count !== 1 ? "s" : ""}
                  </p>
                </div>
                <Badge variant="outline" className={
                  ts.stage.slug === "closed_won"
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }>
                  {ts.count}
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

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
