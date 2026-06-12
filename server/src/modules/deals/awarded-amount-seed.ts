/**
 * Seed value for awarded_amount on a Won-transition, only-if-empty.
 * Returns the bid_estimate to write when awarded_amount is blank and bid is a
 * usable positive value; returns null when no seed should occur (awarded already
 * present, or bid missing / <= 0). Mirrors writeEstimateIfNeeded's "<= 0 skip".
 */
export function awardedAmountSeedOnWin(
  currentAwarded: string | number | null | undefined,
  bidEstimate: string | number | null | undefined,
): string | null {
  const awardedPresent =
    currentAwarded != null && String(currentAwarded).trim() !== "";
  if (awardedPresent) return null;
  if (bidEstimate == null) return null;
  const bidNum = typeof bidEstimate === "string" ? Number(bidEstimate) : bidEstimate;
  if (!Number.isFinite(bidNum) || bidNum <= 0) return null;
  return String(bidEstimate);
}
