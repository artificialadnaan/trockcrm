import { describe, expect, it } from "vitest";
import {
  getEffectiveAwardedDealValue,
  getEffectiveDealValue,
  getEffectiveStageAgeDeal,
  getEffectiveStageAgeDays,
  getEffectiveStageAgeSeconds,
  getHoldStateAtStageEntry,
  isDealValueEffectivelyOnHold,
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

  // Effective-hold value-zeroing: a far-out close target (90+ CT-days) auto-parks the deal to $0 even
  // without the stored on_hold flag — the value twin of effectiveOnHoldSqlPredicate. `now` fixed so the
  // horizon is deterministic.
  const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

  it("zeros effective value for a far-out close target (90+ days) with no stored hold flag", () => {
    expect(
      getEffectiveDealValue(
        { onHold: false, expectedCloseDate: "2026-12-01", bidEstimate: "875000" },
        FIXED_NOW
      )
    ).toBe(0);
    expect(
      getEffectiveAwardedDealValue(
        { onHold: false, expectedCloseDate: "2026-12-01", awardedAmount: "925000" },
        FIXED_NOW
      )
    ).toBe(0);
  });

  it("keeps full effective value for a near-term close target (inside the 90-day horizon)", () => {
    expect(
      getEffectiveDealValue(
        { onHold: false, expectedCloseDate: "2026-06-15", bidEstimate: "875000" },
        FIXED_NOW
      )
    ).toBe(875000);
  });

  it("never auto-parks a deal that has no close target (the far-out leg can't fire)", () => {
    expect(getEffectiveDealValue({ onHold: false, bidEstimate: "875000" })).toBe(875000);
  });

  it("does NOT auto-park a WON deal with a far-out target (realized revenue stays whole — guards the P1)", () => {
    // a deal won early can keep a stale far-future expected_close_date; its value must NOT be zeroed
    expect(
      getEffectiveDealValue(
        { onHold: false, expectedCloseDate: "2099-12-31", stageSlug: "won", workflowRoute: "normal", awardedAmount: "925000" },
        FIXED_NOW
      )
    ).toBe(925000);
    // but an explicit stored hold on a won deal still zeros it
    expect(
      getEffectiveDealValue(
        { onHold: true, expectedCloseDate: "2099-12-31", stageSlug: "won", workflowRoute: "normal", awardedAmount: "925000" },
        FIXED_NOW
      )
    ).toBe(0);
  });

  it("does NOT auto-park a Bid Board-won deal (won via bidBoardStageSlug while CRM stage is still open)", () => {
    // a mirrored deal can reach a won terminal alias in bidBoardStageSlug before its CRM stage advances;
    // its realized value must NOT be zeroed off a stale forecast date (guards the bid-board won gap)
    expect(
      getEffectiveDealValue(
        { onHold: false, expectedCloseDate: "2099-12-31", stageSlug: "opportunity", bidBoardStageSlug: "sent_to_production", workflowRoute: "normal", awardedAmount: "500000" },
        FIXED_NOW
      )
    ).toBe(500000);
  });

  it("does NOT auto-park a LOST deal with a stale far-out target (preserved bid value for Loss Analysis)", () => {
    // a lost deal is a historical bid; its preserved value must NOT be zeroed off a stale forecast date
    expect(
      getEffectiveDealValue(
        { onHold: false, expectedCloseDate: "2099-12-31", stageSlug: "lost", workflowRoute: "normal", bidEstimate: "440000" },
        FIXED_NOW
      )
    ).toBe(440000);
  });

  it("prefers awarded amount over synced Bid Board/bid for generic deal value (unified awarded-first 2026-06-18)", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        bidBoardTotalSales: "16137.14",
        bidEstimate: "16137.14",
        awardedAmount: "2.97",
        ddEstimate: "3.00",
      })
    ).toBe(2.97);

    expect(
      getEffectiveDealValue({
        onHold: false,
        bidEstimate: "16137.14",
        awardedAmount: "2.97",
        ddEstimate: "3.00",
      })
    ).toBe(2.97);
  });

  it("skips zero and negative values (incl. awarded) before falling through", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        awardedAmount: "0",
        bidBoardTotalSales: "-100",
        bidEstimate: "0",
        ddEstimate: "42000",
      })
    ).toBe(42000);
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

  it("falls back to positive current values for won-stage deal value when awarded is missing or zero", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "service_complete",
        awardedAmount: "0",
        bidBoardTotalSales: "-10",
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toBe(875000);
  });

  it("uses awarded-first precedence for ALL stages, incl. pre-close won-mapped (unified 2026-06-18)", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "in_production",
        workflowRoute: "normal",
        awardedAmount: "925000",
        bidBoardTotalSales: "950000",
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toBe(925000);
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "close_out",
        workflowRoute: "normal",
        awardedAmount: "925000",
        bidBoardTotalSales: "0",
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toBe(925000);
  });

  it("values generic deals awarded-first regardless of stage classification (unified 2026-06-18)", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "opportunity",
        bidBoardStageSlug: "sent_to_production",
        bidEstimate: "16137.14",
        awardedAmount: "2.97",
        ddEstimate: "3.00",
      })
    ).toBe(2.97);
  });

  it("values awarded-first even when the current stage is unknown (unified 2026-06-18)", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        bidBoardStageSlug: "sent_to_production",
        bidEstimate: "16137.14",
        awardedAmount: "2.97",
        ddEstimate: "3.00",
      })
    ).toBe(2.97);
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

describe("estimating-stage value rule — DD outranks bid (2026-06-18)", () => {
  it("estimating + bid + DD (no awarded) → DD wins, NOT bid", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "estimating",
        awardedAmount: null,
        bidBoardTotalSales: "900000",
        bidEstimate: "880000",
        ddEstimate: "800000",
      })
    ).toBe(800000);
  });

  it("estimating + awarded set → awarded still wins over DD and bid", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "estimating",
        awardedAmount: "950000",
        bidBoardTotalSales: "900000",
        bidEstimate: "880000",
        ddEstimate: "800000",
      })
    ).toBe(950000);
  });

  it("estimating + DD only → DD", () => {
    expect(
      getEffectiveDealValue({ onHold: false, stageSlug: "estimating", ddEstimate: "800000" })
    ).toBe(800000);
  });

  it("estimating + bid only (no DD) → bid, NOT $0 (bid is the fallback, just outranked when DD exists)", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "estimating",
        awardedAmount: null,
        bidBoardTotalSales: "900000",
        bidEstimate: "880000",
        ddEstimate: null,
      })
    ).toBe(900000);
    // bid_estimate also still ranks above an absent DD.
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "estimating",
        bidBoardTotalSales: null,
        bidEstimate: "880000",
        ddEstimate: null,
      })
    ).toBe(880000);
  });

  it("non-estimating (opportunity) is UNCHANGED: bid outranks DD (awarded > bid > dd)", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "opportunity",
        awardedAmount: null,
        bidBoardTotalSales: "900000",
        bidEstimate: "880000",
        ddEstimate: "800000",
      })
    ).toBe(900000);
  });

  it("service_estimating is EXCLUDED from the rule — bid still outranks DD", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "service_estimating",
        awardedAmount: null,
        bidBoardTotalSales: "900000",
        bidEstimate: "880000",
        ddEstimate: "800000",
      })
    ).toBe(900000);
  });

  // Canonicalization (Codex P2): the rule keys on the CANONICAL stage via workflowRoute, not raw equality.
  it("service route + BARE 'estimating' slug → bid > DD (canonicalizes to service_estimating, excluded)", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "estimating",
        workflowRoute: "service",
        awardedAmount: null,
        bidBoardTotalSales: "900000",
        bidEstimate: "880000",
        ddEstimate: "800000",
      })
    ).toBe(900000);
  });

  it("legacy 'estimate_in_progress' (normal route) → DD > bid (canonicalizes to estimating)", () => {
    expect(
      getEffectiveDealValue({
        onHold: false,
        stageSlug: "estimate_in_progress",
        workflowRoute: "normal",
        awardedAmount: null,
        bidBoardTotalSales: "900000",
        bidEstimate: "880000",
        ddEstimate: "800000",
      })
    ).toBe(800000);
  });

  it("estimating + on-hold → 0 regardless of DD", () => {
    expect(
      getEffectiveDealValue({ onHold: true, stageSlug: "estimating", ddEstimate: "800000" })
    ).toBe(0);
  });
});

describe("estimating-stage hold rule — the BID due date is the auto-park horizon (2026-07-27)", () => {
  // Same fixed instant the effective-hold cases above use, so the 90-day horizon is deterministic.
  // CT-today = 2026-06-01, so the horizon lands on 2026-08-30.
  const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

  it("zeros an estimating deal whose BID is far out even though its close target is near", () => {
    const deal = {
      onHold: false,
      stageSlug: "estimating",
      expectedCloseDate: "2026-06-15",
      // Stored at UTC midnight, exactly as deals.bid_due_date arrives on the wire.
      bidDueDate: "2027-01-01T00:00:00.000Z",
      bidEstimate: "875000",
      ddEstimate: "800000",
    };
    expect(isDealValueEffectivelyOnHold(deal, FIXED_NOW)).toBe(true);
    expect(getEffectiveDealValue(deal, FIXED_NOW)).toBe(0);
    // The SAME row in any other stage keeps today's close-target rule and its full (bid-first) value.
    const nonEstimating = { ...deal, stageSlug: "estimate_sent_to_client" };
    expect(isDealValueEffectivelyOnHold(nonEstimating, FIXED_NOW)).toBe(false);
    expect(getEffectiveDealValue(nonEstimating, FIXED_NOW)).toBe(875000);
  });

  it("RELEASES an estimating deal whose BID is near even though its close target is far out", () => {
    const deal = {
      onHold: false,
      stageSlug: "estimating",
      expectedCloseDate: "2026-12-01",
      bidDueDate: "2026-06-15T00:00:00.000Z",
      bidEstimate: "875000",
      ddEstimate: "800000",
    };
    expect(isDealValueEffectivelyOnHold(deal, FIXED_NOW)).toBe(false);
    // DD-over-bid still applies in this stage — the hold rule and the value chain are independent.
    expect(getEffectiveDealValue(deal, FIXED_NOW)).toBe(800000);
    // Outside estimating the far-out close target still parks it.
    expect(isDealValueEffectivelyOnHold({ ...deal, stageSlug: "contract" }, FIXED_NOW)).toBe(true);
  });

  it("falls back to the close target when an estimating deal has no bid due date", () => {
    expect(
      isDealValueEffectivelyOnHold(
        { onHold: false, stageSlug: "estimating", expectedCloseDate: "2026-12-01", bidDueDate: null },
        FIXED_NOW
      )
    ).toBe(true);
    expect(
      isDealValueEffectivelyOnHold(
        { onHold: false, stageSlug: "estimating", expectedCloseDate: "2026-06-15", bidDueDate: null },
        FIXED_NOW
      )
    ).toBe(false);
  });

  it("EXCLUDES service_estimating — a service-route deal keeps the close-target rule", () => {
    // A service-route record carrying the bare "estimating" slug canonicalizes to service_estimating,
    // which is deliberately out of scope for this rule (same boundary as the DD-over-bid chain).
    const serviceDeal = {
      onHold: false,
      stageSlug: "estimating",
      workflowRoute: "service",
      expectedCloseDate: "2026-06-15",
      bidDueDate: "2027-01-01T00:00:00.000Z",
      bidEstimate: "875000",
    };
    expect(isDealValueEffectivelyOnHold(serviceDeal, FIXED_NOW)).toBe(false);
    expect(
      isDealValueEffectivelyOnHold({ ...serviceDeal, stageSlug: "service_estimating" }, FIXED_NOW)
    ).toBe(false);
    // ...while the legacy normal-route alias IS in scope.
    expect(
      isDealValueEffectivelyOnHold(
        { ...serviceDeal, stageSlug: "estimate_in_progress", workflowRoute: "normal" },
        FIXED_NOW
      )
    ).toBe(true);
  });

  it("a Bid Board-terminal estimating deal keeps its realized value despite a far-out bid due date", () => {
    // 15 of 16 active Dallas estimating deals are Bid Board-owned; one can go won/lost in the mirror while
    // its CRM stage still reads estimating. Realized value must never be auto-parked.
    const deal = {
      onHold: false,
      stageSlug: "estimating",
      bidBoardStageSlug: "sent_to_production",
      expectedCloseDate: "2026-06-15",
      bidDueDate: "2027-01-01T00:00:00.000Z",
      awardedAmount: "925000",
    };
    expect(isDealValueEffectivelyOnHold(deal, FIXED_NOW)).toBe(false);
    expect(getEffectiveDealValue(deal, FIXED_NOW)).toBe(925000);
  });
});
