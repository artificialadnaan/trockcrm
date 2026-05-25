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
