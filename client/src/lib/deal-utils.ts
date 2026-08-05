import {
  isGenuineEstimatingDealStageSlug,
  isGenuineLostDealStageSlug,
  isGenuineWonDealStageSlug,
} from "@trock-crm/shared/types";

// The deal/project-number resolver is the single source of truth in @trock-crm/shared/types
// (shared by this app, the field projects API, and global search). Re-exported here so existing
// `@/lib/deal-utils` import sites keep working unchanged.
export {
  isHubspotImportedDealNumber,
  formatDealDisplayNumber,
  resolveDealDisplayNumber,
} from "@trock-crm/shared/types";
export type { DealDisplayNumber } from "@trock-crm/shared/types";

// The deal-NAME resolver lives beside it, for the same reason: a change-order child is stored as
// "<Parent> — Change Order N" and every list truncates before the suffix. Display-only — the stored
// name is unchanged. Re-exported here so deal render sites reach for one `@/lib/deal-utils` import.
export { formatDealDisplayName } from "@trock-crm/shared/types";

const VISIBLE_HUBSPOT_DEAL_NUMBER_PATTERN = /\bHS[-_ ]?\d{6,}\b/gi;

export function sanitizeHubspotDealIdentifiers(
  value: string | null | undefined,
  replacement = "Project pending"
): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed.replace(VISIBLE_HUBSPOT_DEAL_NUMBER_PATTERN, replacement);
}

/**
 * Snap a float sum/difference of 2-decimal money values back onto a cent boundary.
 *
 * Money reaches the client as 2-decimal strings/numbers and is then added with plain `+`, so any
 * chain that mixes signs (a deductive change order, or a residual computed as the difference of two
 * independently grouped sums) lands a hair off the true value: `2.9 + 0.7 - 3.6 === -4.4e-16`, and
 * `360000.04 - (240000.01 + 120000.03) === -5.8e-11`. That noise is `< 0` and `!== 0`, so any sign
 * test on the raw number lies -- painting a break-even contract value red, or inventing an
 * "Unassigned" residual row for a fully attributed book. Put the value through here BEFORE any sign
 * comparison or zero test.
 *
 * Exact at the NUMERIC(14,2) ceiling: 999,999,999,999.99 * 100 is still a safe integer, and
 * 2-decimal inputs can never produce the half-cent tie that Math.round breaks toward +inf.
 *
 * The `=== 0` branch collapses -0 onto 0: rounding a tiny negative gives -0, which Intl renders as
 * "-$0" -- a minus sign on a break-even value, the same misreading in text that the sign fix removes.
 */
export function cents(n: number): number {
  const rounded = Math.round(n * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Format a numeric string as currency (USD).
 */
export function formatCurrency(value: string | number | null | undefined): string {
  if (value == null) return "--";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

/**
 * Format a numeric string as compact currency (e.g., $1.5M).
 */
export function formatCurrencyCompact(value: string | number | null | undefined): string {
  if (value == null) return "--";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(num);
}

/**
 * Calculate current contract value: awarded_amount + Procore change_order_total + CRM change orders.
 *
 * `change_order_total` is the Procore-synced approved-CO rollup; `crmChangeOrderTotal` is the deal
 * detail's `dealChangeOrderTotal`, i.e. the server's sumDealChangeOrders — the CRM change-order value
 * counted EXACTLY ONCE (CO child deals + any not-yet-migrated legacy deal_change_orders rows, no
 * overlap). So this CCV agrees with the deal detail's CO list/total by construction (same source) and
 * the parent's awarded base never contains CO value. Both rollups are added so CCV reflects every CO.
 */
export function currentContractValue(
  deal: {
    awardedAmount?: string | null;
    changeOrderTotal?: string | null;
  },
  crmChangeOrderTotal?: string | number | null
): number {
  const awarded = parseFloat(deal.awardedAmount ?? "0") || 0;
  const coTotal = parseFloat(deal.changeOrderTotal ?? "0") || 0;
  const crmTotal =
    typeof crmChangeOrderTotal === "number"
      ? crmChangeOrderTotal
      : parseFloat((crmChangeOrderTotal ?? "0") as string) || 0;
  return awarded + coTotal + (Number.isFinite(crmTotal) ? crmTotal : 0);
}

/**
 * Combined change-order total shown on the deal: Procore approved COs + CRM-native change orders.
 */
export function combinedChangeOrderTotal(
  changeOrderTotal: string | null | undefined,
  crmChangeOrderTotal: string | number | null | undefined
): number {
  const procore = parseFloat((changeOrderTotal ?? "0") as string) || 0;
  const crm =
    typeof crmChangeOrderTotal === "number"
      ? crmChangeOrderTotal
      : parseFloat((crmChangeOrderTotal ?? "0") as string) || 0;
  return (Number.isFinite(procore) ? procore : 0) + (Number.isFinite(crm) ? crm : 0);
}

export type DealEstimateSource = "bid_board" | "bid" | "estimate" | "awarded" | "none";

export function resolveBestEstimate(deal: {
  awardedAmount?: string | null;
  bidBoardTotalSales?: string | null;
  bidEstimate?: string | null;
  ddEstimate?: string | null;
  // stageSlug IS read here for the 'estimating' DD-over-bid branch (2026-06-18). bidBoardStageSlug /
  // workflowRoute are accepted for caller convenience and used by other helpers (resolveDealValueKind).
  stageSlug?: string | null;
  bidBoardStageSlug?: string | null;
  workflowRoute?: string | null;
  // A change-order child deal (0156) carries its value ONLY in awardedAmount, possibly NEGATIVE for a
  // deductive CO — read by resolveBestEstimate below, which takes it verbatim ahead of the `> 0` fallback
  // chain (mirrors server deal-value-sql.ts's withChangeOrderBranch and shared getRawDealValue /
  // getRawAwardedDealValue; all three MUST NOT drift). A caller whose payload omits it falls through to
  // the plain chain, silently pricing a deductive CO at $0 while every CO-aware surface reads the
  // negative — the exact bug this feature exists to fix; any surface that sums Won deals must supply it.
  isChangeOrder?: boolean | null;
}): { value: number; source: DealEstimateSource } {
  // A change-order child's value is awardedAmount VERBATIM — never the `> 0` fallback chain. A deductive
  // CO is negative and every `> 0` candidate would drop it to 0. Mirrors server deal-value-sql.ts
  // withChangeOrderBranch and shared getRawDealValue — all three MUST NOT drift.
  if (deal.isChangeOrder) {
    return { value: parseFloat(deal.awardedAmount ?? "0") || 0, source: "awarded" };
  }

  // Awarded-first value priority (mirrors server deal-value-sql.ts + shared getRawDealValue), each gated
  // > 0. STAGE-AWARE override for the single 'estimating' stage (2026-06-18): DD outranks the in-progress
  // bid — awarded > dd > bid_board > bid. Bid is NOT skipped, just outranked when DD exists. Excludes
  // service_estimating. Every other stage is unchanged: awarded > bid_board > bid > dd.
  const workflowRoute =
    deal.workflowRoute === "normal" || deal.workflowRoute === "service" ? deal.workflowRoute : null;
  const candidates: Array<[DealEstimateSource, string | null | undefined]> =
    isGenuineEstimatingDealStageSlug(deal.stageSlug, workflowRoute)
      ? [
          ["awarded", deal.awardedAmount],
          ["estimate", deal.ddEstimate],
          ["bid_board", deal.bidBoardTotalSales],
          ["bid", deal.bidEstimate],
        ]
      : [
          ["awarded", deal.awardedAmount],
          ["bid_board", deal.bidBoardTotalSales],
          ["bid", deal.bidEstimate],
          ["estimate", deal.ddEstimate],
        ];

  for (const [source, rawValue] of candidates) {
    const value = parseFloat(rawValue ?? "0");
    if (value > 0) return { value, source };
  }

  return { value: 0, source: "none" };
}

/**
 * Get the deal's effective value — single awarded-first priority:
 * awarded > Bid Board total/bid > DD (each gated > 0).
 */
export function bestEstimate(deal: Parameters<typeof resolveBestEstimate>[0]): number {
  return resolveBestEstimate(deal).value;
}

export type DealValueKind = "active" | "won" | "lost";

/** Label shown next to a lost deal's preserved bid so it never reads as live/won value. */
export const LOST_BID_VALUE_LABEL = "Lost bid";

/**
 * Classify a deal's value for DISPLAY only. This never changes the numeric value:
 * a lost deal keeps its preserved bid (Loss Analysis deliberately sums lost-deal
 * value). The UI uses "lost" to grey + label the amount instead of clearing it.
 */
export function resolveDealValueKind(deal: {
  stageSlug?: string | null;
  bidBoardStageSlug?: string | null;
  workflowRoute?: string | null;
}): DealValueKind {
  const workflowRoute =
    deal.workflowRoute === "normal" || deal.workflowRoute === "service" ? deal.workflowRoute : null;
  // A Bid Board-owned/mirrored deal carries its terminal stage on bidBoardStageSlug while
  // the CRM stageSlug can still read as open -- mirror pipeline-terminal-filters and prefer it.
  const stageSlugs = [deal.bidBoardStageSlug ?? null, deal.stageSlug ?? null];
  if (stageSlugs.some((slug) => isGenuineLostDealStageSlug(slug, workflowRoute))) return "lost";
  if (stageSlugs.some((slug) => isGenuineWonDealStageSlug(slug, workflowRoute))) return "won";
  return "active";
}

/** True when a deal sits in a genuine lost stage -- its value is a historical bid, not live value. */
export function isLostBidDeal(deal: {
  stageSlug?: string | null;
  bidBoardStageSlug?: string | null;
  workflowRoute?: string | null;
}): boolean {
  return resolveDealValueKind(deal) === "lost";
}

export function bestEstimateCaptionLabel(source: DealEstimateSource): string {
  switch (source) {
    case "bid_board":
      return "Bid Board";
    case "bid":
      return "Bid";
    case "estimate":
      return "Estimate";
    case "awarded":
      return "Awarded";
    case "none":
      return "Value";
  }
}

/**
 * Calculate days in current stage.
 */
export function daysInStage(stageEnteredAt: string | Date | null): number {
  if (!stageEnteredAt) return 0;
  const entered = new Date(stageEnteredAt);
  const now = new Date();
  return Math.floor((now.getTime() - entered.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Format relative time (e.g., "3 days ago", "2 hours ago").
 */
export function timeAgo(date: string | Date | null): string {
  if (!date) return "--";
  const d = parseDisplayDate(date);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Format a date as M/D/YYYY.
 */
export function formatDate(date: string | Date | null): string {
  if (!date) return "--";
  return parseDisplayDate(date).toLocaleDateString("en-US");
}

/**
 * Format a date as "Mon D, YYYY" (short display for proposals/closeout).
 */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return parseDisplayDate(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a value for DISPLAY without the date-only off-by-one. A bare date string (YYYY-MM-DD) carries
 * no time/zone, but `new Date("2026-01-14")` parses it as UTC midnight — which renders a day EARLY
 * west of UTC (e.g. "Jan 13" in Central: the bug behind Rise Spring Point's Jan-14 won_closed_date
 * showing "Jan 13"). Anchor such values at LOCAL midnight of the literal calendar day so they display
 * as written, in every timezone. Full timestamps and Date inputs pass through unchanged.
 */
export function parseDisplayDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  if (DATE_ONLY_PATTERN.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
}

/**
 * Get win probability color for badges.
 */
export function winProbabilityColor(probability: number | null): string {
  if (probability == null) return "bg-gray-100 text-gray-600";
  if (probability >= 75) return "bg-green-100 text-green-700";
  if (probability >= 50) return "bg-yellow-100 text-yellow-700";
  if (probability >= 25) return "bg-orange-100 text-orange-700";
  return "bg-red-100 text-red-700";
}
