import { describe, expect, it } from "vitest";
import { buildHubSpotReconciliationReport, parseCsvText } from "../../../scripts/reconcile-hubspot-csv";

function reconcileCloseDate(hubspotCloseDate: string, crmCloseDate: string) {
  return buildHubSpotReconciliationReport({
    hubspot: {
      contacts: [],
      companies: [],
      deals: [
        {
          id: "hs-deal-1",
          name: "Roof Job",
          stage: "Closed Won",
          amount: "1000",
          owner: "owner-1",
          closeDate: hubspotCloseDate,
        },
      ],
    },
    crm: {
      contacts: [],
      companies: [],
      deals: [
        {
          id: "deal-1",
          hubspotId: "hs-deal-1",
          name: "Roof Job",
          stage: "closed won",
          amount: "1000.00",
          owner: "owner-1",
          closeDate: crmCloseDate,
        },
      ],
    },
  });
}

describe("reconcile-hubspot-csv", () => {
  it("parses quoted CSV fields", () => {
    expect(parseCsvText('Record ID,Name\n1001,"Acme, Inc."\n')).toEqual([
      { "Record ID": "1001", Name: "Acme, Inc." },
    ]);
  });

  it("strips UTF-8 BOM from CSV headers so HubSpot IDs are recognized", () => {
    expect(parseCsvText('\uFEFFRecord ID,Name\n1001,"Acme, Inc."\n')).toEqual([
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

  it("reports duplicate CRM rows for the same HubSpot ID and still reconciles canonical rows", () => {
    const report = buildHubSpotReconciliationReport({
      hubspot: {
        contacts: [],
        companies: [],
        deals: [
          { id: "hs-deal-1", name: "Roof Job", stage: "Closed Won", amount: "1000", owner: "owner-1", closeDate: "2026-05-01" },
          { id: "hs-deal-2", name: "Other Job", stage: "Proposal Sent", amount: "2000", owner: "owner-2", closeDate: "2026-06-01" },
        ],
      },
      crm: {
        contacts: [],
        companies: [],
        deals: [
          { id: "deal-newer", hubspotId: "hs-deal-1", name: "Roof Job Duplicate", stage: "Proposal Sent", amount: "900", owner: "owner-9", closeDate: "2026-05-02", createdAt: "2026-05-02T00:00:00Z" },
          { id: "deal-canonical", hubspotId: "hs-deal-1", name: "Roof Job", stage: "Closed Won", amount: "1000.00", owner: "owner-1", closeDate: "2026-05-01", createdAt: "2026-05-01T00:00:00Z" },
          { id: "deal-2", hubspotId: "hs-deal-2", name: "Other Job", stage: "Proposal Sent", amount: "2000.00", owner: "owner-2", closeDate: "2026-06-01" },
        ],
      },
    });

    expect(report.duplicateCrm.deals).toEqual([
      expect.objectContaining({
        hubspotId: "hs-deal-1",
        canonicalCrmId: "deal-canonical",
        rows: expect.arrayContaining([
          expect.objectContaining({ id: "deal-newer", name: "Roof Job Duplicate" }),
          expect.objectContaining({ id: "deal-canonical", name: "Roof Job" }),
        ]),
      }),
    ]);
    expect(report.mismatches.deals).toEqual([]);
  });

  it("normalizes slash dates deterministically across timezones and reports invalid dates", () => {
    const report = buildHubSpotReconciliationReport({
      hubspot: {
        contacts: [],
        companies: [],
        deals: [
          { id: "hs-deal-1", name: "Roof Job", stage: "Closed Won", amount: "1000", owner: "owner-1", closeDate: "05/01/2026" },
          { id: "hs-deal-2", name: "Bad Date", stage: "Closed Won", amount: "1000", owner: "owner-1", closeDate: "13/99/2026" },
        ],
      },
      crm: {
        contacts: [],
        companies: [],
        deals: [
          { id: "deal-1", hubspotId: "hs-deal-1", name: "Roof Job", stage: "closed won", amount: "1000.00", owner: "owner-1", closeDate: "2026-05-01T00:00:00.000Z" },
          { id: "deal-2", hubspotId: "hs-deal-2", name: "Bad Date", stage: "closed won", amount: "1000.00", owner: "owner-1", closeDate: "2026-05-01" },
        ],
      },
    });

    expect(report.mismatches.deals).toEqual([
      expect.objectContaining({ hubspotId: "hs-deal-2", field: "closeDate", hubspotValue: "13/99/2026", crmValue: "2026-05-01" }),
    ]);
    expect(report.warnings).toEqual([
      expect.objectContaining({ type: "invalid_date", objectType: "deals", hubspotId: "hs-deal-2", value: "13/99/2026" }),
    ]);
  });

  it.each([
    ["2026-05-01", "2026-05-01"],
    ["05/01/2026", "2026-05-01"],
    ["2026-05-01T23:30:00-05:00", "2026-05-02"],
    ["2026-05-01T23:30:00Z", "2026-05-01"],
    ["2026-05-01T23:30:00+09:00", "2026-05-01"],
    ["2026-05-01T03:30:00+09:00", "2026-04-30"],
    ["2026-05-01T23:30:00", "2026-05-01"],
  ])("normalizes close date %s to UTC date %s", (hubspotCloseDate, expectedDate) => {
    const report = reconcileCloseDate(hubspotCloseDate, expectedDate);

    expect(report.mismatches.deals).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it.each(["2026-05-01Tnot-a-time", "2026-05-01garbage", "2026-13-45"])(
    "reports malformed ISO close date %s as invalid",
    (hubspotCloseDate) => {
      const report = reconcileCloseDate(hubspotCloseDate, "2026-05-01");

      expect(report.mismatches.deals).toEqual([
        expect.objectContaining({ hubspotId: "hs-deal-1", field: "closeDate", hubspotValue: hubspotCloseDate }),
      ]);
      expect(report.warnings).toEqual([
        expect.objectContaining({ type: "invalid_date", objectType: "deals", hubspotId: "hs-deal-1", value: hubspotCloseDate }),
      ]);
    }
  );
});
