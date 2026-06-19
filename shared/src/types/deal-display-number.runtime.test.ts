import { describe, expect, it } from "vitest";
import {
  isHubspotImportedDealNumber,
  formatDealDisplayNumber,
  resolveDealDisplayNumber,
} from "./deal-display-number.js";

describe("isHubspotImportedDealNumber", () => {
  it("flags HS- imported ids in any casing/separator", () => {
    expect(isHubspotImportedDealNumber("HS-318900588242")).toBe(true);
    expect(isHubspotImportedDealNumber("HS318900588242")).toBe(true);
    expect(isHubspotImportedDealNumber("hs-12345")).toBe(true);
    expect(isHubspotImportedDealNumber("  HS-9999  ")).toBe(true);
  });

  it("does not flag canonical DFW/ATL or other native numbers", () => {
    expect(isHubspotImportedDealNumber("DFW-1-09026-af")).toBe(false);
    expect(isHubspotImportedDealNumber("ATL-4-16326-ab")).toBe(false);
    expect(isHubspotImportedDealNumber("BB-42")).toBe(false);
  });

  it("handles nullish/empty", () => {
    expect(isHubspotImportedDealNumber(null)).toBe(false);
    expect(isHubspotImportedDealNumber(undefined)).toBe(false);
    expect(isHubspotImportedDealNumber("")).toBe(false);
  });
});

describe("formatDealDisplayNumber", () => {
  it("prefers project_number (HubSpot-imported deal: never the HS id)", () => {
    expect(formatDealDisplayNumber({ projectNumber: "DFW-1-09026-af", dealNumber: "HS-318900588242" })).toEqual({
      label: "DFW-1-09026-af",
      isFallback: false,
      isPending: false,
    });
  });

  it("falls back to a non-HubSpot deal_number (bid-board-owned deal)", () => {
    expect(formatDealDisplayNumber({ projectNumber: null, dealNumber: "DFW-3-16726-aa" })).toEqual({
      label: "DFW-3-16726-aa",
      isFallback: true,
      isPending: false,
    });
  });

  it("returns Pending instead of an HS- deal_number (null edge)", () => {
    expect(formatDealDisplayNumber({ projectNumber: null, dealNumber: "HS-204627995347" })).toEqual({
      label: "Pending",
      isFallback: true,
      isPending: true,
    });
  });

  it("conflict (both canonical): project_number wins", () => {
    expect(formatDealDisplayNumber({ projectNumber: "DFW-1-13226-aa", dealNumber: "DFW-9-13226-aw" }).label).toBe(
      "DFW-1-13226-aa",
    );
  });

  it("returns Pending when both are missing/blank", () => {
    expect(formatDealDisplayNumber({}).isPending).toBe(true);
    expect(formatDealDisplayNumber({ projectNumber: "   ", dealNumber: "  HS-9999 " }).isPending).toBe(true);
  });
});

describe("resolveDealDisplayNumber (value-or-null)", () => {
  it("returns the canonical value when present", () => {
    expect(resolveDealDisplayNumber({ projectNumber: "DFW-1-09026-af", dealNumber: "HS-1" })).toBe("DFW-1-09026-af");
    expect(resolveDealDisplayNumber({ projectNumber: null, dealNumber: "DFW-3-16726-aa" })).toBe("DFW-3-16726-aa");
  });

  it("returns null (never the HS id) when there is no canonical number", () => {
    expect(resolveDealDisplayNumber({ projectNumber: null, dealNumber: "HS-204627995347" })).toBeNull();
    expect(resolveDealDisplayNumber({})).toBeNull();
  });
});
