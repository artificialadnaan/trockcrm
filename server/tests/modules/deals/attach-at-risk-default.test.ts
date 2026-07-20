import { describe, expect, it } from "vitest";
import { attachAtRiskResult } from "../../../src/modules/deals/service.js";

/**
 * The deals LIST (getDeals) and the kanban/pipeline BOARD (getDealsForPipeline) both attach at-risk via
 * attachAtRiskResult WITHOUT passing options, so they inherit its default applyCloseTargetSuppression.
 *
 * A rep who uses "Move Close Date" to postpone a deal to a near (today-or-future) target expects the SLA
 * nag to go quiet everywhere — the deal-detail view already reads "Postponed" (close_target_pending). This
 * pins that the list/board default now honors the SAME near-term postponement, so a postponed deal is no
 * longer flagged at-risk on the surfaces a user actually browses. The explicit opt-out (false) still exists
 * for any caller that deliberately wants the aggressive, near-term-included verdict.
 */

const dayMs = 24 * 60 * 60 * 1000;

// An OPEN (opportunity) deal 40 days in stage — well over the rep 7-day SLA — so at-risk fires unless a
// close target suppresses it. Dates are relative to real "now" because attachAtRiskResult uses new Date().
function overSlaDeal(overrides: Record<string, unknown> = {}) {
  return {
    stageId: "opportunity",
    stageSlug: "opportunity",
    workflowRoute: "normal" as const,
    stageEnteredAt: new Date(Date.now() - 40 * dayMs).toISOString(),
    onHold: false,
    onHoldStartedAt: null,
    onHoldAccumulatedSeconds: 0,
    onHoldAccumulatedSecondsAtStageEntry: 0,
    expectedCloseDate: null as string | null,
    ...overrides,
  };
}

// The close target of the deal under investigation: 11 days out — a near-term postponement, NOT the 90+ day
// auto-hold horizon.
const nearFutureTarget = new Date(Date.now() + 11 * dayMs).toISOString().slice(0, 10);

describe("attachAtRiskResult — list/board default honors a near-term postponement", () => {
  it("DEFAULT (no options): a near-future close target suppresses at-risk (close_target_pending)", () => {
    const { atRisk } = attachAtRiskResult(
      overSlaDeal({ expectedCloseDate: nearFutureTarget }),
      "rep"
    );
    expect(atRisk.isAtRisk).toBe(false);
    expect(atRisk.reason).toBe("close_target_pending");
  });

  it("DEFAULT (no options): an over-SLA deal with NO close target is still at risk", () => {
    const { atRisk } = attachAtRiskResult(overSlaDeal(), "rep");
    expect(atRisk.isAtRisk).toBe(true);
    expect(atRisk.reason).toBe("threshold_reached");
  });

  it("explicit opt-out ({applyCloseTargetSuppression:false}) still flags the near-postponed deal", () => {
    const { atRisk } = attachAtRiskResult(
      overSlaDeal({ expectedCloseDate: nearFutureTarget }),
      "rep",
      undefined,
      { applyCloseTargetSuppression: false }
    );
    expect(atRisk.isAtRisk).toBe(true);
    expect(atRisk.reason).toBe("threshold_reached");
  });
});
