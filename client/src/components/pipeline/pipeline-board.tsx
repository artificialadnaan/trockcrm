import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { PipelineBoardColumn, type PipelineBoardColumnData } from "./pipeline-board-column";
import { PipelineRecordCard } from "./pipeline-record-card";
import { cn } from "@/lib/utils";

export interface PipelineBoardProps {
  entity: "lead" | "deal";
  columns: PipelineBoardColumnData[];
  loading: boolean;
  onOpenStage: (stageId: string) => void;
  onOpenRecord: (recordId: string) => void;
  onMove?: (input: { activeId: string; targetStageId: string; targetStageSlug: string }) => void;
}

export function PipelineBoard({
  entity,
  columns,
  loading,
  onOpenStage,
  onOpenRecord,
  onMove,
}: PipelineBoardProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const activeRecord =
    columns.flatMap((column) => column.cards).find((record) => record.id === activeRecordId) ?? null;

  if (loading) {
    return (
      <div className="overflow-hidden rounded-[2rem] border border-slate-200 bg-[#eef2f6] shadow-sm">
        <div className="border-b border-slate-200/80 px-6 py-4">
          <div className="h-3 w-32 rounded-full bg-slate-200" />
        </div>
        <div className="px-6 py-12 text-sm font-medium text-slate-500">Loading board...</div>
      </div>
    );
  }

  const handleDragStart = (event: DragStartEvent) => {
    const record = event.active.data.current?.record as { id: string } | undefined;
    setActiveRecordId(record?.id ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveRecordId(null);
    if (!onMove || !event.over) return;

    const record = event.active.data.current?.record as { id: string } | undefined;
    const targetColumn = columns.find((column) => column.stage.id === event.over?.id);
    if (!record || !targetColumn) return;

    onMove({
      activeId: record.id,
      targetStageId: targetColumn.stage.id,
      targetStageSlug: targetColumn.stage.slug,
    });
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="overflow-x-auto rounded-[2rem] border border-slate-200/80 bg-[#eef2f6] px-4 py-5 shadow-sm">
        <div
          className={cn(
            "flex min-w-max gap-4 pb-2",
            columns.length <= 4 ? "justify-between" : ""
          )}
        >
        {columns.map((column) => (
          <PipelineBoardColumn
            key={column.stage.id}
            entity={entity}
            column={column}
            onOpenStage={onOpenStage}
            onOpenRecord={onOpenRecord}
            activeRecordId={activeRecordId}
          />
        ))}
        </div>
      </div>
      <DragOverlay>
        {activeRecord ? <PipelineRecordCard entity={entity} record={activeRecord} isDragging /> : null}
      </DragOverlay>
    </DndContext>
  );
}
