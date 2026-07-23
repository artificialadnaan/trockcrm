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

  it("labels V1-only deficiency keys via the V1 constant (not just the V2 map)", () => {
    // `site_org_below` and `safety_access` are V1 keys absent from the V2 deficiency map; the default
    // (V1) form fires the trigger, so these must resolve to human labels — not the raw key.
    const items = enumerateFlaggedItems({
      actionItems: [],
      criticalDeficiencies: ["site_org_below", "safety_access"],
    });
    expect(items).toEqual([
      { itemType: "critical_deficiency", itemRef: "site_org_below", itemLabel: "Site organization below standard" },
      { itemType: "critical_deficiency", itemRef: "safety_access", itemLabel: "Safety or access issue" },
    ]);
  });

  it("falls back to the raw key for an unknown deficiency key", () => {
    const items = enumerateFlaggedItems({ actionItems: [], criticalDeficiencies: ["totally_unknown"] });
    expect(items).toEqual([
      { itemType: "critical_deficiency", itemRef: "totally_unknown", itemLabel: "totally_unknown" },
    ]);
  });

  it("returns an empty list when nothing is flagged", () => {
    expect(enumerateFlaggedItems({ actionItems: [], criticalDeficiencies: [] })).toEqual([]);
  });
});
