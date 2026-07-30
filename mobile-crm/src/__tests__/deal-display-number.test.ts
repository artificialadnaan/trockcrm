import { isHubspotImportedDealNumber, resolveDealDisplayNumber } from "../deal-display-number";

describe("the human-facing deal number", () => {
  it("prefers the canonical project number", () => {
    expect(
      resolveDealDisplayNumber({ projectNumber: "DFW-1-09026-af", dealNumber: "HS-318900588242" }),
    ).toBe("DFW-1-09026-af");
  });

  it("falls back to the deal number for a BID-BOARD deal, whose projectNumber is EMPTY", () => {
    // The case `projectNumber ?? dealNumber` gets wrong: "" is not nullish, so it wins and the real
    // number is thrown away. This is why the rule cannot be a coalesce.
    expect(resolveDealDisplayNumber({ projectNumber: "", dealNumber: "BB-4417" })).toBe("BB-4417");
    expect(resolveDealDisplayNumber({ projectNumber: "   ", dealNumber: "BB-4417" })).toBe("BB-4417");
  });

  it("NEVER shows a HubSpot id", () => {
    // The other direction the coalesce gets wrong: with no project number it falls straight through
    // to an internal identifier and puts it on screen.
    expect(resolveDealDisplayNumber({ projectNumber: null, dealNumber: "HS-204627995347" })).toBeNull();
    expect(resolveDealDisplayNumber({ projectNumber: "", dealNumber: "hs_9999" })).toBeNull();
  });

  it("returns null when there is no number yet, so the caller can omit it", () => {
    expect(resolveDealDisplayNumber({ projectNumber: null, dealNumber: null })).toBeNull();
    expect(resolveDealDisplayNumber({})).toBeNull();
  });

  it("recognises the HubSpot forms the shared resolver does", () => {
    expect(isHubspotImportedDealNumber("HS-318900588242")).toBe(true);
    expect(isHubspotImportedDealNumber("  HS-9999  ")).toBe(true);
    expect(isHubspotImportedDealNumber("BB-4417")).toBe(false);
    expect(isHubspotImportedDealNumber(null)).toBe(false);
  });
});
