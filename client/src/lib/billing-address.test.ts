import { describe, it, expect } from "vitest";
import { getMissingBillingAddressFields, isCompleteBillingAddress } from "./billing-address";

describe("billing address completeness (client)", () => {
  const complete = { address: "100 Main St", city: "Dallas", state: "TX", zip: "75201" };

  it("accepts a complete address and a ZIP+4", () => {
    expect(isCompleteBillingAddress(complete)).toBe(true);
    expect(isCompleteBillingAddress({ ...complete, zip: "75201-1234" })).toBe(true);
  });

  it("accepts a lowercase 2-letter state", () => {
    expect(isCompleteBillingAddress({ ...complete, state: "tx" })).toBe(true);
  });

  it("flags every blank field in order", () => {
    expect(getMissingBillingAddressFields({ address: "", city: "", state: "", zip: "" }))
      .toEqual(["address", "city", "state", "zip"]);
    expect(isCompleteBillingAddress({})).toBe(false);
  });

  it("rejects a full state name and a malformed ZIP", () => {
    expect(getMissingBillingAddressFields({ ...complete, state: "Texas" })).toEqual(["state"]);
    expect(getMissingBillingAddressFields({ ...complete, zip: "7520" })).toEqual(["zip"]);
  });

  it("treats whitespace-only and null as blank", () => {
    expect(getMissingBillingAddressFields({ address: "  ", city: null, state: " ", zip: null }))
      .toEqual(["address", "city", "state", "zip"]);
  });
});
