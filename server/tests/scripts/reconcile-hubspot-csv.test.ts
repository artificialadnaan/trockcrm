import { describe, expect, it } from "vitest";
import { buildHubSpotReconciliationReport, parseCsvText } from "../../../scripts/reconcile-hubspot-csv";

describe("reconcile-hubspot-csv", () => {
  it("parses quoted CSV fields", () => {
    expect(parseCsvText('Record ID,Name\n1001,"Acme, Inc."\n')).toEqual([
      { "Record ID": "1001", Name: "Acme, Inc." },
    ]);
  });

  it("reports missing CRM records, field mismatches, and CRM-native extras", () => {
    const report = buildHubSpotReconciliationReport({
      hubspot: {
        contacts: [{ id: "hs-contact-1", name: "Ada Contact" }],
        companies: [{ id: "hs-company-1", name: "Acme" }],
        deals: [{ id: "hs-deal-1", name: "Roof Job", stage: "Closed Won", amount: "1000", owner: "owner-1", closeDate: "2026-05-01" }],
      },
      crm: {
        contacts: [],
        companies: [{ id: "company-1", hubspotId: "hs-company-1", name: "Acme" }],
        deals: [
          { id: "deal-1", hubspotId: "hs-deal-1", name: "Roof Job", stage: "Proposal Sent", amount: "900", owner: "owner-1", closeDate: "2026-05-01" },
          { id: "deal-native", hubspotId: null, name: "CRM Native", stage: "Opportunity", amount: null, owner: null, closeDate: null },
        ],
      },
    });

    expect(report.missing.contacts).toEqual([{ hubspotId: "hs-contact-1", name: "Ada Contact" }]);
    expect(report.mismatches.deals).toEqual([
      { hubspotId: "hs-deal-1", name: "Roof Job", field: "stage", hubspotValue: "closed won", crmValue: "proposal sent" },
      { hubspotId: "hs-deal-1", name: "Roof Job", field: "amount", hubspotValue: "1000.00", crmValue: "900.00" },
    ]);
    expect(report.crmOnly.deals).toEqual([{ id: "deal-native", name: "CRM Native" }]);
  });

  it("normalizes equivalent deal amount, owner, and close date values", () => {
    const report = buildHubSpotReconciliationReport({
      hubspot: {
        contacts: [],
        companies: [],
        deals: [{ id: "hs-deal-1", name: "Roof Job", stage: "Closed Won", amount: "$1,000", owner: "OWNER-1", closeDate: "05/01/2026" }],
      },
      crm: {
        contacts: [],
        companies: [],
        deals: [{ id: "deal-1", hubspotId: "hs-deal-1", name: "Roof Job", stage: "closed won", amount: "1000.00", owner: "owner-1", closeDate: "2026-05-01T00:00:00.000Z" }],
      },
    });

    expect(report.mismatches.deals).toEqual([]);
  });
});
