import { describe, expect, it } from "vitest";
import { buildRecommendationOptionSet } from "../../../src/modules/estimating/recommendation-option-service.js";

describe("buildRecommendationOptionSet", () => {
  it("returns one recommended option, up to four alternates, and suppresses duplicate catalog or custom options", () => {
    const result = buildRecommendationOptionSet({
      sectionName: "Roofing",
      normalizedIntent: "roofing:tearoff",
      sourceRowIdentity: "row-1",
      candidates: [
        {
          optionLabel: "Tearoff base",
          catalogItemId: "cat-a",
          score: 95,
          historicalSelectionCount: 4,
          unitCompatibilityScore: 10,
          absolutePriceDeviation: 4,
          stableId: "cat-a",
        },
        {
          optionLabel: "Tearoff base duplicate",
          catalogItemId: "cat-a",
          score: 96,
          historicalSelectionCount: 6,
          unitCompatibilityScore: 9,
          absolutePriceDeviation: 3,
          stableId: "cat-a-duplicate",
        },
        {
          optionLabel: "Tearoff alternate",
          catalogItemId: "cat-b",
          score: 94,
          historicalSelectionCount: 3,
          unitCompatibilityScore: 10,
          absolutePriceDeviation: 5,
          stableId: "cat-b",
        },
        {
          optionLabel: "Custom flashing",
          normalizedCustomItemKey: "flashing",
          score: 93,
          historicalSelectionCount: 2,
          unitCompatibilityScore: 8,
          absolutePriceDeviation: 2,
          stableId: "custom-flashing",
        },
        {
          optionLabel: "Custom flashing duplicate",
          normalizedCustomItemKey: "flashing",
          score: 92,
          historicalSelectionCount: 1,
          unitCompatibilityScore: 8,
          absolutePriceDeviation: 1,
          stableId: "custom-flashing-duplicate",
        },
        {
          optionLabel: "Tearoff support",
          catalogItemId: "cat-c",
          score: 91,
          historicalSelectionCount: 2,
          unitCompatibilityScore: 7,
          absolutePriceDeviation: 4,
          stableId: "cat-c",
        },
        {
          optionLabel: "Tearoff cleanup",
          catalogItemId: "cat-d",
          score: 90,
          historicalSelectionCount: 1,
          unitCompatibilityScore: 9,
          absolutePriceDeviation: 6,
          stableId: "cat-d",
        },
      ],
    });

    expect(result.optionRows).toHaveLength(5);
    expect(result.optionRows[0]?.optionKind).toBe("recommended");
    expect(result.optionRows.slice(1).every((option) => option.optionKind === "alternate")).toBe(true);
    expect(result.optionRows.map((option) => option.optionLabel)).toEqual([
      "Tearoff base duplicate",
      "Tearoff alternate",
      "Custom flashing",
      "Tearoff support",
      "Tearoff cleanup",
    ]);
    expect(result.duplicateGroupMetadata.suppressedCount).toBe(2);
    expect(result.duplicateGroupMetadata.duplicateKeys).toEqual(
      expect.arrayContaining(["catalog:cat-a", "custom:flashing"])
    );
  });

  it("applies deterministic tie-break ordering when scores are identical", () => {
    const result = buildRecommendationOptionSet({
      sectionName: "Roofing",
      normalizedIntent: "roofing:drain",
      sourceRowIdentity: "row-2",
      candidates: [
        {
          optionLabel: "Alpha",
          catalogItemId: "cat-alpha",
          score: 88,
          historicalSelectionCount: 5,
          unitCompatibilityScore: 10,
          absolutePriceDeviation: 3,
          stableId: "alpha",
        },
        {
          optionLabel: "Beta",
          catalogItemId: "cat-beta",
          score: 88,
          historicalSelectionCount: 5,
          unitCompatibilityScore: 8,
          absolutePriceDeviation: 1,
          stableId: "beta",
        },
        {
          optionLabel: "Gamma",
          catalogItemId: "cat-gamma",
          score: 88,
          historicalSelectionCount: 4,
          unitCompatibilityScore: 10,
          absolutePriceDeviation: 1,
          stableId: "gamma",
        },
      ],
    });

    expect(result.optionRows.map((option) => option.optionLabel)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});
