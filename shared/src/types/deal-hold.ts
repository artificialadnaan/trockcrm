import { isGenuineWonDealStageSlug } from "./workflow.js";

/*
Hold-time invariants audited on 2026-05-21 across this file, the deal hold toggle
path in server/src/modules/deals/service.ts, and the five stage-writer paths:
1. Effective stage age is never negative.
2. Prior-stage hold time is never subtracted from the current stage.
3. An open hold start is never moved earlier than the real hold start.
4. Releasing hold adds exactly the elapsed open-hold seconds to the accumulator.
5. Multiple hold cycles within a stage sum through the lifetime accumulator.
6. Entering a stage while already on hold snapshots prior hold time and keeps the
   current-stage open hold anchored at max(stageEnteredAt, onHoldStartedAt).
7. Historical mirrored stageEnteredAt values cannot backdate or double-count hold time.
8. Non-stage updates preserve existing hold values, and the audited writers keep the
   NOT NULL hold accumulators populated on every persisted update path.
9. onHoldAccumulatedSeconds and onHoldAccumulatedSecondsAtStageEntry stay consistent
   because stage-transition writers derive persisted hold state from
   getHoldStateAtStageEntry() before writing it.
*/

type DealValueLike = {
  onHold?: boolean | null;
  awardedAmount?: string | number | null;
  bidBoardTotalSales?: string | number | null;
  bidEstimate?: string | number | null;
  ddEstimate?: string | number | null;
  stageSlug?: string | null;
  bidBoardStageSlug?: string | null;
  workflowRoute?: string | null;
  stage?: { slug?: string | null; isTerminal?: boolean | null } | null;
};

type DealHoldTimingLike = {
  stageEnteredAt?: string | Date | null;
  onHold?: boolean | null;
  onHoldStartedAt?: string | Date | null;
  onHoldAccumulatedSeconds?: number | null;
  onHoldAccumulatedSecondsAtStageEntry?: number | null;
};

type DealStageAgeSourceLike = {
  stageEnteredAt?: string | Date | null;
  isBidBoardOwned?: boolean | null;
  bidBoardStageEnteredAt?: string | Date | null;
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

function shouldUseAwardedDealValue(deal: DealValueLike): boolean {
  const stageSlug = deal.stageSlug ?? deal.stage?.slug ?? null;
  const workflowRoute =
    deal.workflowRoute === "normal" || deal.workflowRoute === "service" ? deal.workflowRoute : null;
  return isGenuineWonDealStageSlug(stageSlug, workflowRoute);
}

function getRawDealValue(deal: DealValueLike): number {
  const candidates = shouldUseAwardedDealValue(deal)
    ? [deal.awardedAmount, deal.bidBoardTotalSales, deal.bidEstimate, deal.ddEstimate]
    : [deal.bidBoardTotalSales, deal.bidEstimate, deal.ddEstimate, deal.awardedAmount];

  for (const candidate of candidates) {
    const value = toNumber(candidate);
    if (value > 0) return value;
  }

  return 0;
}

function getRawAwardedDealValue(deal: DealValueLike): number {
  const awarded = toNumber(deal.awardedAmount);
  return awarded > 0 ? awarded : 0;
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
  const effectiveHoldStartAt =
    holdStartedAt == null
      ? stageEnteredAt
      : new Date(Math.max(stageEnteredAt.getTime(), holdStartedAt.getTime()));
  const activeHoldSeconds =
    holdStartedAt == null
      ? 0
      : Math.max(0, Math.floor((stageEnteredAt.getTime() - holdStartedAt.getTime()) / 1000));
  const accumulatedThroughStageExit = currentAccumulatedHoldSeconds + activeHoldSeconds;

  return {
    onHoldStartedAt: effectiveHoldStartAt,
    onHoldAccumulatedSeconds: accumulatedThroughStageExit,
    onHoldAccumulatedSecondsAtStageEntry: accumulatedThroughStageExit,
  };
}

export function getEffectiveDealValue(deal: DealValueLike): number {
  return deal.onHold ? 0 : getRawDealValue(deal);
}

export function getEffectiveAwardedDealValue(deal: DealValueLike): number {
  return deal.onHold ? 0 : getRawAwardedDealValue(deal);
}

export function resolveEffectiveStageEnteredAt(
  deal: DealStageAgeSourceLike
): string | Date | null {
  if (deal.isBidBoardOwned === true && deal.bidBoardStageEnteredAt) {
    return deal.bidBoardStageEnteredAt;
  }

  return deal.stageEnteredAt ?? null;
}

export function getEffectiveStageAgeDeal<T extends DealStageAgeSourceLike>(
  deal: T
): T & { stageEnteredAt: string | Date | null } {
  return {
    ...deal,
    stageEnteredAt: resolveEffectiveStageEnteredAt(deal),
  };
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
