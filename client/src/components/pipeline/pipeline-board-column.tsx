import { useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { formatCurrencyCompact } from "@/lib/deal-utils";
import { cn } from "@/lib/utils";
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
  const { isOver, setNodeRef } = useDroppable({
    id: column.stage.id,
    data: {
      stageId: column.stage.id,
      stageSlug: column.stage.slug,
    },
  });
  const accent = resolveStageAccent(column.stage, entity);
  const primaryMetric =
    entity === "deal" ? formatBoardCompactCurrency(column.totalValue ?? 0) : `${column.count} active`;

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex w-[19.5rem] shrink-0 flex-col overflow-hidden rounded-[1.5rem] bg-[#f7f8fb] shadow-[0_1px_0_rgba(15,23,42,0.04)] ring-1 ring-slate-200/90",
        isOver ? "ring-2 ring-offset-2 ring-offset-[#eef2f6]" : ""
      )}
      style={isOver ? { boxShadow: `0 0 0 2px ${accent} inset` } : undefined}
    >
      <div className="h-1 w-full" style={{ backgroundColor: accent }} />
      <div className="space-y-3 px-4 pb-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <Button
            variant="ghost"
            className="h-auto justify-start px-0 py-0 text-left text-[0.76rem] font-black tracking-[0.22em] text-slate-500 uppercase hover:bg-transparent"
            onClick={() => onOpenStage(column.stage.id)}
          >
            {column.stage.name}
          </Button>
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white shadow-sm"
            style={{ backgroundColor: accent }}
          >
            {column.count}
          </span>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[2rem] leading-none font-black tracking-tight text-slate-950">{primaryMetric}</p>
            <p className="mt-1 text-[11px] font-medium tracking-[0.16em] text-slate-400 uppercase">
              {entity === "deal" ? "stage total" : "active leads"}
            </p>
          </div>
        </div>
        {column.count > column.cards.length ? (
          <button
            type="button"
            className="text-left text-[11px] font-bold tracking-[0.16em] text-slate-500 uppercase transition-colors hover:text-slate-900"
            onClick={() => onOpenStage(column.stage.id)}
          >
            View all {column.count}
          </button>
        ) : null}
      </div>
      <div className="flex min-h-[12rem] flex-1 flex-col gap-2.5 bg-white/45 px-3 pb-3 pt-1">
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
          <div className="rounded-[1.2rem] border border-dashed border-slate-300 bg-white/70 px-3 py-8 text-center text-xs font-medium text-slate-500">
            No records in this stage
          </div>
        )}
      </div>
    </section>
  );
}

function resolveStageAccent(stage: PipelineBoardStage, entity: "lead" | "deal") {
  if (stage.color) return stage.color;

  const dealPalette = ["#d92d20", "#f97316", "#eab308", "#3b82f6", "#7c3aed", "#0f766e"];
  const leadPalette = ["#e11d48", "#f97316", "#f59e0b", "#14b8a6", "#3b82f6", "#6366f1"];
  const palette = entity === "deal" ? dealPalette : leadPalette;
  const index = Math.max(0, (stage.displayOrder ?? 1) - 1) % palette.length;
  return palette[index];
}

function formatBoardCompactCurrency(value: number) {
  return formatCurrencyCompact(value).replace(".0", "");
}
