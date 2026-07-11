import { describe, it, expect } from "vitest";
import {
  isCompleteBillingAddress,
  updateBreaksBillingAddress,
  billingAddressToAbsorb,
} from "../../src/lib/billing-address.js";

const complete = { address: "100 Main St", city: "Dallas", state: "TX", zip: "75201" };
const partial = { address: "100 Main St", city: "Dallas", state: null, zip: null };
const empty = { address: null, city: null, state: null, zip: null };

describe("isCompleteBillingAddress", () => {
  it("accepts a complete address, rejects partial/empty", () => {
    expect(isCompleteBillingAddress(complete)).toBe(true);
    expect(isCompleteBillingAddress(partial)).toBe(false);
    expect(isCompleteBillingAddress(empty)).toBe(false);
  });
});

describe("updateBreaksBillingAddress", () => {
  it("flags a complete -> incomplete address change (clearing a field)", () => {
    expect(updateBreaksBillingAddress(complete, { city: "" })).toBe(true);
    expect(updateBreaksBillingAddress(complete, { zip: null })).toBe(true);
  });

  it("allows changing to another COMPLETE address", () => {
    expect(updateBreaksBillingAddress(complete, { address: "200 Oak Ave", city: "Austin", state: "TX", zip: "78701" })).toBe(false);
  });

  it("ignores updates that don't touch the address", () => {
    expect(updateBreaksBillingAddress(complete, { phone: "555-1212" })).toBe(false);
  });

  it("does not force cleanup of an ALREADY-incomplete address (forward-only)", () => {
    expect(updateBreaksBillingAddress(partial, { address: "1 New St" })).toBe(false);
    expect(updateBreaksBillingAddress(empty, { city: "Dallas" })).toBe(false);
  });

  it("allows completing a previously-incomplete address", () => {
    expect(updateBreaksBillingAddress(partial, { state: "TX", zip: "75201" })).toBe(false);
  });
});

describe("billingAddressToAbsorb", () => {
  it("absorbs the loser's full address as a UNIT when the winner is incomplete and the loser is complete", () => {
    expect(billingAddressToAbsorb(empty, complete)).toEqual(complete);
    expect(billingAddressToAbsorb(partial, complete)).toEqual(complete);
  });

  it("absorbs nothing when the winner is already complete", () => {
    expect(billingAddressToAbsorb(complete, complete)).toEqual({});
  });

  it("fills the winner's empty fields from a PARTIAL loser instead of discarding it (Codex P2 regression)", () => {
    // Empty winner, loser has street + city only -> keep those two.
    expect(billingAddressToAbsorb(empty, partial)).toEqual({ address: "100 Main St", city: "Dallas" });
    // Winner has street + city, loser has state + zip -> fill the winner's missing state + zip.
    expect(billingAddressToAbsorb(
      { address: "1 St", city: "Dallas", state: null, zip: null },
      { address: null, city: null, state: "TX", zip: "75201" },
    )).toEqual({ state: "TX", zip: "75201" });
  });
});
