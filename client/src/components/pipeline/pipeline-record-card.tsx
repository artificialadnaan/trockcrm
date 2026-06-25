import { useNavigate } from "react-router-dom";
import { useDraggable } from "@dnd-kit/core";
import { GripVertical, Clock, MapPin } from "lucide-react";
import { formatCurrencyCompact } from "@/lib/deal-utils";
import { cn } from "@/lib/utils";
import {
  getEffectiveDealValue,
  isDealValueEffectivelyOnHold,
  getEffectiveStageAgeDeal,
  getEffectiveStageAgeDays,
  type AtRiskResult,
} from "@trock-crm/shared/types";
import { AtRiskBadge } from "@/components/deals/at-risk-badge";
import { ChangeOrderBadge } from "@/components/deals/change-order-badge";
import { OnHoldBadge } from "@/components/deals/on-hold-badge";

export interface PipelineRecordCardData {
  id: string;
  name: string;
  stageId: string;
  // Read by getEffectiveDealValue for the 'estimating' DD-over-bid value branch (2026-06-18), so the
  // per-card value matches the stage-aware column total. Stamped from the column slug when a card omits it.
  stageSlug?: string | null;
  // The close target + bid-board mirror stage feed the won-aware effective-hold check, so an auto-held
  // (90+ day) OPEN card shows $0 AND the On Hold badge, matching the kanban cards. Present at runtime when
  // a full Deal is passed structurally as this narrow type.
  expectedCloseDate?: string | null;
  bidBoardStageSlug?: string | null;
  stageEnteredAt: string;
  updatedAt: string;
  status?: string | null;
  isBidBoardOwned?: boolean | null;
  bidBoardStageEnteredAt?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  companyName?: string | null;
  source?: string | null;
  dealNumber?: string | null;
  awardedAmount?: string | null;
  bidEstimate?: string | null;
  ddEstimate?: string | null;
  onHold?: boolean | null;
  onHoldStartedAt?: string | null;
  onHoldAccumulatedSeconds?: number | null;
  onHoldAccumulatedSecondsAtStageEntry?: number | null;
  workflowRoute?: string | null;
  atRisk?: AtRiskResult | null;
  // CO-child model (BLUE PR1). Deal board cards are full Deal objects passed structurally as this
  // narrow type, so the flag flows through once it lands; only ever set/shown for deal records.
  isChangeOrder?: boolean | null;
}

interface PipelineRecordCardProps {
  entity: "lead" | "deal";
  record: PipelineRecordCardData;
  onOpenRecord?: (recordId: string) => void;
  isDragging?: boolean;
}

function formatValue(record: PipelineRecordCardData, now: Date) {
  const value = getEffectiveDealValue(record, now);
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
  // One shared `now` so the value and the badge can't disagree across a day/90-day-boundary rollover.
  const now = new Date();
  const effectivelyHeld = isDealValueEffectivelyOnHold(record, now);
  const value = formatValue(record, now);
  const location = [record.propertyCity, record.propertyState].filter(Boolean).join(", ");
  const contextLine = record.companyName ?? record.source ?? null;
  const ageLabel = `${record.atRisk?.effectiveStageAgeDays ?? getEffectiveStageAgeDays(getEffectiveStageAgeDeal(record))}d in stage`;

  const openRecord = () => {
    if (onOpenRecord) {
      onOpenRecord(record.id);
      return;
    }
    navigate(entity === "deal" ? `/deals/${record.id}` : `/leads/${record.id}`);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "cursor-pointer rounded-[1.2rem] border border-slate-200/90 bg-white px-4 py-3.5 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition-all",
        isDragging ? "scale-[1.01] opacity-80 shadow-lg" : "hover:-translate-y-0.5 hover:shadow-md"
      )}
      onClick={openRecord}
    >
      <div className="flex items-start gap-3">
        <button
          {...attributes}
          {...listeners}
          className="mt-1 cursor-grab text-slate-300 transition-colors hover:text-slate-600 active:cursor-grabbing"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Drag ${record.name}`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              {record.dealNumber ? (
                <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-[10px] font-black tracking-[0.16em] text-slate-500 uppercase">
                  {record.dealNumber}
                </span>
              ) : null}
              {entity === "deal" ? <OnHoldBadge onHold={effectivelyHeld} compact /> : null}
              {entity === "deal" ? (
                <AtRiskBadge atRisk={effectivelyHeld ? null : record.atRisk} compact />
              ) : null}
              {entity === "deal" ? (
                <ChangeOrderBadge isChangeOrder={record.isChangeOrder} compact />
              ) : null}
              <p className="line-clamp-2 text-[15px] leading-5 font-semibold text-slate-900" title={record.name}>{record.name}</p>
            </div>
            {value ? (
              <span className="shrink-0 text-right text-[1.1rem] leading-none font-black tracking-tight text-slate-900">
                {value}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-slate-500">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {ageLabel}
            </span>
            {location ? (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <span className="text-slate-300">•</span>
                <MapPin className="h-3 w-3" />
                <span className="truncate" title={location}>{location}</span>
              </span>
            ) : null}
            {contextLine ? (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <span className="text-slate-300">•</span>
                <span className="truncate" title={contextLine}>{contextLine}</span>
              </span>
            ) : null}
            {!location && !contextLine ? (
              <span className="inline-flex items-center gap-1">
                <span className="text-slate-300">•</span>
                Unassigned
              </span>
            ) : null}
          </div>
          {entity === "lead" && value ? (
            <div className="text-[11px] font-semibold tracking-[0.16em] text-slate-400 uppercase">
              estimated value
            </div>
          ) : null}
          {entity === "deal" && !value && record.workflowRoute ? (
            <div className="text-[11px] font-semibold tracking-[0.16em] text-slate-400 uppercase">
              {record.workflowRoute}
            </div>
          ) : null}
          {entity === "lead" && record.status ? (
            <div className="text-[11px] font-semibold tracking-[0.16em] text-slate-400 uppercase">
              {record.status}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
