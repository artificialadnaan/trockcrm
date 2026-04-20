import { describe, expect, it } from "vitest";
import { buildPolicyDiffRows } from "./intervention-policy-recommendations";

describe("buildPolicyDiffRows", () => {
  it("returns only changed snooze policy fields with readable labels", () => {
    const rows = buildPolicyDiffRows({
      kind: "snooze_policy_adjustment",
      targetKey: "waiting_on_customer",
      policyLabel: "Waiting on customer",
      currentValue: {
        maxSnoozeDays: 7,
        breachReviewThresholdPercent: 20,
      },
      proposedValue: {
        maxSnoozeDays: 5,
        breachReviewThresholdPercent: 15,
      },
    });

    expect(rows).toEqual([
      {
        label: "Max snooze days",
        before: "7",
        after: "5",
      },
      {
        label: "Breach review threshold",
        before: "20%",
        after: "15%",
      },
    ]);
  });

  it("omits unchanged policy fields", () => {
    const rows = buildPolicyDiffRows({
      kind: "assignee_load_balancing",
      targetKey: "office-wide",
      policyLabel: "Assignee balancing",
      currentValue: {
        balancingMode: "weighted",
        overloadSharePercent: 35,
        minHighRiskCases: 4,
      },
      proposedValue: {
        balancingMode: "weighted",
        overloadSharePercent: 30,
        minHighRiskCases: 4,
      },
    });

    expect(rows).toEqual([
      {
        label: "Overload share threshold",
        before: "35%",
        after: "30%",
      },
    ]);
  });
});
