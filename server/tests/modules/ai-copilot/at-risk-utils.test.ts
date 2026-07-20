import { describe, expect, it } from "vitest";
import { getAiDealAtRiskResult } from "../../../src/modules/ai-copilot/at-risk-utils.js";

/**
 * The AI copilot at-risk surfaces (sales-process-disconnect dashboard, blind-spot signals, copilot context)
 * derive from getAiDealAtRiskResult. A postponed deal (near today-or-future close target) must read the same
 * "not at risk" verdict here as on the deal-detail / list / dashboard, so the copilot doesn't nag a rep about
 * a deal they explicitly moved.
 */

const dayMs = 24 * 60 * 60 * 1000;
const now = new Date("2026-05-08T00:00:00.000Z");

function overSlaRow(overrides: Record<string, unknown> = {}) {
  return {
    stage_slug: "estimating",
    workflow_route: "normal",
    stage_entered_at: new Date(now.getTime() - 40 * dayMs).toISOString(),
    expected_close_date: null as string | null,
    on_hold: false,
    on_hold_started_at: null,
    on_hold_accumulated_seconds: 0,
    on_hold_accumulated_seconds_at_stage_entry: 0,
    ...overrides,
  };
}

describe("getAiDealAtRiskResult — postponement suppresses copilot at-risk", () => {
  it("a near (11-day) close target suppresses at-risk (close_target_pending)", () => {
    const result = getAiDealAtRiskResult(
      overSlaRow({ expected_close_date: new Date(now.getTime() + 11 * dayMs).toISOString().slice(0, 10) }),
      "director",
      now
    );
    expect(result.isAtRisk).toBe(false);
    expect(result.reason).toBe("close_target_pending");
  });

  it("an over-SLA deal with no close target stays at risk", () => {
    const result = getAiDealAtRiskResult(overSlaRow(), "director", now);
    expect(result.isAtRisk).toBe(true);
    expect(result.reason).toBe("threshold_reached");
  });
});
