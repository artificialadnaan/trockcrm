import { describe, expect, it } from "vitest";
import { buildPropertyUpdatePatch } from "./service.js";

describe("property update patch validation", () => {
  it("allows reps to enrich just the missing address fields on an imported property", () => {
    expect(
      buildPropertyUpdatePatch({
        address: "5000 Triangle Pkwy",
        city: "Peachtree Corners",
        state: "ga",
        zip: "30092",
      })
    ).toEqual({
      address: "5000 Triangle Pkwy",
      city: "Peachtree Corners",
      state: "GA",
      zip: "30092",
    });
  });

  it("rejects invalid state and ZIP values during address enrichment", () => {
    expect(() => buildPropertyUpdatePatch({ state: "Georgia" })).toThrow("State must be a 2-letter US state code");
    expect(() => buildPropertyUpdatePatch({ zip: "abc" })).toThrow("ZIP must be 5 digits or ZIP+4");
  });

  it("rejects blank provided address fields instead of clearing the property", () => {
    expect(() => buildPropertyUpdatePatch({ address: "" })).toThrow("Address cannot be blank when provided");
    expect(() => buildPropertyUpdatePatch({ city: null })).toThrow("City cannot be blank when provided");
    expect(() => buildPropertyUpdatePatch({ state: "" })).toThrow("State cannot be blank when provided");
    expect(() => buildPropertyUpdatePatch({ zip: null })).toThrow("ZIP cannot be blank when provided");
  });

  it("updates notes as optional free text, trimming and clearing blank/null to null", () => {
    expect(buildPropertyUpdatePatch({ notes: "  Roof replaced 2024  " })).toEqual({ notes: "Roof replaced 2024" });
    expect(buildPropertyUpdatePatch({ notes: "" })).toEqual({ notes: null });
    expect(buildPropertyUpdatePatch({ notes: null })).toEqual({ notes: null });
  });
});
