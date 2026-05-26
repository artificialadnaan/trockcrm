import { describe, expect, it } from "vitest";
import {
  DEAL_REGION_DEFINITIONS,
  getDealRegionForState,
  getDealRegionSlugForState,
  normalizeUsStateCode,
} from "./deal-regions.js";

const expectedRegions = {
  west_coast: ["WA", "OR", "CA", "NV", "ID", "MT", "WY", "UT", "CO", "AZ", "NM", "AK", "HI"],
  central: ["ND", "SD", "NE", "KS", "OK", "TX", "MN", "IA", "MO", "AR", "LA"],
  east_coast: ["WI", "IL", "MI", "IN", "OH", "KY", "TN", "MS", "AL", "GA", "FL", "WV", "VA", "NC", "SC", "PA", "NY", "ME", "VT", "NH", "MA", "RI", "CT", "NJ", "DE", "MD"],
} as const;

describe("deal region state mapping", () => {
  it("defines exactly the three selectable deal regions", () => {
    expect(DEAL_REGION_DEFINITIONS.map((region) => region.name)).toEqual([
      "West Coast",
      "Central",
      "East Coast",
    ]);
  });

  it("maps all 50 states to the requested region", () => {
    for (const [slug, states] of Object.entries(expectedRegions)) {
      for (const state of states) {
        expect(getDealRegionSlugForState(state)).toBe(slug);
      }
    }
  });

  it("handles full state names defensively", () => {
    expect(normalizeUsStateCode("Texas")).toBe("TX");
    expect(getDealRegionForState("New Mexico")?.name).toBe("West Coast");
    expect(getDealRegionForState("North Dakota")?.name).toBe("Central");
    expect(getDealRegionForState("Rhode Island")?.name).toBe("East Coast");
  });

  it("returns no region for missing or unknown states", () => {
    expect(getDealRegionForState(null)).toBeNull();
    expect(getDealRegionForState("")).toBeNull();
    expect(getDealRegionForState("DC")).toBeNull();
    expect(getDealRegionForState("Puerto Rico")).toBeNull();
    expect(getDealRegionForState("ZZ")).toBeNull();
  });
});
