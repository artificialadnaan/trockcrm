import { describe, expect, it } from "vitest";
import { pickDealSecondaryLabel } from "../../../src/modules/search/service";

describe("pickDealSecondaryLabel (search deal regression)", () => {
  it("prefers project_number over deal_number", () => {
    expect(pickDealSecondaryLabel("ATL-2-12826-AH", "HS-324283495135")).toBe("ATL-2-12826-AH");
  });

  it("falls back to deal_number when project_number is null and deal_number is not HubSpot-imported", () => {
    expect(pickDealSecondaryLabel(null, "BB-42")).toBe("BB-42");
    expect(pickDealSecondaryLabel(null, "DFW-105-aa")).toBe("DFW-105-aa");
  });

  it("never exposes an HS- prefixed deal_number to users in search results", () => {
    expect(pickDealSecondaryLabel(null, "HS-324283495135")).toBe("");
    expect(pickDealSecondaryLabel(null, "hs-12345")).toBe("");
    expect(pickDealSecondaryLabel("", "HS-9999")).toBe("");
  });

  it("returns empty string when both are missing", () => {
    expect(pickDealSecondaryLabel(null, null)).toBe("");
    expect(pickDealSecondaryLabel("", "")).toBe("");
  });
});
