type DealValueLike = {
  onHold?: boolean | null;
  awardedAmount?: string | number | null;
  bidEstimate?: string | number | null;
  ddEstimate?: string | number | null;
};

type DealHoldTimingLike = {
  stageEnteredAt?: string | Date | null;
  onHold?: boolean | null;
  onHoldStartedAt?: string | Date | null;
  onHoldAccumulatedSeconds?: number | null;
};

function toNumber(value: string | number | null | undefined): number {
  if (value == null || value === "") return 0;
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getRawDealValue(deal: DealValueLike): number {
  const awarded = toNumber(deal.awardedAmount);
  if (awarded > 0) return awarded;
  const bid = toNumber(deal.bidEstimate);
  if (bid > 0) return bid;
  return toNumber(deal.ddEstimate);
}

export function getEffectiveDealValue(deal: DealValueLike): number {
  return deal.onHold ? 0 : getRawDealValue(deal);
}

export function getEffectiveStageAgeSeconds(
  deal: DealHoldTimingLike,
  now: Date = new Date()
): number {
  const stageEnteredAt = toDate(deal.stageEnteredAt);
  if (!stageEnteredAt) return 0;

  const nowTime = now.getTime();
  const rawElapsedSeconds = Math.max(0, Math.floor((nowTime - stageEnteredAt.getTime()) / 1000));
  const accumulatedHoldSeconds = Math.max(0, Math.floor(deal.onHoldAccumulatedSeconds ?? 0));

  let activeHoldSeconds = 0;
  if (deal.onHold) {
    const onHoldStartedAt = toDate(deal.onHoldStartedAt);
    if (onHoldStartedAt) {
      activeHoldSeconds = Math.max(0, Math.floor((nowTime - onHoldStartedAt.getTime()) / 1000));
    }
  }

  return Math.max(0, rawElapsedSeconds - accumulatedHoldSeconds - activeHoldSeconds);
}

export function getEffectiveStageAgeDays(
  deal: DealHoldTimingLike,
  now: Date = new Date()
): number {
  return Math.floor(getEffectiveStageAgeSeconds(deal, now) / 86400);
}
