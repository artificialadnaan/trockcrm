import { describe, expect, it } from "vitest";
import { formatDealDisplayNumber, isHubspotImportedDealNumber } from "./deal-utils";

describe("isHubspotImportedDealNumber", () => {
  it("flags HS- prefixed dealNumbers as HubSpot-imported", () => {
    expect(isHubspotImportedDealNumber("HS-324283495135")).toBe(true);
    expect(isHubspotImportedDealNumber("HS324283495135")).toBe(true);
    expect(isHubspotImportedDealNumber("hs-12345")).toBe(true);
  });

  it("does not flag native deal numbers", () => {
    expect(isHubspotImportedDealNumber("ATL-2-12826-AH")).toBe(false);
    expect(isHubspotImportedDealNumber("DFW-105-aa")).toBe(false);
    expect(isHubspotImportedDealNumber("BB-42")).toBe(false);
  });

  it("handles null and empty values", () => {
    expect(isHubspotImportedDealNumber(null)).toBe(false);
    expect(isHubspotImportedDealNumber(undefined)).toBe(false);
    expect(isHubspotImportedDealNumber("")).toBe(false);
  });
});

describe("formatDealDisplayNumber", () => {
  it("prefers projectNumber over dealNumber", () => {
    const result = formatDealDisplayNumber({
      projectNumber: "ATL-2-12826-AH",
      dealNumber: "HS-324283495135",
    });
    expect(result).toEqual({ label: "ATL-2-12826-AH", isFallback: false, isPending: false });
  });

  it("falls back to native dealNumber when projectNumber is missing", () => {
    const result = formatDealDisplayNumber({
      projectNumber: null,
      dealNumber: "BB-42",
    });
    expect(result).toEqual({ label: "BB-42", isFallback: true, isPending: false });
  });

  it("returns 'Pending' label instead of an HS- prefixed dealNumber", () => {
    const result = formatDealDisplayNumber({
      projectNumber: null,
      dealNumber: "HS-324283495135",
    });
    expect(result).toEqual({ label: "Pending", isFallback: true, isPending: true });
  });

  it("returns 'Pending' label when both projectNumber and dealNumber are missing", () => {
    const result = formatDealDisplayNumber({});
    expect(result).toEqual({ label: "Pending", isFallback: true, isPending: true });
  });

  it("never exposes the HS- HubSpot prefix even when whitespace is present", () => {
    const result = formatDealDisplayNumber({
      projectNumber: "   ",
      dealNumber: "  HS-9999  ",
    });
    expect(result.label).toBe("Pending");
    expect(result.isPending).toBe(true);
  });
});
