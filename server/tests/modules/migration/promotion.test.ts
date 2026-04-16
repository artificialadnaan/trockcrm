import { describe, expect, it } from "vitest";
import { resolvePropertyPromotionTargets } from "../../../../scripts/migration-promote.js";

describe("property promotion", () => {
  it("fails when an approved property has no promoted deal mapping", () => {
    expect(() =>
      resolvePropertyPromotionTargets(
        [
          {
            id: "property-1",
            mappedCompanyName: "Alpha Roofing",
            mappedCompanyDomain: null,
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

  it("keeps same-address properties separated by company context", () => {
    const targets = resolvePropertyPromotionTargets(
      [
        {
          id: "property-1",
          mappedCompanyName: "Alpha Roofing",
          mappedCompanyDomain: null,
          mappedAddress: "123 Main",
          mappedCity: "Dallas",
          mappedState: "TX",
          mappedZip: "75001",
          promotedAt: null,
        },
        {
          id: "property-2",
          mappedCompanyName: "Beta Roofing",
          mappedCompanyDomain: null,
          mappedAddress: "123 Main",
          mappedCity: "Dallas",
          mappedState: "TX",
          mappedZip: "75001",
          promotedAt: null,
        },
      ],
      new Map([
        ["alpha roofing|123 main|dallas|tx|75001", "deal-alpha"],
        ["beta roofing|123 main|dallas|tx|75001", "deal-beta"],
      ])
    );

    expect(targets).toEqual([
      { propertyId: "property-1", promotedDealId: "deal-alpha" },
      { propertyId: "property-2", promotedDealId: "deal-beta" },
    ]);
  });
});
