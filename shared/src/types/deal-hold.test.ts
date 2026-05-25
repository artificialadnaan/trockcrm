import { describe, expect, it } from "vitest";
import {
  getEffectiveAwardedDealValue,
  getEffectiveDealValue,
  getEffectiveStageAgeDeal,
  getEffectiveStageAgeDays,
  getEffectiveStageAgeSeconds,
  getHoldStateAtStageEntry,
  resolveEffectiveStageEnteredAt,
} from "./deal-hold.js";

describe("deal hold helpers", () => {
  it("returns zero effective value while a deal is on hold", () => {
    expect(
      getEffectiveDealValue({
        onHold: true,
        awardedAmount: "925000",
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toBe(0);
  });

  it("returns the real deal value when a deal is not on hold", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        awardedAmount: null,
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toBe(875000);
  });

  it("prefers the synced Bid Board or bid value over awarded amount for generic open-deal value", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        bidBoardTotalSales: "16137.14",
        bidEstimate: "16137.14",
        awardedAmount: "2.97",
        ddEstimate: "3.00",
      })
    ).toBe(16137.14);

    expect(
      getEffectiveDealValue({
        onHold: false,
        bidEstimate: "16137.14",
        awardedAmount: "2.97",
        ddEstimate: "3.00",
      })
    ).toBe(16137.14);
  });

  it("keeps awarded-basis value at zero when no awarded amount exists", () => {
    expect(
      getEffectiveAwardedDealValue({
        onHold: false,
        awardedAmount: null,
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toBe(0);
  });

  it("zeros awarded-basis value while a deal is on hold", () => {
    expect(
      getEffectiveAwardedDealValue({
        onHold: true,
        awardedAmount: "925000",
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toBe(0);
  });

  it("preserves awarded value precedence for won-stage deal value", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "won",
        awardedAmount: "925000",
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toBe(925000);
  });

  it("uses current stage before a won-like Bid Board stage when choosing generic deal value", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "opportunity",
        bidBoardStageSlug: "sent_to_production",
        bidEstimate: "16137.14",
        awardedAmount: "2.97",
        ddEstimate: "3.00",
      })
    ).toBe(16137.14);
  });

  it("does not use a won-like Bid Board stage to force awarded value when current stage is unknown", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        bidBoardStageSlug: "sent_to_production",
        bidEstimate: "16137.14",
        awardedAmount: "2.97",
        ddEstimate: "3.00",
      })
    ).toBe(16137.14);
  });

  it("subtracts accumulated and currently open hold time from stage age", () => {
    expect(
      getEffectiveStageAgeSeconds(
        {
          stageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: true,
          onHoldStartedAt: "2026-05-09T00:00:00.000Z",
          onHoldAccumulatedSeconds: 2 * 24 * 60 * 60,
          onHoldAccumulatedSecondsAtStageEntry: 24 * 60 * 60,
        },
        new Date("2026-05-11T00:00:00.000Z")
      )
    ).toBe(7 * 24 * 60 * 60);
  });

  it("does not subtract hold time from a prior stage after the deal moves forward", () => {
    expect(
      getEffectiveStageAgeSeconds(
        {
          stageEnteredAt: "2026-05-10T00:00:00.000Z",
          onHold: false,
          onHoldStartedAt: null,
          onHoldAccumulatedSeconds: 2 * 24 * 60 * 60,
          onHoldAccumulatedSecondsAtStageEntry: 2 * 24 * 60 * 60,
        },
        new Date("2026-05-12T00:00:00.000Z")
      )
    ).toBe(2 * 24 * 60 * 60);
  });

  it("keeps effective stage age correct across multiple hold cycles within the same stage", () => {
    const accumulatedSeconds = 2 * 24 * 60 * 60 + 12 * 60 * 60;

    expect(
      getEffectiveStageAgeSeconds(
        {
          stageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: false,
          onHoldStartedAt: null,
          onHoldAccumulatedSeconds: accumulatedSeconds,
          onHoldAccumulatedSecondsAtStageEntry: 24 * 60 * 60,
        },
        new Date("2026-05-10T00:00:00.000Z")
      )
    ).toBe(7 * 24 * 60 * 60 + 12 * 60 * 60);
  });

  it("derives whole stage-age days from the effective paused age", () => {
    expect(
      getEffectiveStageAgeDays(
        {
          stageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: true,
          onHoldStartedAt: "2026-05-08T12:00:00.000Z",
          onHoldAccumulatedSeconds: 24 * 60 * 60,
          onHoldAccumulatedSecondsAtStageEntry: 12 * 60 * 60,
        },
        new Date("2026-05-10T12:00:00.000Z")
      )
    ).toBe(7);
  });

  it("uses the Bid Board stage-entered timestamp for Bid Board-owned effective age", () => {
    expect(
      getEffectiveStageAgeDays(
        getEffectiveStageAgeDeal({
          isBidBoardOwned: true,
          stageEnteredAt: "2026-05-10T00:00:00.000Z",
          bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: false,
          onHoldStartedAt: null,
          onHoldAccumulatedSeconds: 0,
          onHoldAccumulatedSecondsAtStageEntry: 0,
        }),
        new Date("2026-05-10T00:00:00.000Z")
      )
    ).toBe(9);
  });

  it("keeps non-Bid-Board-owned effective age on the CRM stage-entered timestamp", () => {
    expect(
      resolveEffectiveStageEnteredAt({
        isBidBoardOwned: false,
        stageEnteredAt: "2026-05-10T00:00:00.000Z",
        bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
      })
    ).toBe("2026-05-10T00:00:00.000Z");
  });

  it("keeps rows with omitted Bid Board ownership on the CRM stage-entered timestamp", () => {
    expect(
      resolveEffectiveStageEnteredAt({
        stageEnteredAt: "2026-05-10T00:00:00.000Z",
        bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
      })
    ).toBe("2026-05-10T00:00:00.000Z");
  });

  it("falls back to the CRM stage-entered timestamp for Bid Board-owned rows without a Bid Board timestamp", () => {
    expect(
      resolveEffectiveStageEnteredAt({
        isBidBoardOwned: true,
        stageEnteredAt: "2026-05-10T00:00:00.000Z",
        bidBoardStageEnteredAt: null,
      })
    ).toBe("2026-05-10T00:00:00.000Z");
  });

  it("keeps Bid Board-owned effective age hold-aware from the Bid Board stage-entered timestamp", () => {
    expect(
      getEffectiveStageAgeDays(
        getEffectiveStageAgeDeal({
          isBidBoardOwned: true,
          stageEnteredAt: "2026-05-10T00:00:00.000Z",
          bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: true,
          onHoldStartedAt: "2026-05-06T00:00:00.000Z",
          onHoldAccumulatedSeconds: 0,
          onHoldAccumulatedSecondsAtStageEntry: 0,
        }),
        new Date("2026-05-10T00:00:00.000Z")
      )
    ).toBe(5);
  });

  it("clamps effective stage age at zero when hold time would exceed raw elapsed time", () => {
    expect(
      getEffectiveStageAgeSeconds(
        {
          stageEnteredAt: "2026-05-10T12:00:00.000Z",
          onHold: false,
          onHoldStartedAt: null,
          onHoldAccumulatedSeconds: 4 * 60 * 60,
          onHoldAccumulatedSecondsAtStageEntry: 0,
        },
        new Date("2026-05-10T14:00:00.000Z")
      )
    ).toBe(0);
  });

  it("snapshots the lifetime accumulator unchanged when entering a stage while active", () => {
    expect(
      getHoldStateAtStageEntry(
        {
          onHold: false,
          onHoldStartedAt: null,
          onHoldAccumulatedSeconds: 7200,
        },
        new Date("2026-05-02T09:00:00.000Z")
      )
    ).toEqual({
      onHoldStartedAt: null,
      onHoldAccumulatedSeconds: 7200,
      onHoldAccumulatedSecondsAtStageEntry: 7200,
    });
  });

  it("splits an active hold when entering a new stage", () => {
    expect(
      getHoldStateAtStageEntry(
        {
          onHold: true,
          onHoldStartedAt: "2026-05-01T20:00:00.000Z",
          onHoldAccumulatedSeconds: 3600,
        },
        new Date("2026-05-02T09:00:00.000Z")
      )
    ).toEqual({
      onHoldStartedAt: new Date("2026-05-02T09:00:00.000Z"),
      onHoldAccumulatedSeconds: 3600 + 13 * 60 * 60,
      onHoldAccumulatedSecondsAtStageEntry: 3600 + 13 * 60 * 60,
    });
  });

  it("does not backdate an open hold when the stage entry timestamp predates the real hold start", () => {
    expect(
      getHoldStateAtStageEntry(
        {
          onHold: true,
          onHoldStartedAt: "2026-05-02T12:00:00.000Z",
          onHoldAccumulatedSeconds: 5400,
        },
        new Date("2026-05-02T09:00:00.000Z")
      )
    ).toEqual({
      onHoldStartedAt: new Date("2026-05-02T12:00:00.000Z"),
      onHoldAccumulatedSeconds: 5400,
      onHoldAccumulatedSecondsAtStageEntry: 5400,
    });
  });
});
