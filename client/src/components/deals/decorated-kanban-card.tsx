import { AlertCircle, Clock, GripVertical, MapPin } from "lucide-react";
import { DealValue } from "@/components/deals/deal-value";
import type { Deal } from "@/hooks/use-deals";
import { formatDealDisplayName } from "@/lib/deal-utils";
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
import {
  pendingRfpAttentionPresentation,
  type PendingRfpTone,
} from "@/lib/pending-rfp-presentation";

const KANBAN_SLA_AUDIENCE = "rep" satisfies SlaAudience;

// Tone -> classes for the Pending RFP attention marking. The tone KEY and the label come from the
// shared map (pending-rfp-presentation), which the `/deals/pending-rfp` queue reads too; only these
// card-shaped classes live here, mirroring the billing-attention treatment directly below them.
const RFP_ATTENTION_BAR: Record<PendingRfpTone, string> = {
  sky: "bg-sky-600",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  red: "bg-red-600",
};
const RFP_ATTENTION_CHIP: Record<PendingRfpTone, string> = {
  sky: "bg-sky-50 text-sky-700",
  rose: "bg-rose-50 text-rose-700",
  amber: "bg-amber-50 text-amber-800",
  red: "bg-red-50 text-red-700",
};

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
  // A change-order child is STORED as "<Parent> — Change Order N", so a truncated card title reads as
  // its parent. Display-only reorder to "Change Order N — <Parent>"; the stored name is untouched.
  const displayName = formatDealDisplayName(deal.name, deal.isChangeOrder);
  const days = getEffectiveStageAgeDays(getEffectiveStageAgeDeal(deal));
  const slaDays = resolveKanbanSlaThresholdDays(stageSlug);
  const showSla = !isTerminalStage(stageSlug) && slaDays !== null;
  const isOverSla = showSla && slaDays > 0 && days > slaDays;
  const location = locationLine(deal);
  // Surface the deal description on the card so users can tell deals apart without drilling in (it is
  // already shown in the list view). Trimmed + clamped so long text can't inflate the card height.
  const description = deal.description?.trim() ?? "";
  // Telling cards apart is EXACTLY what the scope title is for, and it does it better than two clamped
  // lines of a notes field — so when a deal has one it leads, with the description still beneath it.
  // A deal without a title is unchanged (#1051).
  const scopeTitle = deal.scopeTitle?.trim() ?? "";
  const ownerColor = getOwnerInitialColor(deal.assignedRepId ?? deal.assignedRepName);
  // The column slug is authoritative (a board row may omit deal.stageSlug). Stamp it ONCE and use the
  // same object for the value AND the badge, so the won-aware hold check and the value can't disagree
  // (e.g. a Won-column row reading as auto-held only because its slug was missing). A SHARED `now` keeps
  // the value and the badge on the same horizon across a midnight/90-day-boundary rollover.
  const dealForValue = { ...deal, stageSlug };
  const now = new Date();
  const effectivelyHeld = isDealValueEffectivelyOnHold(dealForValue, now);
  const billingAttentionRequired = deal.billingAttentionRequired === true;
  // Mark ONLY the Pending RFP deals that need someone to act (send_failed / declined / conflict). Gated
  // on the column slug, which the board stamps from the synthetic column (`pending_rfp`) — membership was
  // already decided upstream, so this reads that decision rather than re-deriving it and risking a card
  // that disagrees with the column it is drawn in. Awaiting deals are deliberately left unmarked.
  const rfpAttention =
    stageSlug === "pending_rfp" ? pendingRfpAttentionPresentation(deal.rfpApprovalStatus) : null;
  // Billing attention is computed for Won-family columns only, so it can never co-occur with an RFP
  // mark — but the spacing offsets belong to "there is a top bar", not to either flag specifically.
  const hasTopAccentBar = billingAttentionRequired || rfpAttention !== null;
  // The button's aria-label overrides its descendant text, so fold the description into the accessible
  // name — otherwise screen-reader users can't use it to tell similar cards apart (the whole point of
  // showing it). Appended after any billing alert; omitted when there is no description.
  // Both go into the accessible name, title first, in the same order they render.
  const descriptionSuffix = [scopeTitle, description].filter(Boolean).map((part) => `. ${part}`).join("");
  // The marking's colour must never be the only carrier of its meaning — the chip states it in text for
  // sighted users, and this states it for screen readers. Billing keeps precedence in the name for the
  // same reason it keeps the bar: it is the more urgent flag, even though the two cannot co-occur today.
  const alertSuffix = billingAttentionRequired
    ? ": billing contact missing"
    : rfpAttention
      ? `: RFP ${rfpAttention.label.toLowerCase()}`
      : "";
  const accessibleName = `Open deal ${displayName}${alertSuffix}${descriptionSuffix}`;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex w-full items-start gap-2 overflow-hidden rounded-md border border-slate-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-brand-red/40 hover:bg-brand-red/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
        billingAttentionRequired && "border-red-300"
      )}
      aria-label={accessibleName}
    >
      {billingAttentionRequired ? (
        <span className="absolute inset-x-0 top-0 h-1 bg-red-600" aria-hidden="true" />
      ) : null}
      {rfpAttention ? (
        <span
          className={cn("absolute inset-x-0 top-0 h-1", RFP_ATTENTION_BAR[rfpAttention.tone])}
          aria-hidden="true"
        />
      ) : null}
      <GripVertical
        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500", hasTopAccentBar && "mt-1")}
        aria-hidden="true"
      />
      <div className={cn("min-w-0 flex-1 space-y-2", hasTopAccentBar && "pt-1")}>
        {billingAttentionRequired ? (
          <span className="inline-flex items-center gap-1 rounded-sm bg-red-50 px-1.5 py-0.5 text-[10px] font-black tracking-[0.12em] text-red-700 uppercase">
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            Billing contact missing
          </span>
        ) : null}
        {rfpAttention ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-black tracking-[0.12em] uppercase",
              RFP_ATTENTION_CHIP[rfpAttention.tone]
            )}
            data-testid="pending-rfp-attention-chip"
          >
            <rfpAttention.Icon className="h-3 w-3" aria-hidden="true" />
            {rfpAttention.label}
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

        <p className="line-clamp-2 text-sm font-black leading-5 text-slate-950">{displayName}</p>

        {scopeTitle ? (
          <p
            className="line-clamp-2 text-xs font-bold leading-4 text-slate-700"
            title={scopeTitle}
            data-testid="kanban-card-scope-title"
          >
            {scopeTitle}
          </p>
        ) : null}

        {description ? (
          <p
            className="line-clamp-2 text-xs font-medium leading-4 text-slate-500"
            title={description}
            data-testid="decorated-kanban-card-description"
          >
            {description}
          </p>
        ) : null}

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
