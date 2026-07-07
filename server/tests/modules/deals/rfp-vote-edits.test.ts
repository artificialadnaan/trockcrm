import { describe, expect, it } from "vitest";
import { buildRfpVoteDealUpdate } from "../../../src/modules/deals/rfp-vote-edits.js";

const baseDeal = {
  name: "Old Name",
  projectNumber: "DFW-2-31825-aa", // type code 2 (interior renovation)
  projectType: "interior renovation",
  bidEstimate: "100000.00",
  awardedAmount: null,
  ddEstimate: null,
  forecastRevenue: null,
  estimator: "Old Estimator",
  description: "old desc",
  bidDueDate: new Date("2026-06-01T00:00:00.000Z"),
  propertyAddress: "1 Old St",
  propertyCity: "Dallas",
  propertyState: "TX",
  propertyZip: "75201",
  propertyCountry: "US",
};

function expectThrowCode(fn: () => unknown, code: string) {
  try {
    fn();
    expect.unreachable(`expected throw ${code}`);
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
  }
}

describe("buildRfpVoteDealUpdate", () => {
  it("maps every editable field onto the right deal column", () => {
    const u = buildRfpVoteDealUpdate(
      {
        dealname: "New Name",
        amount: "$250,000",
        project_number: "DFW-2-31825-aa",
        project_types: "3", // roofing → also rewrites the number's type digit
        estimator: "New Estimator",
        bid_due_date: "2026-07-15",
        address: "2 New Ave",
        city: "Plano",
        zip: "75002",
        country: "USA",
        description: "new desc",
      },
      baseDeal,
    );
    expect(u.name).toBe("New Name");
    expect(u.bidEstimate).toBe("250000.00"); // amount → bid_estimate (not awarded_amount)
    expect(u.projectType).toBe("roofing");
    expect(u.projectNumber).toBe("DFW-3-31825-aa"); // type digit 2 → 3
    expect(u.estimator).toBe("New Estimator");
    expect((u.bidDueDate as Date).toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(u.propertyAddress).toBe("2 New Ave");
    expect(u.propertyCity).toBe("Plano");
    expect(u.propertyZip).toBe("75002");
    expect(u.propertyCountry).toBe("USA");
    expect(u.description).toBe("new desc");
  });

  it("rewrites the project number's type digit when only project_types changes", () => {
    const u = buildRfpVoteDealUpdate({ project_types: "3" }, baseDeal);
    expect(u.projectType).toBe("roofing");
    expect(u.projectNumber).toBe("DFW-3-31825-aa");
  });

  it("lets the selected type win the digit even over a directly-edited number", () => {
    const u = buildRfpVoteDealUpdate(
      { project_number: "ATL-9-10025-bb", project_types: "3" },
      baseDeal,
    );
    expect(u.projectNumber).toBe("ATL-3-10025-bb");
    expect(u.projectType).toBe("roofing");
  });

  it("blocks changing a non-service deal INTO Service (code 4)", () => {
    expectThrowCode(() => buildRfpVoteDealUpdate({ project_types: "4" }, baseDeal), "RFP_VOTE_SERVICE_TYPE_BLOCKED");
  });

  it("allows an UNCHANGED Service value (already-service open round) without blocking or writing", () => {
    const serviceDeal = { ...baseDeal, projectType: "service", projectNumber: "DFW-4-31825-aa" };
    const u = buildRfpVoteDealUpdate({ project_types: "4" }, serviceDeal); // unchanged — must not block or write
    expect(u.projectType).toBeUndefined();
    expect("projectTypeId" in u).toBe(false);
  });

  it("records the new project_type VALUE on a real change (project_type_id is resolved later by the service)", () => {
    const u = buildRfpVoteDealUpdate({ project_types: "3" }, baseDeal); // interior renovation → roofing
    expect(u.projectType).toBe("roofing");
    expect("projectTypeId" in u).toBe(false); // pure fn no longer touches the FK; castRfpVote resolves the config id
  });

  it("does not touch project_type when the type is unchanged", () => {
    const u = buildRfpVoteDealUpdate({ project_types: "2" }, baseDeal); // baseDeal is already interior renovation (2)
    expect(u.projectType).toBeUndefined();
    expect("projectTypeId" in u).toBe(false);
  });

  it("corrects a number-only edit's type digit to the deal's CURRENT type (type wins the digit)", () => {
    // Voter edits the number to DFW-9-99999-bb but leaves the type on interior renovation (code 2) → the digit is
    // forced back to 2 while the rest of the edit (julian/suffix) is kept: DFW-2-99999-bb.
    const u = buildRfpVoteDealUpdate({ project_number: "DFW-9-99999-bb" }, baseDeal);
    expect(u.projectNumber).toBe("DFW-2-99999-bb");
    expect(u.projectType).toBeUndefined(); // type not changed
  });

  it("infers the effective type from the current number digit when project_type is absent (number-only edit)", () => {
    // project_type null, but the number encodes type 3 (roofing) — the form shows Roofing via currentTypeCode's
    // digit fallback. A number-only edit to DFW-9-… must be rewritten back to the inferred type's digit (3).
    const noTypeDeal = { ...baseDeal, projectType: null, projectNumber: "DFW-3-31825-aa" };
    const u = buildRfpVoteDealUpdate({ project_number: "DFW-9-99999-bb" }, noTypeDeal);
    expect(u.projectNumber).toBe("DFW-3-99999-bb");
    expect(u.projectType).toBeUndefined();
  });

  it("rejects a currency-only amount (would parse to 0)", () => {
    expectThrowCode(() => buildRfpVoteDealUpdate({ amount: "$" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
    expectThrowCode(() => buildRfpVoteDealUpdate({ amount: ",," }, baseDeal), "RFP_VOTE_EDIT_INVALID");
  });

  it("targets dd_estimate when it is the winning column (bid null) — untouched approve is a no-op, no silent copy", () => {
    const ddDeal = { ...baseDeal, bidEstimate: null, ddEstimate: "80000.00" };
    expect(buildRfpVoteDealUpdate({ amount: "90000" }, ddDeal).ddEstimate).toBe("90000.00");
    expect(buildRfpVoteDealUpdate({ amount: "90000" }, ddDeal).bidEstimate).toBeUndefined();
    expect(buildRfpVoteDealUpdate({ amount: "80000" }, ddDeal)).toEqual({}); // unchanged dd → no write
  });

  it("targets forecast_revenue when it's the only value (payload's last COALESCE fallback) — untouched = no-op", () => {
    const fcDeal = { ...baseDeal, bidEstimate: null, ddEstimate: null, awardedAmount: null, forecastRevenue: "42000.00" };
    expect(buildRfpVoteDealUpdate({ amount: "45000" }, fcDeal).forecastRevenue).toBe("45000.00");
    expect(buildRfpVoteDealUpdate({ amount: "45000" }, fcDeal).bidEstimate).toBeUndefined();
    expect(buildRfpVoteDealUpdate({ amount: "42000" }, fcDeal)).toEqual({}); // unchanged forecast → no silent copy
  });

  it("ignores non-primitive field values instead of coercing them to a string", () => {
    const u = buildRfpVoteDealUpdate(
      { dealname: { evil: true } as unknown, city: [1, 2] as unknown },
      baseDeal,
    );
    expect(u.name).toBeUndefined();
    expect(u.propertyCity).toBeUndefined();
  });

  it("rejects an impossible/malformed bid due date (does not silently roll it forward)", () => {
    expectThrowCode(() => buildRfpVoteDealUpdate({ bid_due_date: "2026-02-31" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
    expectThrowCode(() => buildRfpVoteDealUpdate({ bid_due_date: "2026-13-01" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
    expectThrowCode(() => buildRfpVoteDealUpdate({ bid_due_date: "06/01/2026" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
  });

  it("accepts a real bid due date as UTC midnight", () => {
    const u = buildRfpVoteDealUpdate({ bid_due_date: "2026-08-15" }, baseDeal);
    expect((u.bidDueDate as Date).toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("marks the override flag when the amount lands on awarded_amount or dd_estimate (not bid_estimate)", () => {
    const ua = buildRfpVoteDealUpdate({ amount: "250000" }, { ...baseDeal, awardedAmount: "200000.00" });
    expect(ua.awardedAmount).toBe("250000.00");
    expect(ua.awardedAmountOverridden).toBe(true);
    const ud = buildRfpVoteDealUpdate({ amount: "90000" }, { ...baseDeal, bidEstimate: null, ddEstimate: "80000.00" });
    expect(ud.ddEstimate).toBe("90000.00");
    expect(ud.ddEstimateOverridden).toBe(true);
    const ub = buildRfpVoteDealUpdate({ amount: "250000" }, baseDeal); // awarded null → bid_estimate, no flag
    expect(ub.bidEstimate).toBe("250000.00");
    expect("awardedAmountOverridden" in ub).toBe(false);
    expect("ddEstimateOverridden" in ub).toBe(false);
  });

  it("never writes company/contact/notes or unknown keys (read-only context)", () => {
    const u = buildRfpVoteDealUpdate(
      { company_name: "New Co", client_email: "a@b.com", client_phone: "555", notes: "n", bogus: "z" },
      baseDeal,
    );
    expect(u).toEqual({});
  });

  it("skips empty values (can't blank a field) and unchanged values (no-op)", () => {
    expect(buildRfpVoteDealUpdate({ dealname: "  ", description: "" }, baseDeal)).toEqual({});
    expect(buildRfpVoteDealUpdate({ dealname: "Old Name", city: "Dallas" }, baseDeal)).toEqual({});
    // "tx" uppercases to "TX" which equals the existing state → no update
    expect(buildRfpVoteDealUpdate({ state: "tx" }, baseDeal)).toEqual({});
  });

  it("rejects a malformed amount / state / date", () => {
    expectThrowCode(() => buildRfpVoteDealUpdate({ amount: "abc" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
    expectThrowCode(() => buildRfpVoteDealUpdate({ amount: "-5" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
    expectThrowCode(() => buildRfpVoteDealUpdate({ state: "Texas" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
    expectThrowCode(() => buildRfpVoteDealUpdate({ bid_due_date: "not-a-date" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
  });

  it("rejects a HubSpot id as the project number", () => {
    expectThrowCode(
      () => buildRfpVoteDealUpdate({ project_number: "HS-318900588242" }, baseDeal),
      "RFP_VOTE_EDIT_INVALID",
    );
  });

  it("fail-softs the number rewrite when the current number is non-canonical", () => {
    const legacyDeal = { ...baseDeal, projectNumber: "LEGACY 123" };
    const u = buildRfpVoteDealUpdate({ project_types: "3" }, legacyDeal);
    expect(u.projectType).toBe("roofing");
    expect(u.projectNumber).toBeUndefined(); // number left untouched (not strict-canonical)
  });

  it("writes the amount to the column the payload reads first (awarded_amount when set, else bid_estimate)", () => {
    // awarded_amount null → bid_estimate wins the payload COALESCE, so the edit lands there
    expect(buildRfpVoteDealUpdate({ amount: "250000" }, baseDeal).bidEstimate).toBe("250000.00");
    expect(buildRfpVoteDealUpdate({ amount: "250000" }, baseDeal).awardedAmount).toBeUndefined();
    // awarded_amount set (reopened-Won / admin-set) → it wins the COALESCE, so the edit must land THERE or it's lost
    const awardedDeal = { ...baseDeal, awardedAmount: "200000.00" };
    const u = buildRfpVoteDealUpdate({ amount: "250000" }, awardedDeal);
    expect(u.awardedAmount).toBe("250000.00");
    expect(u.bidEstimate).toBeUndefined();
  });

  it("rejects an amount above the money ceiling (would overflow numeric(14,2) → clean 400 not a 500)", () => {
    expectThrowCode(() => buildRfpVoteDealUpdate({ amount: "1000000000" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
    expectThrowCode(() => buildRfpVoteDealUpdate({ amount: "9999999999999" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
  });

  it("rejects an over-length city (varchar 255)", () => {
    expectThrowCode(() => buildRfpVoteDealUpdate({ city: "x".repeat(256) }, baseDeal), "RFP_VOTE_EDIT_INVALID");
  });

  it("rejects a project number with control chars or over 100 chars", () => {
    expectThrowCode(() => buildRfpVoteDealUpdate({ project_number: "DFW-2-\t31825-aa" }, baseDeal), "RFP_VOTE_EDIT_INVALID");
    expectThrowCode(() => buildRfpVoteDealUpdate({ project_number: "D".repeat(101) }, baseDeal), "RFP_VOTE_EDIT_INVALID");
  });
});
