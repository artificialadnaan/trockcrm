import { describe, expect, it } from "vitest";
import { classifyPropertyEngagementStatus } from "../../../src/modules/properties/service.js";

describe("property engagement status", () => {
  it("classifies converted deals as won before generic active deals", () => {
    expect(classifyPropertyEngagementStatus({
      dealCount: 2,
      leadCount: 1,
      convertedDealCount: 1,
    })).toBe("won");
  });

  it("uses the same hierarchy for list and detail callers", () => {
    expect(classifyPropertyEngagementStatus({
      dealCount: 1,
      leadCount: 1,
      convertedDealCount: 0,
    })).toBe("active_deal");

    expect(classifyPropertyEngagementStatus({
      dealCount: 0,
      leadCount: 1,
      convertedDealCount: 0,
    })).toBe("active_lead");

    expect(classifyPropertyEngagementStatus({
      dealCount: 0,
      leadCount: 0,
      convertedDealCount: 0,
    })).toBe("no_engagement");
  });
});
