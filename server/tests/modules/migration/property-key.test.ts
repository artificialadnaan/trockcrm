import { describe, expect, it } from "vitest";
import { buildPropertyKey } from "../../../src/modules/migration/property-key.js";

describe("buildPropertyKey", () => {
  it("keeps same-address properties from different companies separate", () => {
    const alpha = buildPropertyKey({
      companyName: "Alpha Roofing",
      address: "123 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75201",
    });
    const beta = buildPropertyKey({
      companyName: "Beta Roofing",
      address: "123 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75201",
    });

    expect(alpha).not.toBe(beta);
  });

  it("falls back to domain when company name is unavailable", () => {
    const key = buildPropertyKey({
      companyDomain: "example.com",
      address: "456 Elm St",
      city: "Dallas",
      state: "TX",
      zip: "75202",
    });

    expect(key).toContain("example.com");
  });
});
