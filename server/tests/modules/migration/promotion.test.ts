import { describe, expect, it } from "vitest";
import { resolvePropertyPromotionTargets } from "../../../../scripts/migration-promote.js";

describe("property promotion", () => {
  it("fails when an approved property has no promoted deal mapping", () => {
    expect(() =>
      resolvePropertyPromotionTargets(
        [
          {
            id: "property-1",
            mappedAddress: "123 Main",
            mappedCity: "Dallas",
            mappedState: "TX",
            mappedZip: "75001",
            promotedAt: null,
          },
        ],
        new Map<string, string>()
      )
    ).toThrow(/no promoted deal mapping/i);
  });
});
