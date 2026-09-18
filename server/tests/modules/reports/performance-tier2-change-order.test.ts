import { describe, expect, it } from "vitest";
import {
  buildDirectorScorecardFromRows,
  buildForecastAccuracyFromRows,
} from "../../../src/modules/reports/performance-tier2-service.js";

/**
 * The at-risk deal lists on the Director Scorecard and Forecast Accuracy reports must carry
 * `deals.is_change_order` out to the client.
 *
 * Both feed a shared `DealLink`, and that component used to accept `children: ReactNode` and rewrite any
 * string child through formatDealDisplayName — applying the relabel invisibly with nowhere to pass the
 * flag. `DealLink` now REQUIRES the flag, so these two payloads are what makes the answer available;
 * without them the required prop can only be satisfied with `undefined`, which is the syntax fallback
 * wearing a different hat.
 *
 * THE case both tests turn on is the flag-FALSE row whose NAME is change-order-shaped. A test that only
 * checks the `true` row passes by syntax coincidence — the fallback happens to agree there — and would
 * have gone on passing throughout the bug.
 */
const PLAIN = { deal_id: "deal-plain", deal_name: "Lobby — Change Order 1", deal_is_change_order: false };
const CHILD = { deal_id: "deal-co", deal_name: "Tides Park Lane — Change Order 2", deal_is_change_order: true };

describe("director scorecard at-risk deals carry deals.is_change_order", () => {
  it("reports false for an ordinary deal whose name merely looks like a change order", () => {
    const report = buildDirectorScorecardFromRows({
      kpiRows: [],
      riskRows: [],
      repRows: [],
      officeRows: [],
      atRiskRows: [
        { ...PLAIN, owner_name: "Avery", stage_name: "Estimating", days_in_stage: 40, value: 1000, last_activity_date: null },
        { ...CHILD, owner_name: "Avery", stage_name: "Estimating", days_in_stage: 12, value: 2000, last_activity_date: null },
      ],
    });

    const plain = report.topAtRiskDeals.find((d) => d.dealId === "deal-plain");
    const child = report.topAtRiskDeals.find((d) => d.dealId === "deal-co");
    expect(plain?.dealName).toBe("Lobby — Change Order 1");
    expect(plain?.dealIsChangeOrder).toBe(false);
    expect(child?.dealIsChangeOrder).toBe(true);
  });

  it("leaves an absent flag undefined rather than asserting false", () => {
    // A row from an older deployment that does not project the column must degrade to the name
    // fallback, not claim "not a change order" — `false` is authoritative and would suppress the
    // relabel on a real change-order child.
    const report = buildDirectorScorecardFromRows({
      kpiRows: [],
      riskRows: [],
      repRows: [],
      officeRows: [],
      atRiskRows: [
        { deal_id: "deal-x", deal_name: "Tides", owner_name: null, stage_name: null, days_in_stage: 1, value: 1, last_activity_date: null },
      ],
    });
    expect(report.topAtRiskDeals[0]?.dealIsChangeOrder).toBeUndefined();
  });
});

describe("forecast accuracy pipeline-at-risk deals carry deals.is_change_order", () => {
  it("reports false for an ordinary deal whose name merely looks like a change order", () => {
    const report = buildForecastAccuracyFromRows({
      summaryRows: [],
      monthlyRows: [],
      atRiskRows: [
        { ...PLAIN, owner_name: "Avery", stage_name: "Estimating", value: 1000, expected_close_date: null },
        { ...CHILD, owner_name: "Avery", stage_name: "Estimating", value: 2000, expected_close_date: null },
      ],
    });

    const plain = report.pipelineAtRisk.find((d) => d.dealId === "deal-plain");
    const child = report.pipelineAtRisk.find((d) => d.dealId === "deal-co");
    expect(plain?.dealName).toBe("Lobby — Change Order 1");
    expect(plain?.dealIsChangeOrder).toBe(false);
    expect(child?.dealIsChangeOrder).toBe(true);
  });
});
