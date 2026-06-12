import { describe, it, expect } from "vitest";
import { awardedAmountSeedOnWin } from "../../../src/modules/deals/awarded-amount-seed.js";

describe("awardedAmountSeedOnWin", () => {
  it("seeds bid when awarded is null and bid > 0", () => {
    expect(awardedAmountSeedOnWin(null, "6317.62")).toBe("6317.62");
  });
  it("does NOT seed when awarded already present", () => {
    expect(awardedAmountSeedOnWin("54691.45", "6317.62")).toBeNull();
  });
  it("does NOT seed when bid is null", () => {
    expect(awardedAmountSeedOnWin(null, null)).toBeNull();
  });
  it("does NOT seed when bid is zero or negative", () => {
    expect(awardedAmountSeedOnWin(null, "0.00")).toBeNull();
    expect(awardedAmountSeedOnWin(null, "-5")).toBeNull();
  });
  it("treats empty-string awarded as blank and seeds", () => {
    expect(awardedAmountSeedOnWin("", "100")).toBe("100");
  });
  it("does NOT seed when bid is a non-numeric string (Number.isFinite guard)", () => {
    expect(awardedAmountSeedOnWin(null, "abc")).toBeNull();
  });
});
