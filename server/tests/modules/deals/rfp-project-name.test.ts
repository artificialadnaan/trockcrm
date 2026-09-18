import { describe, expect, it } from "vitest";
import { rfpProjectName } from "../../../src/modules/deals/rfp-project-name.js";
import { buildNormalizedRfpRequestBody } from "../../../src/modules/deals/rfp-payload.js";

describe("CRM RFP naming and scope contract", () => {
  it.each([
    [" Palm Villas ", " Roof leak ", "Palm Villas - Roof leak"],
    ["Palm Villas", "palm villas", "Palm Villas"],
    ["Palm Villas", "Palm Villas - Roof leak", "Palm Villas - Roof leak"],
    [null, "Roof leak", "Roof leak"],
    ["Palm Villas", "  ", "Palm Villas"],
    [null, null, "Untitled Deal"],
  ])("composes %s / %s", (property, opportunity, expected) => {
    expect(rfpProjectName(property, opportunity)).toBe(expected);
  });
  it("preserves both components within Core's 300 character limit", () => {
    const name = rfpProjectName("P".repeat(500), "O".repeat(500));
    expect(name.length).toBe(300);
    expect(name).toContain(" - OOOOO");
  });
  it("ships naming through existing deal.name, preserving CRM identifiers and optional metadata", () => {
    const payload = buildNormalizedRfpRequestBody({ sourceEventId: "event-1", deal: {
      id: "deal-1", name: "Roof leak", dealNumber: "DFW-4-10000-aa", projectType: "service",
      propertyName: "Palm Villas", propertyId: "property-1", scopeTitle: "Repair flashing", description: "  ",
    } });
    expect(payload.deal).toMatchObject({ name: "Palm Villas - Roof leak", propertyName: "Palm Villas", propertyId: "property-1", scopeTitle: "Repair flashing", description: "Repair flashing" });
  });
  it("prefers description and does not relax the normal RFP description contract", () => {
    const base = { id: "deal-1", name: "Roof", dealNumber: "DFW-4-10000-aa", scopeTitle: "Short title" };
    expect(buildNormalizedRfpRequestBody({ sourceEventId: "e", deal: { ...base, projectType: "service", description: "Full details" } }).deal.description).toBe("Full details");
    expect(buildNormalizedRfpRequestBody({ sourceEventId: "e", deal: { ...base, projectType: "roofing" } }).deal.description).toBeNull();
  });
});
