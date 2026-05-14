import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReimportPlan,
  diffSafeUpdateFields,
  parseReimportArgs,
  readEnvValueFromFile,
  validateAmount,
} from "../../../scripts/hubspot-deals-reimport.ts";

function makeTempCsvFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubspot-reimport-csv-"));
  const csvPath = path.join(dir, "deals.csv");
  fs.writeFileSync(csvPath, "Record ID,Deal Name\n1,Example Deal\n");
  return csvPath;
}

describe("hubspot-deals-reimport", () => {
  it("requires both apply flags before write mode is enabled", () => {
    const csvPath = makeTempCsvFile();
    expect(parseReimportArgs(["node", "script", `--csv=${csvPath}`, "--dry-run"]).apply).toBe(false);
    expect(() => parseReimportArgs(["node", "script", `--csv=${csvPath}`, "--apply"])).toThrow(
      "--apply requires --confirm-production"
    );
    expect(
      parseReimportArgs(["node", "script", `--csv=${csvPath}`, "--apply", "--confirm-production"]).apply
    ).toBe(true);
    expect(() =>
      parseReimportArgs([
        "node",
        "script",
        `--csv=${csvPath}`,
        "--dry-run",
        "--apply",
        "--confirm-production",
      ])
    ).toThrow("Cannot pass both --dry-run and --apply.");
  });

  it("throws when an explicit csv path does not exist", () => {
    expect(() =>
      parseReimportArgs(["node", "script", "--csv=/definitely/missing-hubspot-export.csv"])
    ).toThrow("CSV not found at explicit path: /definitely/missing-hubspot-export.csv");
  });

  it("preserves env values with embedded equals signs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubspot-reimport-env-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "KEY=value?with=equals&other=stuff\n");
    expect(readEnvValueFromFile(envPath, "KEY")).toBe("value?with=equals&other=stuff");
  });

  it("validates amounts consistently", () => {
    expect(validateAmount("1234.56")).toBe(1234.56);
    expect(validateAmount(" $1,234.56 ")).toBe(1234.56);
    expect(validateAmount("1,234")).toBe(1234);
    expect(validateAmount("")).toBeNull();
    expect(validateAmount("   ")).toBeNull();
    expect(validateAmount(null)).toBeNull();
    expect(validateAmount(42)).toBe(42);
    expect(() => validateAmount("N/A")).toThrow("Invalid amount");
    expect(() => validateAmount({ value: 12 })).toThrow("Invalid amount type 'object'");
  });

  it("classifies unchanged, newer, missing, ambiguous, and soft-deleted rows", () => {
    const plan = buildReimportPlan({
      csvRows: [
        {
          hubspotRecordId: "hs-1",
          dealName: "Alpha",
          amount: "1000",
          createDate: "2026-05-01T12:00:00Z",
          lastModifiedDate: "2026-05-05T00:00:00Z",
          dealStage: "Proposal Sent",
          projectNumber: "DFW-1-12126-aa",
          projectType: "Roofing",
          associatedCompany: "Acme",
        },
        {
          hubspotRecordId: "hs-2",
          dealName: "Bravo",
          amount: "1500",
          createDate: "2026-05-02T12:00:00Z",
          lastModifiedDate: "2026-05-10T00:00:00Z",
          dealStage: "Closed Won",
          projectNumber: "DFW-1-12226-aa",
          projectType: "Repair",
          associatedCompany: "Bravo Co",
        },
        {
          hubspotRecordId: "hs-3",
          dealName: "Charlie",
          amount: "1700",
          createDate: "2026-05-03T10:00:00Z",
          lastModifiedDate: "2026-05-03T10:00:00Z",
          dealStage: "Pipe Line",
          projectNumber: "DFW-1-12326-aa",
          projectType: "Service",
          associatedCompany: "Charlie LLC",
        },
        {
          hubspotRecordId: "hs-4",
          dealName: "Delta",
          amount: "1800",
          createDate: "2026-05-04T15:00:00Z",
          lastModifiedDate: "2026-05-04T15:00:00Z",
          dealStage: "Estimating",
          projectNumber: "DFW-1-12426-aa",
          projectType: "Service",
          associatedCompany: "Delta LLC",
        },
        {
          hubspotRecordId: "hs-5",
          dealName: "Echo",
          amount: "1900",
          createDate: "2026-05-05T15:00:00Z",
          lastModifiedDate: "2026-05-06T15:00:00Z",
          dealStage: "Closed Lost",
          projectNumber: "DFW-1-12526-aa",
          projectType: "Roofing",
          associatedCompany: "Echo LLC",
        },
      ],
      crmDeals: [
        {
          id: "deal-1",
          isActive: true,
          hubspotDealId: "hs-1",
          name: "Alpha",
          projectNumber: "DFW-1-12126-aa",
          projectType: "Roofing",
          amount: "1000.00",
          createdAt: "2026-05-01T12:00:00Z",
          updatedAt: "2026-05-05T00:00:00Z",
        },
        {
          id: "deal-2",
          isActive: true,
          hubspotDealId: "hs-2",
          name: "Bravo",
          projectNumber: "DFW-1-12226-aa",
          projectType: "Roofing",
          amount: "1200.00",
          createdAt: "2026-05-02T12:00:00Z",
          updatedAt: "2026-05-09T00:00:00Z",
        },
        {
          id: "deal-4",
          isActive: true,
          hubspotDealId: null,
          name: "Delta",
          projectNumber: "DFW-1-12426-aa",
          projectType: "Service",
          amount: "1800.00",
          createdAt: "2026-05-04T20:00:00Z",
          updatedAt: "2026-05-04T20:00:00Z",
        },
        {
          id: "deal-5",
          isActive: false,
          hubspotDealId: "hs-5",
          name: "Echo",
          projectNumber: "DFW-1-12526-aa",
          projectType: "Roofing",
          amount: "1900.00",
          createdAt: "2026-05-05T15:00:00Z",
          updatedAt: "2026-05-05T15:00:00Z",
        },
      ],
    });

    expect(plan.counts).toEqual({
      EXISTS_UNCHANGED: 1,
      EXISTS_NEWER_IN_CSV: 1,
      MISSING: 1,
      AMBIGUOUS: 1,
      SOFT_DELETED: 1,
    });
    expect(plan.entries.find((entry) => entry.csvRow.hubspotRecordId === "hs-2")?.bucket).toBe(
      "EXISTS_NEWER_IN_CSV"
    );
    expect(plan.entries.find((entry) => entry.csvRow.hubspotRecordId === "hs-3")?.bucket).toBe(
      "MISSING"
    );
    expect(plan.entries.find((entry) => entry.csvRow.hubspotRecordId === "hs-4")?.bucket).toBe(
      "AMBIGUOUS"
    );
    expect(plan.entries.find((entry) => entry.csvRow.hubspotRecordId === "hs-5")?.bucket).toBe(
      "SOFT_DELETED"
    );
  });

  it("stops apply planning when ambiguous rows exceed five percent", () => {
    const csvRows = Array.from({ length: 20 }, (_, index) => ({
      hubspotRecordId: `hs-${index}`,
      dealName: `Deal ${index}`,
      amount: "100",
      createDate: "2026-05-01T00:00:00Z",
      lastModifiedDate: "2026-05-02T00:00:00Z",
      dealStage: "Pipe Line",
      projectNumber: `DFW-1-12826-${String(index).padStart(2, "0")}`,
      projectType: "Roofing",
      associatedCompany: "Acme",
    }));
    const crmDeals = csvRows.slice(0, 2).map((row, index) => ({
      id: `deal-${index}`,
      isActive: true,
      hubspotDealId: null,
      name: row.dealName,
      projectNumber: row.projectNumber,
      projectType: row.projectType,
      amount: "100.00",
      createdAt: row.createDate,
      updatedAt: row.createDate,
    }));

    const plan = buildReimportPlan({ csvRows, crmDeals });

    expect(plan.ambiguousRate).toBe(0.1);
    expect(plan.shouldStopForAmbiguousRate).toBe(true);
  });

  it("limits update diffs to the approved safe field set", () => {
    expect(
      diffSafeUpdateFields(
        {
          hubspotRecordId: "hs-2",
          dealName: "Bravo Renamed",
          amount: "1500",
          createDate: "2026-05-02T12:00:00Z",
          lastModifiedDate: "2026-05-10T00:00:00Z",
          dealStage: "Closed Won",
          projectNumber: "DFW-1-12226-ab",
          projectType: "Service",
          associatedCompany: "Bravo Co",
        },
        {
          id: "deal-2",
          isActive: true,
          hubspotDealId: "hs-2",
          name: "Bravo",
          projectNumber: "DFW-1-12226-aa",
          projectType: "Roofing",
          amount: "1200.00",
          createdAt: "2026-05-02T12:00:00Z",
          updatedAt: "2026-05-09T00:00:00Z",
        }
      )
    ).toEqual([
      { field: "amount", currentValue: "1200.00", csvValue: "1500.00" },
      { field: "deal_name", currentValue: "Bravo", csvValue: "Bravo Renamed" },
      { field: "project_number", currentValue: "DFW-1-12226-aa", csvValue: "DFW-1-12226-ab" },
      { field: "project_type", currentValue: "Roofing", csvValue: "service" },
      {
        field: "last_modified_at",
        currentValue: "2026-05-09T00:00:00.000Z",
        csvValue: "2026-05-10T00:00:00.000Z",
      },
    ]);
  });

  it("treats blank CSV fields as no-op when CRM already has a non-null value", () => {
    expect(
      diffSafeUpdateFields(
        {
          hubspotRecordId: "hs-3",
          dealName: "Rayside Apartments",
          amount: "1000001.01",
          createDate: "2026-05-05T16:46:00Z",
          lastModifiedDate: "2026-05-13T17:01:00Z",
          dealStage: "RFP",
          projectNumber: "DFW-3-12526-ah",
          projectType: null,
          associatedCompany: "Low Country Construction MGT",
        },
        {
          id: "deal-3",
          isActive: true,
          hubspotDealId: "hs-3",
          name: "Rayside Apartments Property",
          projectNumber: "DFW-3-12526-ah",
          projectType: "roofing",
          amount: "700000.00",
          createdAt: "2026-05-05T16:46:00Z",
          updatedAt: "2026-05-10T19:32:26.118Z",
        }
      )
    ).toEqual([
      { field: "amount", currentValue: "700000.00", csvValue: "1000001.01" },
      {
        field: "deal_name",
        currentValue: "Rayside Apartments Property",
        csvValue: "Rayside Apartments",
      },
      {
        field: "last_modified_at",
        currentValue: "2026-05-10T19:32:26.118Z",
        csvValue: "2026-05-13T17:01:00.000Z",
      },
    ]);
  });

  it("skips unmappable project type labels instead of writing invalid CRM values", () => {
    expect(
      diffSafeUpdateFields(
        {
          hubspotRecordId: "hs-4",
          dealName: "Vercanta at Burleson",
          amount: "1200",
          createDate: "2026-05-05T16:46:00Z",
          lastModifiedDate: "2026-05-13T17:01:00Z",
          dealStage: "RFP",
          projectNumber: "DFW-3-12526-ah",
          projectType: "Maintenance",
          associatedCompany: "Low Country Construction MGT",
        },
        {
          id: "deal-4",
          isActive: true,
          hubspotDealId: "hs-4",
          name: "Vercanta at Burleson",
          projectNumber: "DFW-3-12526-ah",
          projectType: null,
          amount: "1200.00",
          createdAt: "2026-05-05T16:46:00Z",
          updatedAt: "2026-05-10T19:32:26.118Z",
        }
      )
    ).toEqual([
      {
        field: "last_modified_at",
        currentValue: "2026-05-10T19:32:26.118Z",
        csvValue: "2026-05-13T17:01:00.000Z",
      },
    ]);
  });

  it("hard-stops when duplicate active hubspot ids exist in CRM", () => {
    expect(() =>
      buildReimportPlan({
        csvRows: [],
        crmDeals: [
          {
            id: "deal-1",
            isActive: true,
            hubspotDealId: "hs-dup",
            name: "Alpha",
            projectNumber: "DFW-1-12126-aa",
            projectType: "roofing",
            amount: "1000.00",
            createdAt: "2026-05-01T12:00:00Z",
            updatedAt: "2026-05-05T00:00:00Z",
          },
          {
            id: "deal-2",
            isActive: true,
            hubspotDealId: "hs-dup",
            name: "Bravo",
            projectNumber: "DFW-1-12126-ab",
            projectType: "roofing",
            amount: "1200.00",
            createdAt: "2026-05-02T12:00:00Z",
            updatedAt: "2026-05-06T00:00:00Z",
          },
        ],
      })
    ).toThrow("Duplicate active hubspot_deal_id values found: hs-dup (2)");
  });

  it("treats non-ISO datetimes as null instead of host-timezone-dependent values", () => {
    const plan = buildReimportPlan({
      csvRows: [
        {
          hubspotRecordId: "hs-iso",
          dealName: "Alpha",
          amount: "1000",
          createDate: "2026-05-01T12:00:00",
          lastModifiedDate: "2026-05-05T00:00:00",
          dealStage: "Proposal Sent",
          projectNumber: "DFW-1-12126-aa",
          projectType: "Roofing",
          associatedCompany: "Acme",
        },
      ],
      crmDeals: [
        {
          id: "deal-1",
          isActive: true,
          hubspotDealId: "hs-iso",
          name: "Alpha",
          projectNumber: "DFW-1-12126-aa",
          projectType: "Roofing",
          amount: "1000.00",
          createdAt: "2026-05-01T12:00:00Z",
          updatedAt: "2026-05-05T00:00:00Z",
        },
      ],
    });

    expect(plan.counts.EXISTS_UNCHANGED).toBe(1);
    expect(plan.entries[0]?.fieldDiffs).toEqual([]);
  });
});
