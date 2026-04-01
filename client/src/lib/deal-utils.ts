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
 * Calculate current contract value: awarded_amount + change_order_total.
 */
export function currentContractValue(deal: {
  awardedAmount?: string | null;
  changeOrderTotal?: string | null;
}): number {
  const awarded = parseFloat(deal.awardedAmount ?? "0") || 0;
  const coTotal = parseFloat(deal.changeOrderTotal ?? "0") || 0;
  return awarded + coTotal;
}

/**
 * Get the "best estimate" for a deal -- awarded > bid > dd.
 */
export function bestEstimate(deal: {
  awardedAmount?: string | null;
  bidEstimate?: string | null;
  ddEstimate?: string | null;
}): number {
  const awarded = parseFloat(deal.awardedAmount ?? "0");
  if (awarded > 0) return awarded;
  const bid = parseFloat(deal.bidEstimate ?? "0");
  if (bid > 0) return bid;
  return parseFloat(deal.ddEstimate ?? "0") || 0;
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
  const d = new Date(date);
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
  return new Date(date).toLocaleDateString("en-US");
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
