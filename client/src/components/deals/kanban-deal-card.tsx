import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { bestEstimate, daysInStage, formatCurrencyCompact, formatDealDisplayNumber } from "@/lib/deal-utils";
import { cn } from "@/lib/utils";
import type { Deal } from "@/hooks/use-deals";
import { AtRiskBadge } from "@/components/deals/at-risk-badge";

export function getDealDisplayNumber(deal: Pick<Deal, "dealNumber" | "projectNumber">) {
  return formatDealDisplayNumber(deal);
}

interface KanbanDealCardProps {
  deal: Deal;
  onClick?: () => void;
  isDragging?: boolean;
  containerRef?: (node: HTMLElement | null) => void;
  containerStyle?: CSSProperties;
  dragHandle?: ReactNode;
  className?: string;
}

export function KanbanDealCard({
  deal,
  onClick,
  isDragging,
  containerRef,
  containerStyle,
  dragHandle,
  className,
}: KanbanDealCardProps) {
  const navigate = useNavigate();
  const handleClick = onClick ?? (() => navigate(`/deals/${deal.id}`));

  const days = daysInStage(deal.stageEnteredAt);
  const value = bestEstimate(deal);
  const displayNumber = getDealDisplayNumber(deal);

  const metaParts: string[] = [];
  if (deal.propertyCity) metaParts.push(deal.propertyCity);
  metaParts.push(`${days}d in stage`);

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      className={cn(
        "group relative cursor-pointer border border-gray-200 bg-white hover:border-gray-300",
        isDragging && "opacity-60",
        className
      )}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleClick();
        }
      }}
      aria-label={`Open deal ${deal.name}`}
    >
      {dragHandle}
      <div className={cn("px-3 py-2.5", dragHandle ? "pl-5" : "")}>
        {displayNumber.label ? (
          <p
            className={cn(
              "mb-1 truncate text-[10px] font-black uppercase tracking-[0.16em]",
              displayNumber.isFallback ? "text-gray-400" : "text-brand-red"
            )}
            data-testid="kanban-deal-card-display-number"
          >
            {displayNumber.label}
          </p>
        ) : null}
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-medium text-gray-900">{deal.name}</p>
          <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-gray-900">
            {formatCurrencyCompact(value)}
          </span>
        </div>
        <AtRiskBadge atRisk={deal.atRisk} compact className="mt-1" />
        <p className="mt-0.5 truncate text-xs text-gray-500">{metaParts.join(" · ")}</p>
      </div>
    </div>
  );
}
