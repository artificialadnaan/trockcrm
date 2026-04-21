import { useNavigate } from "react-router-dom";
import { useDraggable } from "@dnd-kit/core";
import { GripVertical, Clock, MapPin } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrencyCompact, daysInStage } from "@/lib/deal-utils";

export interface PipelineRecordCardData {
  id: string;
  name: string;
  stageId: string;
  stageEnteredAt: string;
  updatedAt: string;
  propertyCity?: string | null;
  propertyState?: string | null;
  companyName?: string | null;
  source?: string | null;
  dealNumber?: string | null;
  awardedAmount?: string | null;
  bidEstimate?: string | null;
  ddEstimate?: string | null;
  workflowRoute?: string | null;
}

interface PipelineRecordCardProps {
  entity: "lead" | "deal";
  record: PipelineRecordCardData;
  onOpenRecord?: (recordId: string) => void;
  isDragging?: boolean;
}

function formatValue(record: PipelineRecordCardData) {
  const value = Number(record.awardedAmount ?? record.bidEstimate ?? record.ddEstimate ?? 0);
  return value > 0 ? formatCurrencyCompact(value) : null;
}

export function PipelineRecordCard({
  entity,
  record,
  onOpenRecord,
  isDragging = false,
}: PipelineRecordCardProps) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: record.id,
    data: { record },
  });
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 50 }
    : undefined;
  const value = formatValue(record);
  const location = [record.propertyCity, record.propertyState].filter(Boolean).join(", ");
  const secondaryLine = record.companyName ?? location ?? record.source ?? "Unassigned";

  const openRecord = () => {
    if (onOpenRecord) {
      onOpenRecord(record.id);
      return;
    }
    navigate(entity === "deal" ? `/deals/${record.id}` : `/leads/${record.id}`);
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={`cursor-pointer border border-slate-200 bg-white p-3 transition-shadow ${
        isDragging ? "shadow-lg opacity-80" : "hover:shadow-md"
      }`}
      onClick={openRecord}
    >
      <div className="flex items-start gap-2">
        <button
          {...attributes}
          {...listeners}
          className="mt-0.5 cursor-grab text-slate-400 transition-colors hover:text-slate-700 active:cursor-grabbing"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Drag ${record.name}`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{record.name}</p>
              <p className="truncate text-[11px] text-slate-500">{secondaryLine}</p>
            </div>
            {value ? <span className="text-xs font-semibold text-slate-900">{value}</span> : null}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            {record.dealNumber ? <Badge variant="outline">{record.dealNumber}</Badge> : null}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {daysInStage(record.stageEnteredAt)}d
            </span>
            {location ? (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <MapPin className="h-3 w-3" />
                <span className="truncate">{location}</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
