import { describe, expect, it } from "vitest";
import {
  buildTenantNormalizationPlan,
  reportExecutionSummary,
  normalizeProjectNumberPrefix,
  parseNormalizeArgs,
} from "../../../scripts/normalize-project-number-case.ts";

describe("normalize-project-number-case", () => {
  it("uppercases only the office prefix and preserves later segments", () => {
    expect(normalizeProjectNumberPrefix("dfw-1-12826-aa")).toBe("DFW-1-12826-aa");
    expect(normalizeProjectNumberPrefix("Dfw-1-12826-aB")).toBe("DFW-1-12826-aB");
    expect(normalizeProjectNumberPrefix("ATL-4-13026-ba")).toBe("ATL-4-13026-ba");
    expect(normalizeProjectNumberPrefix("HS-319925219003")).toBe("HS-319925219003");
    expect(normalizeProjectNumberPrefix(null)).toBeNull();
  });

  it("defaults to dry-run and requires execute for writes", () => {
    const dryRun = parseNormalizeArgs(["normalize-project-number-case", "--tenant=all", "--dry-run"]);
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.execute).toBe(false);
    expect(dryRun.tenants).toEqual(["office_dallas", "office_atlanta"]);

    const implicitDryRun = parseNormalizeArgs(["--tenant=office_dallas"]);
    expect(implicitDryRun.dryRun).toBe(true);
    expect(implicitDryRun.execute).toBe(false);

    const execute = parseNormalizeArgs(["--tenant=office_atlanta", "--execute"]);
    expect(execute.dryRun).toBe(false);
    expect(execute.execute).toBe(true);
  });

  it("plans updates only for lowercase or mixed-case DFW/ATL prefixes", () => {
    const plan = buildTenantNormalizationPlan({
      tenant: "office_dallas",
      rows: [
        {
          dealId: "deal-1",
          dealNumber: "dfw-1-13026-aa",
          projectNumber: "DFW-1-12826-aa",
        },
        {
          dealId: "deal-2",
          dealNumber: "HS-319925219003",
          projectNumber: "Dfw-2-13026-ab",
        },
        {
          dealId: "deal-3",
          dealNumber: "ATL-4-13026-ba",
          projectNumber: "ATL-4-13026-ba",
        },
      ],
    });

    expect(plan.updates).toEqual([
      expect.objectContaining({
        dealId: "deal-1",
        column: "deal_number",
        oldValue: "dfw-1-13026-aa",
        newValue: "DFW-1-13026-aa",
      }),
      expect.objectContaining({
        dealId: "deal-2",
        column: "project_number",
        oldValue: "Dfw-2-13026-ab",
        newValue: "DFW-2-13026-ab",
      }),
    ]);
  });

  it("marks execute runs as failed when any batch fails", () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const errors: string[] = [];
    const logs: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (message?: unknown) => {
      errors.push(String(message ?? ""));
    };
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };

    try {
      reportExecutionSummary({
        dryRun: false,
        totalUpdated: 100,
        totalFailedBatches: 1,
        auditPath: "/tmp/audit.csv",
      });

      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("EXECUTION COMPLETED WITH FAILURES");
      expect(errors.join("\n")).toContain("Some rows were not normalized");
      expect(logs.join("\n")).not.toContain("EXECUTION COMPLETE");
    } finally {
      console.error = originalError;
      console.log = originalLog;
      process.exitCode = originalExitCode;
    }
  });

  it("leaves all-success execute runs at exit 0", () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };

    try {
      reportExecutionSummary({
        dryRun: false,
        totalUpdated: 3,
        totalFailedBatches: 0,
        auditPath: "/tmp/audit.csv",
      });

      expect(process.exitCode).toBeUndefined();
      expect(logs.join("\n")).toContain("EXECUTION COMPLETE");
      expect(logs.join("\n")).toContain("Values updated: 3");
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
    }
  });

  it("keeps dry-run informational even if a failure count is reported", () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };

    try {
      reportExecutionSummary({
        dryRun: true,
        totalUpdated: 0,
        totalFailedBatches: 1,
        auditPath: "/tmp/audit.csv",
      });

      expect(process.exitCode).toBeUndefined();
      expect(logs.join("\n")).toContain("DRY RUN ONLY");
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
    }
  });
});
