import { describe, expect, it } from "vitest";
import { rankExtractionMatches } from "../../../src/modules/estimating/matching-service.js";

describe("rankExtractionMatches", () => {
  it("uses catalog fit and similar historical line items when ranking matches", async () => {
    const results = await rankExtractionMatches({
      extraction: { normalizedLabel: "parapet wall flashing", unit: "ft", divisionHint: "07" } as any,
      catalogItems: [
        { id: "a", name: "Parapet Wall Flashing", unit: "ft", primaryCode: "07-100", catalogBaselinePrice: "100.00" },
        { id: "b", name: "Flashing", unit: "ea", primaryCode: "08-200", catalogBaselinePrice: "20.00" },
      ] as any,
      historicalItems: [
        { id: "hist-1", description: "Parapet Wall Flashing", unit: "ft", costCode: "07-100", unitPrice: "118.00" },
      ] as any,
    });

    expect(results[0]?.catalogItemId).toBe("a");
    expect(results[0]?.historicalLineItemIds).toContain("hist-1");
  });
});
