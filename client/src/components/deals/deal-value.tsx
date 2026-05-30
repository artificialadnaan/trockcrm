import { cn } from "@/lib/utils";
import {
  formatCurrency,
  formatCurrencyCompact,
  isLostBidDeal,
  LOST_BID_VALUE_LABEL,
} from "@/lib/deal-utils";

interface DealValueProps {
  /** Only the stage fields are read; pass the deal/row as-is. */
  deal: { stageSlug?: string | null; bidBoardStageSlug?: string | null; workflowRoute?: string | null };
  /** The already-resolved numeric value (e.g. getEffectiveDealValue / bestEstimate). */
  value: number;
  compact?: boolean;
  className?: string;
  /** Cross-axis alignment of the stacked amount + tag for lost deals. */
  align?: "start" | "end";
}

/**
 * Renders a deal's value. For active/won deals this is exactly
 * `<span className={className}>{formatted}</span>` -- no visual change. For LOST
 * deals the amount is greyed and tagged "Lost bid" so a preserved bid never reads
 * as live or won revenue. The numeric value is never altered or hidden here, and
 * stored data is untouched (Loss Analysis still sums lost-deal value server-side).
 */
export function DealValue({ deal, value, compact = false, className, align = "end" }: DealValueProps) {
  const formatted = compact ? formatCurrencyCompact(value) : formatCurrency(value);

  if (!isLostBidDeal(deal)) {
    return <span className={className}>{formatted}</span>;
  }

  return (
    <span
      className={cn(
        "inline-flex flex-col leading-tight",
        align === "end" ? "items-end" : "items-start",
        className
      )}
      data-deal-value-kind="lost"
    >
      <span
        className="font-normal text-muted-foreground"
        title={`${LOST_BID_VALUE_LABEL} -- preserved bid, not live or won value`}
      >
        {formatted}
      </span>
      <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {LOST_BID_VALUE_LABEL}
      </span>
    </span>
  );
}
