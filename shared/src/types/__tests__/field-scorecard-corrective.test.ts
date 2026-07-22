import { describe, expect, it } from "vitest";
import { isCorrectiveActionBand, enumerateFlaggedItems } from "../field-scorecard.js";

describe("isCorrectiveActionBand", () => {
  it("is true only for the corrective_action rating", () => {
    expect(isCorrectiveActionBand("corrective_action")).toBe(true);
    expect(isCorrectiveActionBand("needs_improvement")).toBe(false);
    expect(isCorrectiveActionBand("elite")).toBe(false);
  });
});

describe("enumerateFlaggedItems", () => {
  it("yields one item per action item and per critical deficiency, with stable refs + labels", () => {
    const items = enumerateFlaggedItems({
      actionItems: ["Re-inspect slab 2", "Verify hold points"],
      criticalDeficiencies: ["missed_hold_point"],
    });
    expect(items).toEqual([
      { itemType: "action_item", itemRef: "0", itemLabel: "Re-inspect slab 2" },
      { itemType: "action_item", itemRef: "1", itemLabel: "Verify hold points" },
      { itemType: "critical_deficiency", itemRef: "missed_hold_point", itemLabel: "Missed hold point" },
    ]);
  });

  it("returns an empty list when nothing is flagged", () => {
    expect(enumerateFlaggedItems({ actionItems: [], criticalDeficiencies: [] })).toEqual([]);
  });
});
