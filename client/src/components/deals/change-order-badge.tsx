import { GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ChangeOrderBadgeProps {
  /**
   * BLUE PR1 (`deals.is_change_order`). Optional/undefined-tolerant: the flag is absent on the wire
   * until the CO-child model lands, so the badge simply renders nothing until then.
   */
  isChangeOrder?: boolean | null;
  /** Compact form ("CO") for dense surfaces like kanban cards. */
  compact?: boolean;
  className?: string;
}

/**
 * Marks a deal that is a Change Order CHILD of a parent project deal (BLUE's CO-child-deal model).
 * A CO child is a real Won deal in the data; this badge keeps it from being mistaken for an
 * independent deal anywhere it surfaces as a card/row. Mirrors `AtRiskBadge` (outline Badge +
 * the app's first-class status-flag typography), in a distinct teal — unclaimed by any stage
 * pill (notably NOT the `sent_to_production` cyan) so it reads as its own status, not a stage.
 */
export function ChangeOrderBadge({ isChangeOrder, compact = false, className }: ChangeOrderBadgeProps) {
  if (isChangeOrder !== true) return null;

  return (
    <Badge
      variant="outline"
      data-change-order="true"
      className={cn(
        "border-teal-200 bg-teal-100 text-[10px] font-black uppercase tracking-[0.14em] text-teal-700",
        className
      )}
      title="Change order — a child of the parent project deal"
      aria-label="Change order"
    >
      <GitBranch className="h-3 w-3" aria-hidden="true" />
      {compact ? "CO" : "Change Order"}
    </Badge>
  );
}
