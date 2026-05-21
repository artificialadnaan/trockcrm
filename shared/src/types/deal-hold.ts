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
  onHoldAccumulatedSecondsAtStageEntry?: number | null;
};

type DealHoldStageEntryLike = Pick<
  DealHoldTimingLike,
  "onHold" | "onHoldStartedAt" | "onHoldAccumulatedSeconds"
>;

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

export function getHoldStateAtStageEntry(
  deal: DealHoldStageEntryLike,
  stageEnteredAt: Date
): {
  onHoldStartedAt: Date | null;
  onHoldAccumulatedSeconds: number;
  onHoldAccumulatedSecondsAtStageEntry: number;
} {
  const currentAccumulatedHoldSeconds = Math.max(0, Math.floor(deal.onHoldAccumulatedSeconds ?? 0));
  if (!deal.onHold) {
    return {
      onHoldStartedAt: null,
      onHoldAccumulatedSeconds: currentAccumulatedHoldSeconds,
      onHoldAccumulatedSecondsAtStageEntry: currentAccumulatedHoldSeconds,
    };
  }

  const holdStartedAt = toDate(deal.onHoldStartedAt);
  const activeHoldSeconds =
    holdStartedAt == null
      ? 0
      : Math.max(0, Math.floor((stageEnteredAt.getTime() - holdStartedAt.getTime()) / 1000));
  const accumulatedThroughStageExit = currentAccumulatedHoldSeconds + activeHoldSeconds;

  return {
    onHoldStartedAt: stageEnteredAt,
    onHoldAccumulatedSeconds: accumulatedThroughStageExit,
    onHoldAccumulatedSecondsAtStageEntry: accumulatedThroughStageExit,
  };
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
  const accumulatedHoldSecondsAtStageEntry = Math.max(
    0,
    Math.floor(deal.onHoldAccumulatedSecondsAtStageEntry ?? 0)
  );
  const completedHoldSecondsInCurrentStage = Math.max(
    0,
    accumulatedHoldSeconds - accumulatedHoldSecondsAtStageEntry
  );

  let activeHoldSeconds = 0;
  if (deal.onHold) {
    const onHoldStartedAt = toDate(deal.onHoldStartedAt);
    if (onHoldStartedAt) {
      const activeHoldStartTime = Math.max(stageEnteredAt.getTime(), onHoldStartedAt.getTime());
      activeHoldSeconds = Math.max(0, Math.floor((nowTime - activeHoldStartTime) / 1000));
    }
  }

  return Math.max(0, rawElapsedSeconds - completedHoldSecondsInCurrentStage - activeHoldSeconds);
}

export function getEffectiveStageAgeDays(
  deal: DealHoldTimingLike,
  now: Date = new Date()
): number {
  return Math.floor(getEffectiveStageAgeSeconds(deal, now) / 86400);
}
