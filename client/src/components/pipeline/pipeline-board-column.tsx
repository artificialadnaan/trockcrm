import { useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { PipelineRecordCard, type PipelineRecordCardData } from "./pipeline-record-card";

export interface PipelineBoardStage {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  displayOrder?: number;
  isActivePipeline?: boolean;
  isTerminal?: boolean;
}

export interface PipelineBoardColumnData {
  stage: PipelineBoardStage;
  count: number;
  totalValue?: number;
  cards: PipelineRecordCardData[];
}

interface PipelineBoardColumnProps {
  entity: "lead" | "deal";
  column: PipelineBoardColumnData;
  onOpenStage: (stageId: string) => void;
  onOpenRecord: (recordId: string) => void;
  activeRecordId?: string | null;
}

export function PipelineBoardColumn({
  entity,
  column,
  onOpenStage,
  onOpenRecord,
  activeRecordId = null,
}: PipelineBoardColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: column.stage.id });

  return (
    <section
      ref={setNodeRef}
      className={`flex w-80 shrink-0 flex-col rounded-2xl border border-slate-200 bg-slate-50 ${
        isOver ? "ring-2 ring-red-300 ring-offset-2" : ""
      }`}
    >
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <Button
            variant="ghost"
            className="h-auto justify-start px-0 py-0 text-left text-sm font-semibold text-slate-900 hover:bg-transparent"
            onClick={() => onOpenStage(column.stage.id)}
          >
            {column.stage.name}
          </Button>
          <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white">
            {column.count}
          </span>
        </div>
        {column.count > column.cards.length ? (
          <button
            type="button"
            className="mt-2 text-xs font-medium text-slate-500 transition-colors hover:text-slate-900"
            onClick={() => onOpenStage(column.stage.id)}
          >
            View all {column.count}
          </button>
        ) : null}
      </div>
      <div className="flex min-h-[12rem] flex-1 flex-col gap-2 p-3">
        {column.cards.length > 0 ? (
          column.cards.map((record) => (
            <PipelineRecordCard
              key={record.id}
              entity={entity}
              record={record}
              onOpenRecord={onOpenRecord}
              isDragging={activeRecordId === record.id}
            />
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 px-3 py-8 text-center text-xs text-slate-500">
            No records in this stage
          </div>
        )}
      </div>
    </section>
  );
}
