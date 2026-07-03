import { describe, expect, it } from "vitest";
import {
  isCommissionStructure,
  resolveEffectiveCapxRate,
  resolveEffectiveServiceSourceRate,
  type CommissionStructureRates,
} from "./commission-structure.js";

const rates = (over: Partial<CommissionStructureRates> = {}): CommissionStructureRates => ({
  commissionStructure: "solo",
  capxRateSolo: 0.03,
  capxRateMixed: 0.025,
  serviceSourceRate: 0.005,
  ...over,
});

describe("resolveEffectiveCapxRate", () => {
  it("uses the solo rate under the solo structure", () => {
    expect(resolveEffectiveCapxRate(rates({ commissionStructure: "solo" }))).toBe(0.03);
  });

  it("uses the mixed rate under the mixed structure", () => {
    expect(resolveEffectiveCapxRate(rates({ commissionStructure: "mixed" }))).toBe(0.025);
  });
});

describe("resolveEffectiveServiceSourceRate", () => {
  it("is zero under solo even if a stray rate is stored", () => {
    expect(resolveEffectiveServiceSourceRate(rates({ commissionStructure: "solo" }))).toBe(0);
  });

  it("is the stored service-source rate under mixed", () => {
    expect(resolveEffectiveServiceSourceRate(rates({ commissionStructure: "mixed" }))).toBe(0.005);
  });
});

describe("isCommissionStructure", () => {
  it("accepts the two valid values and rejects anything else", () => {
    expect(isCommissionStructure("solo")).toBe(true);
    expect(isCommissionStructure("mixed")).toBe(true);
    expect(isCommissionStructure("hybrid")).toBe(false);
    expect(isCommissionStructure(undefined)).toBe(false);
  });
});
