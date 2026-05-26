import { describe, expect, it } from "vitest";
import {
  applyDealRegionAutoSelection,
  resolveRegionIdForState,
} from "./deal-region-auto-select";

const regions = [
  { id: "region-west", name: "West Coast", slug: "west_coast", states: [], displayOrder: 1, isActive: true },
  { id: "region-central", name: "Central", slug: "central", states: [], displayOrder: 2, isActive: true },
  { id: "region-east", name: "East Coast", slug: "east_coast", states: [], displayOrder: 3, isActive: true },
];

describe("deal region auto-select", () => {
  it("resolves the selectable region id from an address state", () => {
    expect(resolveRegionIdForState(regions, "CA")).toBe("region-west");
    expect(resolveRegionIdForState(regions, "Texas")).toBe("region-central");
    expect(resolveRegionIdForState(regions, "GA")).toBe("region-east");
  });

  it("leaves region unset for missing or unknown states", () => {
    expect(resolveRegionIdForState(regions, null)).toBe("");
    expect(resolveRegionIdForState(regions, "DC")).toBe("");
  });

  it("does not overwrite a manual override", () => {
    expect(
      applyDealRegionAutoSelection({
        regions,
        propertyState: "CA",
        currentRegionId: "region-east",
        manualOverride: true,
      })
    ).toBe("region-east");
  });
});
