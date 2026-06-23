import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { bestEstimate, formatDealDisplayNumber } from "@/lib/deal-utils";
import { DealValue } from "@/components/deals/deal-value";
import { cn } from "@/lib/utils";
import type { Deal } from "@/hooks/use-deals";
import { AtRiskBadge } from "@/components/deals/at-risk-badge";
import { ChangeOrderBadge } from "@/components/deals/change-order-badge";
import { OnHoldBadge } from "@/components/deals/on-hold-badge";
import {
  getEffectiveStageAgeDeal,
  getEffectiveStageAgeDays,
  isDealValueEffectivelyOnHold,
} from "@trock-crm/shared/types";

export function getDealDisplayNumber(deal: Pick<Deal, "dealNumber" | "projectNumber">) {
  return formatDealDisplayNumber(deal);
}

interface KanbanDealCardProps {
  deal: Deal;
  /** Column stage slug -- authoritative when the pipeline deal row omits stageSlug. */
  stageSlug?: string;
  onClick?: () => void;
  isDragging?: boolean;
  containerRef?: (node: HTMLElement | null) => void;
  containerStyle?: CSSProperties;
  dragHandle?: ReactNode;
  className?: string;
}

export function KanbanDealCard({
  deal,
  stageSlug,
  onClick,
  isDragging,
  containerRef,
  containerStyle,
  dragHandle,
  className,
}: KanbanDealCardProps) {
  const navigate = useNavigate();
  const handleClick = onClick ?? (() => navigate(`/deals/${deal.id}`));

  const days = getEffectiveStageAgeDays(getEffectiveStageAgeDeal(deal));
  // Value from the column-slug-stamped deal (the same object the lost-bid label uses below), so the
  // stage-aware chain (estimating DD-over-bid) applies even if the board row omits stageSlug — keeping the
  // card value reconciled with the server stage-aware column total. The stageSlug prop is authoritative.
  // A (won-aware) effectively-held deal shows $0 so the card matches its On Hold badge AND the server's
  // zeroed rollup — held = stored on_hold OR (for an OPEN deal) a far-out close target.
  const dealForValue = { ...deal, stageSlug: deal.stageSlug ?? stageSlug };
  const effectivelyHeld = isDealValueEffectivelyOnHold(dealForValue);
  const value = effectivelyHeld ? 0 : bestEstimate(dealForValue);
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
          <DealValue
            deal={dealForValue}
            value={value}
            compact
            className="whitespace-nowrap text-sm font-semibold tabular-nums text-gray-900"
          />
        </div>
        <OnHoldBadge onHold={effectivelyHeld} compact className="mt-1" />
        {/* A held deal is never also "at risk" (the On Hold badge takes the slot) — suppress so an
            auto-held far-out deal can't show both badges at once. */}
        <AtRiskBadge atRisk={effectivelyHeld ? null : deal.atRisk} compact className="mt-1" />
        <ChangeOrderBadge isChangeOrder={deal.isChangeOrder} compact className="mt-1" />
        <p className="mt-0.5 truncate text-xs text-gray-500">{metaParts.join(" · ")}</p>
      </div>
    </div>
  );
}
