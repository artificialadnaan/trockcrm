import { describe, expect, it } from "vitest";
import {
  buildTenantNormalizationPlan,
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
});

