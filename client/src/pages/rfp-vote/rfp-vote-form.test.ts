import { describe, expect, it } from "vitest";
import {
  currentTypeCode,
  formatMoney,
  initFormFromDeal,
  labelForTypeCode,
  type DealFieldsForForm,
} from "./rfp-vote-form";

const deal: DealFieldsForForm = {
  name: "Palm Villas",
  dealNumber: "HS-318900588242",
  projectNumber: "DFW-2-31825-aa",
  projectType: "Interior Renovation", // display label (server COALESCEs config name)
  bidEstimate: "125000.5",
  ddEstimate: "100000",
  awardedAmount: null,
  forecastRevenue: null,
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

  it("falls back to dd/awarded/forecast when bid_estimate is null (matches the payload COALESCE)", () => {
    expect(initFormFromDeal({ ...deal, bidEstimate: null }).amount).toBe("100000");
    expect(initFormFromDeal({ ...deal, bidEstimate: null, ddEstimate: null, awardedAmount: "50000" }).amount).toBe("50000");
    // forecast-only deal: the payload ships forecastRevenue, so the form must pre-fill it (not blank)
    expect(
      initFormFromDeal({ ...deal, awardedAmount: null, bidEstimate: null, ddEstimate: null, forecastRevenue: "42000" }).amount,
    ).toBe("42000");
  });

  it("seeds project_number with the FORMATTED display number (deal_number when project_number is null)", () => {
    // CRM-native deal: real number is in deal_number, project_number still null → form shows it, not blank/Pending.
    expect(initFormFromDeal({ ...deal, projectNumber: null, dealNumber: "DFW-1-00001-aa" }).project_number).toBe("DFW-1-00001-aa");
    // Pending HubSpot deal: no project_number + an HS deal_number → blank (never the raw HS id).
    expect(initFormFromDeal({ ...deal, projectNumber: null, dealNumber: "HS-999999999" }).project_number).toBe("");
  });
});

describe("initFormFromDeal display field set", () => {
  it("exposes exactly the 12 project fields shown read-only (no company/contact/notes)", () => {
    const keys = Object.keys(initFormFromDeal(deal)).sort();
    expect(keys).toEqual(
      ["address", "amount", "bid_due_date", "city", "country", "dealname", "description", "estimator", "project_number", "project_types", "state", "zip"].sort(),
    );
    expect(keys).not.toContain("company_name");
    expect(keys).not.toContain("client_email");
    expect(keys).not.toContain("notes");
  });
});

describe("formatMoney", () => {
  it("always renders two decimals for currency", () => {
    expect(formatMoney("125000")).toBe("$125,000.00");
    expect(formatMoney("125000.5")).toBe("$125,000.50");
    expect(formatMoney("125000.509")).toBe("$125,000.51");
  });
  it("renders a dash for null/empty and passes non-numeric through", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney("")).toBe("—");
    expect(formatMoney("N/A")).toBe("N/A");
  });
});

describe("labelForTypeCode", () => {
  it("maps a code to its label", () => {
    expect(labelForTypeCode("4")).toBe("Service");
    expect(labelForTypeCode("")).toBe("—");
  });
});
