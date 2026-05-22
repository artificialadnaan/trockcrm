import type { AtRiskResult } from "@trock-crm/shared/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface AtRiskBadgeProps {
  atRisk?: AtRiskResult | null;
  compact?: boolean;
  className?: string;
}

function formatSlaContext(atRisk: AtRiskResult) {
  if (atRisk.thresholdDays == null) return `${atRisk.effectiveStageAgeDays}d`;
  return `${atRisk.effectiveStageAgeDays}d / ${atRisk.thresholdDays}d SLA`;
}

export function AtRiskBadge({ atRisk, compact = false, className }: AtRiskBadgeProps) {
  if (!atRisk?.isAtRisk || atRisk.status !== "at_risk" || atRisk.severity === "none") {
    return null;
  }

  const context = formatSlaContext(atRisk);
  const pastThreshold =
    atRisk.secondsPastThreshold != null
      ? Math.max(0, Math.floor(atRisk.secondsPastThreshold / 86_400))
      : null;
  const title = compact ? "At Risk" : [
    "At Risk",
    context,
    pastThreshold != null && pastThreshold > 0 ? `${pastThreshold}d past threshold` : null,
  ].filter(Boolean).join(" - ");

  return (
    <Badge
      variant="outline"
      data-at-risk-status={atRisk.status}
      data-at-risk-severity={atRisk.severity}
      className={cn(
        "border-brand-red/25 bg-brand-red/10 text-[10px] font-black uppercase tracking-[0.14em] text-brand-red",
        className
      )}
      title={title}
      aria-label={title}
    >
      {compact ? "At Risk" : `At Risk · ${context}`}
    </Badge>
  );
}
