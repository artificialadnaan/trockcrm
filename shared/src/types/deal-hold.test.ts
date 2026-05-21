import { describe, expect, it } from "vitest";
import {
  getEffectiveDealValue,
  getEffectiveStageAgeDays,
  getEffectiveStageAgeSeconds,
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

  it("subtracts accumulated and currently open hold time from stage age", () => {
    expect(
      getEffectiveStageAgeSeconds(
        {
          stageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: true,
          onHoldStartedAt: "2026-05-09T00:00:00.000Z",
          onHoldAccumulatedSeconds: 2 * 24 * 60 * 60,
        },
        new Date("2026-05-11T00:00:00.000Z")
      )
    ).toBe(6 * 24 * 60 * 60);
  });

  it("keeps effective stage age correct across multiple hold cycles", () => {
    const accumulatedSeconds = 2 * 24 * 60 * 60 + 12 * 60 * 60;

    expect(
      getEffectiveStageAgeSeconds(
        {
          stageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: false,
          onHoldStartedAt: null,
          onHoldAccumulatedSeconds: accumulatedSeconds,
        },
        new Date("2026-05-10T00:00:00.000Z")
      )
    ).toBe(6 * 24 * 60 * 60 + 12 * 60 * 60);
  });

  it("derives whole stage-age days from the effective paused age", () => {
    expect(
      getEffectiveStageAgeDays(
        {
          stageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: true,
          onHoldStartedAt: "2026-05-08T12:00:00.000Z",
          onHoldAccumulatedSeconds: 24 * 60 * 60,
        },
        new Date("2026-05-10T12:00:00.000Z")
      )
    ).toBe(6);
  });
});
