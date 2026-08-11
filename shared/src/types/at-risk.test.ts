import { describe, expect, it } from "vitest";
import {
  getAtRiskResult,
  getDealAtRiskResult,
  type AtRiskResult,
} from "./at-risk.js";

const DAY_SECONDS = 24 * 60 * 60;

function expectNotAtRisk(result: AtRiskResult): void {
  expect(result.isAtRisk).toBe(false);
  expect(result.status).not.toBe("at_risk");
}

describe("at-risk computation", () => {
  it("is role-relative for the same deal and effective stage age", () => {
    const repResult = getAtRiskResult({
      stageSlug: "opportunity",
      viewerRole: "rep",
      effectiveStageAgeSeconds: 10 * DAY_SECONDS,
    });
    const directorResult = getAtRiskResult({
      stageSlug: "opportunity",
      viewerRole: "director",
      effectiveStageAgeSeconds: 10 * DAY_SECONDS,
    });

    expect(repResult).toMatchObject({
      isAtRisk: true,
      status: "at_risk",
      audience: "rep",
      thresholdDays: 7,
      effectiveStageAgeDays: 10,
      secondsPastThreshold: 3 * DAY_SECONDS,
    });
    expect(directorResult).toMatchObject({
      isAtRisk: false,
      status: "not_at_risk",
      audience: "leadership",
      thresholdDays: 30,
      effectiveStageAgeDays: 10,
      secondsUntilThreshold: 20 * DAY_SECONDS,
    });
  });

  it("moves from not at risk to at risk at the policy threshold", () => {
    expectNotAtRisk(
      getAtRiskResult({
        stageSlug: "estimate_under_review",
        viewerRole: "rep",
        effectiveStageAgeSeconds: 3 * DAY_SECONDS - 1,
      })
    );

    expect(
      getAtRiskResult({
        stageSlug: "estimate_under_review",
        viewerRole: "rep",
        effectiveStageAgeSeconds: 3 * DAY_SECONDS,
      })
    ).toMatchObject({
      isAtRisk: true,
      status: "at_risk",
      thresholdDays: 3,
      secondsPastThreshold: 0,
    });
  });

  it("uses the existing hold-aware effective stage age helper for deal inputs", () => {
    const result = getDealAtRiskResult(
      {
        stageSlug: "opportunity",
        stageEnteredAt: "2026-05-01T00:00:00.000Z",
        onHold: true,
        onHoldStartedAt: "2026-05-07T00:00:00.000Z",
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      "rep",
      new Date("2026-05-10T00:00:00.000Z")
    );

    expect(result).toMatchObject({
      isAtRisk: false,
      status: "not_at_risk",
      effectiveStageAgeDays: 6,
      thresholdDays: 7,
      secondsUntilThreshold: DAY_SECONDS,
    });
  });

  it("clears at risk while a deal is actively on hold even when age exceeds the threshold", () => {
    const result = getDealAtRiskResult(
      {
        stageSlug: "opportunity",
        stageEnteredAt: "2026-05-01T00:00:00.000Z",
        onHold: true,
        onHoldStartedAt: "2026-05-20T00:00:00.000Z",
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      "rep",
      new Date("2026-05-22T00:00:00.000Z")
    );

    expect(result).toMatchObject({
      isAtRisk: false,
      status: "not_at_risk",
      severity: "none",
      reason: "on_hold",
      effectiveStageAgeDays: 19,
      thresholdDays: 7,
      secondsUntilThreshold: 0,
      secondsPastThreshold: 12 * DAY_SECONDS,
    });
  });

  it("evaluates a formerly held deal normally after hold is released", () => {
    const result = getDealAtRiskResult(
      {
        stageSlug: "opportunity",
        stageEnteredAt: "2026-05-01T00:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 2 * DAY_SECONDS,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      "rep",
      new Date("2026-05-12T00:00:00.000Z")
    );

    expect(result).toMatchObject({
      isAtRisk: true,
      status: "at_risk",
      reason: "threshold_reached",
      effectiveStageAgeDays: 9,
      thresholdDays: 7,
      secondsPastThreshold: 2 * DAY_SECONDS,
    });
  });

  it("still marks a non-held deal over threshold as at risk", () => {
    expect(
      getDealAtRiskResult(
        {
          stageSlug: "opportunity",
          stageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: false,
          onHoldStartedAt: null,
          onHoldAccumulatedSeconds: 0,
          onHoldAccumulatedSecondsAtStageEntry: 0,
        },
        "rep",
        new Date("2026-05-10T00:00:00.000Z")
      )
    ).toMatchObject({
      isAtRisk: true,
      status: "at_risk",
      reason: "threshold_reached",
      effectiveStageAgeDays: 9,
      thresholdDays: 7,
    });
  });

  it("exempts terminal stages even when their age exceeds active-stage thresholds", () => {
    for (const stageSlug of ["won", "lost", "closed_won", "production_lost"] as const) {
      const result = getAtRiskResult({
        stageSlug,
        workflowRoute: "normal",
        viewerRole: "rep",
        effectiveStageAgeSeconds: 90 * DAY_SECONDS,
      });

      expect(result).toMatchObject({
        isAtRisk: false,
        status: "not_applicable",
        reason: "terminal_stage",
        canonicalStageSlug: stageSlug === "lost" || stageSlug === "production_lost" ? "lost" : "won",
      });
    }
  });

  it("keeps terminal stages not applicable even when the terminal deal is on hold", () => {
    const result = getDealAtRiskResult(
      {
        stageSlug: "won",
        workflowRoute: "normal",
        stageEnteredAt: "2026-05-01T00:00:00.000Z",
        onHold: true,
        onHoldStartedAt: "2026-05-20T00:00:00.000Z",
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      "rep",
      new Date("2026-05-22T00:00:00.000Z")
    );

    expect(result).toMatchObject({
      isAtRisk: false,
      status: "not_applicable",
      reason: "terminal_stage",
      canonicalStageSlug: "won",
    });
  });

  it("handles zero age, unknown stages, and unsupported viewer roles without risk", () => {
    expect(
      getAtRiskResult({
        stageSlug: "contract",
        viewerRole: "admin",
        effectiveStageAgeSeconds: 0,
      })
    ).toMatchObject({
      isAtRisk: false,
      status: "not_at_risk",
      secondsUntilThreshold: 7 * DAY_SECONDS,
    });

    expect(
      getAtRiskResult({
        stageSlug: "mystery",
        viewerRole: "rep",
        effectiveStageAgeSeconds: 20 * DAY_SECONDS,
      })
    ).toMatchObject({
      isAtRisk: false,
      status: "not_applicable",
      reason: "unknown_stage",
      policy: null,
    });

    expect(
      getAtRiskResult({
        stageSlug: "opportunity",
        viewerRole: "construction",
        effectiveStageAgeSeconds: 20 * DAY_SECONDS,
      })
    ).toMatchObject({
      isAtRisk: false,
      status: "not_applicable",
      reason: "unsupported_role",
      policy: null,
    });
  });

  it("clamps negative effective age to zero for defensive callers", () => {
    expect(
      getAtRiskResult({
        stageSlug: "contract",
        viewerRole: "rep",
        effectiveStageAgeSeconds: -30,
      })
    ).toMatchObject({
      isAtRisk: false,
      effectiveStageAgeSeconds: 0,
      effectiveStageAgeDays: 0,
      secondsUntilThreshold: 7 * DAY_SECONDS,
    });
  });

  it("uses a seven-day SLA threshold for the Contract deal stage", () => {
    expect(
      getAtRiskResult({
        stageSlug: "contract",
        viewerRole: "rep",
        effectiveStageAgeSeconds: 2 * DAY_SECONDS,
      })
    ).toMatchObject({
      isAtRisk: false,
      status: "not_at_risk",
      reason: "within_sla",
      canonicalStageSlug: "contract",
      thresholdDays: 7,
      secondsUntilThreshold: 5 * DAY_SECONDS,
    });

    expect(
      getAtRiskResult({
        stageSlug: "contract",
        viewerRole: "rep",
        effectiveStageAgeSeconds: 7 * DAY_SECONDS,
      })
    ).toMatchObject({
      isAtRisk: true,
      status: "at_risk",
      reason: "threshold_reached",
      canonicalStageSlug: "contract",
      thresholdDays: 7,
      secondsPastThreshold: 0,
    });
  });
});

describe("close-target at-risk suppression", () => {
  // 2026-06-01 07:00 CDT. The deal has been in Opportunity (rep SLA 7d) for 31 days — over threshold.
  const NOW = new Date("2026-06-01T12:00:00.000Z");
  const overThresholdDeal = {
    stageSlug: "opportunity" as const,
    workflowRoute: "normal" as const,
    stageEnteredAt: "2026-05-01T12:00:00.000Z",
  };

  it("suppresses at-risk while a future close target is pending", () => {
    const result = getDealAtRiskResult(
      { ...overThresholdDeal, expectedCloseDate: "2026-06-20" },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(false);
    expect(result.status).toBe("not_at_risk");
    expect(result.reason).toBe("close_target_pending");
    // the underlying stage-age is still reported for the badge/tooltip
    expect(result.effectiveStageAgeDays).toBe(31);
    expect(result.thresholdDays).toBe(7);
  });

  it("can apply only the 90-day auto-hold exclusion without pending-target suppression", () => {
    const result = getDealAtRiskResult(
      { ...overThresholdDeal, expectedCloseDate: "2026-06-20", applyCloseTargetSuppression: false },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(true);
    expect(result.reason).toBe("threshold_reached");
  });

  it("becomes at risk again once the close target has passed", () => {
    const result = getDealAtRiskResult(
      { ...overThresholdDeal, expectedCloseDate: "2026-05-20" },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(true);
    expect(result.reason).toBe("threshold_reached");
  });

  it("treats a far-future close target as effectively on hold", () => {
    const result = getDealAtRiskResult(
      { ...overThresholdDeal, expectedCloseDate: "2026-11-01" },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(false);
    expect(result.reason).toBe("on_hold");
  });

  it("lets a stored on_hold flag take precedence over the close-target suppression", () => {
    const result = getDealAtRiskResult(
      { ...overThresholdDeal, onHold: true, expectedCloseDate: "2026-06-20" },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(false);
    expect(result.reason).toBe("on_hold");
  });

  it("applies normal stage-age at-risk when there is no close target", () => {
    const result = getDealAtRiskResult(
      { ...overThresholdDeal, expectedCloseDate: null },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(true);
    expect(result.reason).toBe("threshold_reached");
  });
});

describe("estimating-stage at-risk uses the BID due date as the hold horizon (2026-07-27)", () => {
  // CT-today = 2026-06-01, so the 90-day horizon lands on 2026-08-30.
  const NOW = new Date("2026-06-01T12:00:00.000Z");
  // Well past the estimating SLA threshold, so the row would nag if it were not effectively held.
  const staleEstimatingDeal = {
    stageSlug: "estimating" as const,
    workflowRoute: "normal" as const,
    stageEnteredAt: "2026-01-01T12:00:00.000Z",
    applyCloseTargetSuppression: false,
  };

  it("quiets a stale estimating deal whose bid is not due for another quarter", () => {
    const result = getDealAtRiskResult(
      { ...staleEstimatingDeal, expectedCloseDate: null, bidDueDate: "2027-01-01T00:00:00.000Z" },
      "rep",
      NOW
    );

    // Effectively held -> not at risk. The board prices this deal at $0; a "stale deal" alert on a deal
    // the app itself says is parked is the contradiction this rule has to avoid.
    expect(result.isAtRisk).toBe(false);
    expect(result.reason).toBe("on_hold");
  });

  it("still nags a stale estimating deal whose bid is due soon, even with a far-out close target", () => {
    const result = getDealAtRiskResult(
      {
        ...staleEstimatingDeal,
        expectedCloseDate: "2026-12-01",
        bidDueDate: "2026-06-15T00:00:00.000Z",
      },
      "rep",
      NOW
    );

    // Before this rule the far-out close target auto-held it and silenced the nag; a live bid must not be.
    expect(result.isAtRisk).toBe(true);
    expect(result.reason).toBe("threshold_reached");
  });

  it("ignores bidDueDate outside the estimating stage", () => {
    const result = getDealAtRiskResult(
      {
        stageSlug: "estimate_sent_to_client",
        workflowRoute: "normal" as const,
        stageEnteredAt: "2026-01-01T12:00:00.000Z",
        applyCloseTargetSuppression: false,
        expectedCloseDate: "2026-06-15",
        bidDueDate: "2027-01-01T00:00:00.000Z",
      },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(true);
    expect(result.reason).toBe("threshold_reached");
  });

  it("DOES drive the shorter SLA suppression from the bid due date in estimating", () => {
    // SUPERSEDES the #966 rule "the bid due date does NOT feed the shorter close-target SLA suppression"
    // (Adnaan, 2026-07-28). Keeping suppression on expected_close_date in estimating meant a comfortable
    // project close date silenced a bid that was already overdue; the two legs now read ONE horizon date.
    // Here the bid is not due for another 19 days, so the stage-age nag is quieted even though the deal
    // has no close target at all — the inverse of the case this test used to lock.
    const result = getDealAtRiskResult(
      {
        stageSlug: "estimating",
        workflowRoute: "normal" as const,
        stageEnteredAt: "2026-01-01T12:00:00.000Z",
        applyCloseTargetSuppression: true,
        expectedCloseDate: null,
        bidDueDate: "2026-06-20T00:00:00.000Z",
      },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(false);
    expect(result.reason).toBe("close_target_pending");
  });

  it("surfaces an overdue bid that a far-out close target used to hide (prod case)", () => {
    // Modelled on "Warehouse and Factory" (office_dallas, 2026-07-28): 46 days in the estimating stage,
    // bid due a month earlier, close date four months out. The close target was BOTH inside the 90-day
    // horizon (so no auto-park) AND in the future (so the SLA nag was suppressed) — the deal went silent
    // on every surface. Six prod deals sat in exactly this shape.
    const result = getDealAtRiskResult(
      {
        stageSlug: "estimating",
        workflowRoute: "normal" as const,
        stageEnteredAt: "2026-04-16T12:00:00.000Z",
        applyCloseTargetSuppression: true,
        expectedCloseDate: "2026-08-15",
        bidDueDate: "2026-05-01T00:00:00.000Z",
      },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(true);
    expect(result.reason).toBe("threshold_reached");
  });

  it("leaves every other stage on the close target when the bid is overdue", () => {
    // The stage gate is the whole scope of this rule: outside estimating an overdue bid must not
    // un-suppress a deal whose close target is still pending.
    const result = getDealAtRiskResult(
      {
        stageSlug: "estimate_sent_to_client",
        workflowRoute: "normal" as const,
        stageEnteredAt: "2026-04-16T12:00:00.000Z",
        applyCloseTargetSuppression: true,
        expectedCloseDate: "2026-08-15",
        bidDueDate: "2026-05-01T00:00:00.000Z",
      },
      "rep",
      NOW
    );

    expect(result.isAtRisk).toBe(false);
    expect(result.reason).toBe("close_target_pending");
  });
});
