import { PauseCircle } from "lucide-react";
import { isDealEffectivelyOnHold } from "@trock-crm/shared/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface OnHoldBadgeProps {
  /**
   * Genuine on-hold state for the deal (the stored `deals.on_hold` toggle, surfaced as `deal.onHold`).
   * Optional/undefined-tolerant so card surfaces that don't carry the flag simply render nothing.
   */
  onHold?: boolean | null;
  /**
   * The deal's close target. A deal whose close date is 90+ days out is EFFECTIVELY on hold (auto-park)
   * and zeroed even without the stored flag, so the badge appears on those too wherever the card carries
   * this. Omit it (e.g. a card type that lacks the field) to badge on the stored flag only.
   */
  expectedCloseDate?: string | Date | null;
  /** Compact form for dense surfaces (kanban cards): same visible label, a shorter tooltip. */
  compact?: boolean;
  className?: string;
}

/**
 * Marks a deal that is On Hold — stored on_hold OR effectively held by a far-out (90+ day) close target.
 * Held deals are intentionally valued at $0 in pipeline/forecast rollups, so this badge explains the
 * otherwise-mysterious $0 wherever the deal surfaces as a card. Mirrors `AtRiskBadge` / `ChangeOrderBadge`
 * (outline Badge + the app's first-class status-flag typography), in amber so it reads as a distinct
 * "paused" state — not the red at-risk or teal change-order flag. A held deal never shows an At Risk badge
 * (the shared at-risk engine clears/suppresses risk while a deal is held), so this badge takes that slot.
 */
export function OnHoldBadge({ onHold, expectedCloseDate, compact = false, className }: OnHoldBadgeProps) {
  if (!isDealEffectivelyOnHold({ onHold, expectedCloseDate, now: new Date() })) return null;

  const title = compact
    ? "On hold"
    : "On hold — value is paused and excluded from pipeline and forecast totals";

  return (
    <Badge
      variant="outline"
      data-on-hold="true"
      className={cn(
        "border-amber-300 bg-amber-100 text-[10px] font-black uppercase tracking-[0.14em] text-amber-700",
        className
      )}
      title={title}
      aria-label="On hold"
    >
      <PauseCircle className="h-3 w-3" aria-hidden="true" />
      On Hold
    </Badge>
  );
}
