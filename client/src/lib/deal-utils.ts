import { isGenuineLostDealStageSlug, isGenuineWonDealStageSlug } from "@trock-crm/shared/types";

const HUBSPOT_DEAL_NUMBER_PATTERN = /^HS[-_ ]?\d+/i;
const VISIBLE_HUBSPOT_DEAL_NUMBER_PATTERN = /\bHS[-_ ]?\d{6,}\b/gi;

export function isHubspotImportedDealNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return HUBSPOT_DEAL_NUMBER_PATTERN.test(value.trim());
}

export interface DealDisplayNumber {
  label: string;
  isFallback: boolean;
  isPending: boolean;
}

export function formatDealDisplayNumber(
  deal: {
    projectNumber?: string | null;
    dealNumber?: string | null;
    propertyState?: string | null;
  }
): DealDisplayNumber {
  const projectNumber = deal.projectNumber?.trim();
  if (projectNumber) return { label: projectNumber, isFallback: false, isPending: false };

  const dealNumber = deal.dealNumber?.trim();
  if (dealNumber && !isHubspotImportedDealNumber(dealNumber)) {
    return { label: dealNumber, isFallback: true, isPending: false };
  }

  return { label: "Pending", isFallback: true, isPending: true };
}

export function sanitizeHubspotDealIdentifiers(
  value: string | null | undefined,
  replacement = "Project pending"
): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed.replace(VISIBLE_HUBSPOT_DEAL_NUMBER_PATTERN, replacement);
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
  stageSlug?: string | null;
  bidBoardStageSlug?: string | null;
  workflowRoute?: string | null;
}): { value: number; source: DealEstimateSource } {
  const candidates: Array<[DealEstimateSource, string | null | undefined]> = shouldUseAwardedEstimate(deal)
    ? [
        ["awarded", deal.awardedAmount],
        ["bid_board", deal.bidBoardTotalSales],
        ["bid", deal.bidEstimate],
        ["estimate", deal.ddEstimate],
      ]
    : [
        ["bid_board", deal.bidBoardTotalSales],
        ["bid", deal.bidEstimate],
        ["estimate", deal.ddEstimate],
        ["awarded", deal.awardedAmount],
      ];

  for (const [source, rawValue] of candidates) {
    const value = parseFloat(rawValue ?? "0");
    if (value > 0) return { value, source };
  }

  return { value: 0, source: "none" };
}

function shouldUseAwardedEstimate(deal: {
  stageSlug?: string | null;
  bidBoardStageSlug?: string | null;
  workflowRoute?: string | null;
}) {
  const stageSlug = deal.stageSlug ?? null;
  const workflowRoute =
    deal.workflowRoute === "normal" || deal.workflowRoute === "service" ? deal.workflowRoute : null;
  return isGenuineWonDealStageSlug(stageSlug, workflowRoute);
}

/**
 * Get the generic/current deal value -- Bid Board total/bid > DD > awarded fallback.
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
