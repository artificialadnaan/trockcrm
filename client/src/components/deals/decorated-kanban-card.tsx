import { Clock, GripVertical, MapPin } from "lucide-react";
import { bestEstimate, daysInStage, formatCurrencyCompact } from "@/lib/deal-utils";
import type { Deal } from "@/hooks/use-deals";
import { cn } from "@/lib/utils";
import { getDealDisplayNumber } from "@/components/deals/kanban-deal-card";

function getInitials(deal: Deal) {
  if (!deal.assignedRepName) return "TR";
  const source = deal.assignedRepName;
  return source
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function locationLine(deal: Deal) {
  if (!deal.propertyCity || !deal.propertyState) return null;
  return `${deal.propertyCity}, ${deal.propertyState}`;
}

interface DecoratedKanbanCardProps {
  deal: Deal;
  stageSlug: string;
  slaDays: number;
  onClick: () => void;
}

export function DecoratedKanbanCard({
  deal,
  stageSlug: _stageSlug,
  slaDays,
  onClick,
}: DecoratedKanbanCardProps) {
  const displayNumber = getDealDisplayNumber(deal);
  const days = daysInStage(deal.stageEnteredAt);
  const isOverSla = slaDays > 0 && days > slaDays;
  const location = locationLine(deal);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-start gap-2 rounded-md border border-slate-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-brand-red/40 hover:bg-brand-red/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
      aria-label={`Open deal ${deal.name}`}
    >
      <GripVertical
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <p
            className={cn(
              "min-w-0 truncate text-[10px] font-black uppercase tracking-[0.16em]",
              displayNumber.isFallback ? "text-slate-400" : "text-brand-red"
            )}
            data-testid="decorated-kanban-card-display-number"
          >
            {displayNumber.label || "--"}
          </p>
          <p className="shrink-0 text-sm font-black tabular-nums text-slate-950">
            {formatCurrencyCompact(bestEstimate(deal))}
          </p>
        </div>

        <p className="line-clamp-2 text-sm font-black leading-5 text-slate-950">{deal.name}</p>

        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-red text-[10px] font-black text-white">
            {getInitials(deal)}
          </span>
          <span className="min-w-0 flex-1 truncate">{deal.companyName || "Account pending"}</span>
        </div>

        <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-500">
          <span className={cn("inline-flex items-center gap-1", isOverSla ? "text-brand-red" : "")}>
            <Clock className="h-3 w-3" />
            {days}d / {slaDays}d SLA
          </span>
          {location ? (
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <MapPin className="h-3 w-3" />
              <span className="truncate">{location}</span>
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
