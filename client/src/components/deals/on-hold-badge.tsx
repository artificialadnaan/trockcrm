import { PauseCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface OnHoldBadgeProps {
  /**
   * Whether the deal reads as on hold. A dumb boolean: callers pass the EFFECTIVE held state — the stored
   * `deals.on_hold` flag OR (for an OPEN deal) a far-out close target — via the shared, won-aware
   * `isDealValueEffectivelyOnHold`, so the badge always agrees with the card's $0. Undefined-tolerant so
   * surfaces that don't carry hold state render nothing.
   */
  onHold?: boolean | null;
  /** Compact form for dense surfaces (kanban cards): same visible label, a shorter tooltip. */
  compact?: boolean;
  className?: string;
}

/**
 * Marks a deal that is On Hold — the stored on_hold flag OR an OPEN deal effectively held by a far-out
 * (90+ day) close target (the caller computes that via isDealValueEffectivelyOnHold). Held deals are
 * intentionally valued at $0 in pipeline/forecast rollups, so this badge explains the otherwise-mysterious
 * $0 wherever the deal surfaces as a card. Mirrors `AtRiskBadge` / `ChangeOrderBadge` (outline Badge + the
 * app's first-class status-flag typography), in amber so it reads as a distinct "paused" state — not the
 * red at-risk or teal change-order flag. A held deal never shows an At Risk badge (the shared at-risk
 * engine clears/suppresses risk while a deal is held), so this badge takes that slot.
 */
export function OnHoldBadge({ onHold, compact = false, className }: OnHoldBadgeProps) {
  if (onHold !== true) return null;

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
