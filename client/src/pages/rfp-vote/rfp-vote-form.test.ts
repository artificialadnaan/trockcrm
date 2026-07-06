import { describe, expect, it } from "vitest";
import {
  currentTypeCode,
  diffEditedFields,
  initFormFromDeal,
  labelForTypeCode,
  rewriteProjectNumberType,
  toEditedFields,
  type DealFieldsForForm,
} from "./rfp-vote-form";

const deal: DealFieldsForForm = {
  name: "Palm Villas",
  projectNumber: "DFW-2-31825-aa",
  projectType: "Interior Renovation", // display label (server COALESCEs config name)
  bidEstimate: "125000.5",
  ddEstimate: "100000",
  awardedAmount: null,
  estimator: "Colby Reed",
  bidDueDate: "2026-07-03T00:00:00.000Z",
  propertyAddress: "100 Main",
  propertyCity: "Dallas",
  propertyState: "TX",
  propertyZip: "75201",
  propertyCountry: "US",
  description: "Exterior scope",
};

describe("currentTypeCode", () => {
  it("uses deals.project_type as authoritative (even when the number digit disagrees)", () => {
    // number says 7 (Emergency), type says roofing (3) — project_type wins, so an untouched approve won't reclassify
    expect(currentTypeCode({ projectNumber: "ATL-7-10025-aa", projectType: "roofing" })).toBe("3");
    expect(currentTypeCode({ projectNumber: null, projectType: "Roofing" })).toBe("3"); // label match
    expect(currentTypeCode({ projectNumber: "DFW-2-31825-aa", projectType: "service" })).toBe("4"); // value match
  });
  it("falls back to the project_number digit only when project_type is absent/unmappable", () => {
    expect(currentTypeCode({ projectNumber: "ATL-7-10025-aa", projectType: null })).toBe("7");
    expect(currentTypeCode({ projectNumber: "DFW-5-10025-aa", projectType: "not a real type" })).toBe("5");
  });
  it("returns empty when nothing resolves", () => {
    expect(currentTypeCode({ projectNumber: null, projectType: null })).toBe("");
    expect(currentTypeCode({ projectNumber: "legacy 123", projectType: null })).toBe("");
  });
});

describe("initFormFromDeal", () => {
  it("maps the deal onto the SyncHub-keyed form fields", () => {
    const f = initFormFromDeal(deal);
    expect(f.dealname).toBe("Palm Villas");
    expect(f.project_number).toBe("DFW-2-31825-aa");
    expect(f.amount).toBe("125000.5"); // bid_estimate wins
    expect(f.project_types).toBe("2"); // from the project number digit
    expect(f.estimator).toBe("Colby Reed");
    expect(f.bid_due_date).toBe("2026-07-03"); // ISO UTC -> YYYY-MM-DD
    expect(f.address).toBe("100 Main");
    expect(f.state).toBe("TX");
    expect(f.country).toBe("US");
    expect(f.description).toBe("Exterior scope");
  });

  it("falls back to dd/awarded when bid_estimate is null", () => {
    expect(initFormFromDeal({ ...deal, bidEstimate: null }).amount).toBe("100000");
    expect(initFormFromDeal({ ...deal, bidEstimate: null, ddEstimate: null, awardedAmount: "50000" }).amount).toBe("50000");
  });
});

describe("rewriteProjectNumberType", () => {
  it("swaps the type digit in a canonical number (any office prefix)", () => {
    expect(rewriteProjectNumberType("DFW-2-31825-aa", "3")).toBe("DFW-3-31825-aa");
    expect(rewriteProjectNumberType("ATL-9-10025-bb", "5")).toBe("ATL-5-10025-bb");
  });
  it("leaves a non-canonical number untouched", () => {
    expect(rewriteProjectNumberType("legacy 123", "3")).toBe("legacy 123");
  });
  it("is a no-op for an empty code", () => {
    expect(rewriteProjectNumberType("DFW-2-31825-aa", "")).toBe("DFW-2-31825-aa");
  });
});

describe("toEditedFields", () => {
  it("emits exactly the writable SyncHub keys (no company/contact/notes)", () => {
    const f = initFormFromDeal(deal);
    const edited = toEditedFields(f);
    expect(Object.keys(edited).sort()).toEqual(
      ["address", "amount", "bid_due_date", "city", "country", "dealname", "description", "estimator", "project_number", "project_types", "state", "zip"].sort(),
    );
    expect(edited).not.toHaveProperty("company_name");
    expect(edited).not.toHaveProperty("client_email");
    expect(edited).not.toHaveProperty("notes");
  });
});

describe("labelForTypeCode", () => {
  it("maps a code to its label", () => {
    expect(labelForTypeCode("4")).toBe("Service");
    expect(labelForTypeCode("")).toBe("—");
  });
});

describe("diffEditedFields", () => {
  it("returns null when nothing changed from the initial pre-fill (untouched approve sends no edits)", () => {
    const initial = initFormFromDeal(deal);
    expect(diffEditedFields({ ...initial }, initial)).toBeNull();
  });
  it("returns ONLY the fields the voter changed", () => {
    const initial = initFormFromDeal(deal);
    const changed = { ...initial, dealname: "New Name", amount: "999" };
    expect(diffEditedFields(changed, initial)).toEqual({ dealname: "New Name", amount: "999" });
  });
});
