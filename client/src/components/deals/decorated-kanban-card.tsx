import { AlertCircle, Clock, GripVertical, MapPin } from "lucide-react";
import { DealValue } from "@/components/deals/deal-value";
import type { Deal } from "@/hooks/use-deals";
import { cn } from "@/lib/utils";
import { getDealDisplayNumber } from "@/components/deals/kanban-deal-card";
import { isTerminalStage } from "@/lib/pipeline-terminal-filters";
import {
  getEffectiveDealValue,
  isDealValueEffectivelyOnHold,
  getEffectiveStageAgeDeal,
  getEffectiveStageAgeDays,
  getOwnerInitialColor,
  getSlaPolicy,
  type SlaAudience,
  type SlaPolicyStageSlug,
} from "@trock-crm/shared/types";
import { AtRiskBadge } from "@/components/deals/at-risk-badge";
import { ChangeOrderBadge } from "@/components/deals/change-order-badge";
import { OnHoldBadge } from "@/components/deals/on-hold-badge";

const KANBAN_SLA_AUDIENCE = "rep" satisfies SlaAudience;

export function resolveKanbanSlaThresholdDays(stageSlug: string): number | null {
  return getSlaPolicy(stageSlug as SlaPolicyStageSlug, KANBAN_SLA_AUDIENCE)?.thresholdDays ?? null;
}

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
  const parts = [deal.propertyCity, deal.propertyState].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

interface DecoratedKanbanCardProps {
  deal: Deal;
  stageSlug: string;
  onClick: () => void;
}

export function DecoratedKanbanCard({
  deal,
  stageSlug,
  onClick,
}: DecoratedKanbanCardProps) {
  const displayNumber = getDealDisplayNumber(deal);
  const days = getEffectiveStageAgeDays(getEffectiveStageAgeDeal(deal));
  const slaDays = resolveKanbanSlaThresholdDays(stageSlug);
  const showSla = !isTerminalStage(stageSlug) && slaDays !== null;
  const isOverSla = showSla && slaDays > 0 && days > slaDays;
  const location = locationLine(deal);
  const ownerColor = getOwnerInitialColor(deal.assignedRepId ?? deal.assignedRepName);
  // The column slug is authoritative (a board row may omit deal.stageSlug). Stamp it ONCE and use the
  // same object for the value AND the badge, so the won-aware hold check and the value can't disagree
  // (e.g. a Won-column row reading as auto-held only because its slug was missing). A SHARED `now` keeps
  // the value and the badge on the same horizon across a midnight/90-day-boundary rollover.
  const dealForValue = { ...deal, stageSlug };
  const now = new Date();
  const effectivelyHeld = isDealValueEffectivelyOnHold(dealForValue, now);
  const billingAttentionRequired = deal.billingAttentionRequired === true;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex w-full items-start gap-2 overflow-hidden rounded-md border border-slate-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-brand-red/40 hover:bg-brand-red/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
        billingAttentionRequired && "border-red-300"
      )}
      aria-label={`Open deal ${deal.name}`}
    >
      {billingAttentionRequired ? (
        <span className="absolute inset-x-0 top-0 h-1 bg-red-600" aria-hidden="true" />
      ) : null}
      <GripVertical
        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500", billingAttentionRequired && "mt-1")}
        aria-hidden="true"
      />
      <div className={cn("min-w-0 flex-1 space-y-2", billingAttentionRequired && "pt-1")}>
        {billingAttentionRequired ? (
          <span className="inline-flex items-center gap-1 rounded-sm bg-red-50 px-1.5 py-0.5 text-[10px] font-black tracking-[0.12em] text-red-700 uppercase">
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            Billing contact missing
          </span>
        ) : null}
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
          <DealValue
            deal={dealForValue}
            // Value from the column-slug-stamped deal so the stage-aware chain (estimating DD-over-bid)
            // applies even if the board row omits stageSlug — reconciles the card with the column total.
            value={getEffectiveDealValue(dealForValue, now)}
            compact
            className="shrink-0 text-sm font-black tabular-nums text-slate-950"
          />
        </div>

        <OnHoldBadge onHold={effectivelyHeld} compact />
        {/* A held deal is never also "at risk" — the On Hold badge takes the slot (mirrors the engine,
            which clears risk while held). Suppress here so an auto-held far-out deal can't show both. */}
        <AtRiskBadge atRisk={effectivelyHeld ? null : deal.atRisk} compact />
        <ChangeOrderBadge isChangeOrder={deal.isChangeOrder} compact />

        <p className="line-clamp-2 text-sm font-black leading-5 text-slate-950">{deal.name}</p>

        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white"
            style={{ backgroundColor: ownerColor.backgroundColor, color: ownerColor.textColor }}
          >
            {getInitials(deal)}
          </span>
          <span className="min-w-0 flex-1 truncate">{deal.companyName || "Account pending"}</span>
        </div>

        <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-500">
          <span className={cn("inline-flex items-center gap-1", isOverSla ? "text-brand-red" : "")}>
            <Clock className="h-3 w-3" />
            {showSla ? `${days}d / ${slaDays}d SLA` : `${days}d`}
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
