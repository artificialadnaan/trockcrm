import { describe, expect, it, vi } from "vitest";
import {
  buildProjectNumber,
  generateJulianDate,
  getNextSuffix,
  resolveOfficeCode,
  resolveProjectTypeCode,
  shouldAssignProjectNumberForStageChange,
} from "../../src/services/projectNumber.js";

describe("projectNumber service", () => {
  it("uses SyncHub Central-time DDDYY Julian date format", () => {
    expect(generateJulianDate(new Date("2026-04-16T05:30:00.000Z"))).toBe("10626");
    expect(generateJulianDate(new Date("2026-04-16T04:30:00.000Z"))).toBe("10526");
  });

  it("uses SyncHub office, type, and suffix conventions", () => {
    expect(resolveOfficeCode("Atlanta")).toBe("ATL");
    expect(resolveOfficeCode("Dallas")).toBe("DFW");
    expect(resolveProjectTypeCode({ workflowRoute: "service" })).toBe("4");
    expect(resolveProjectTypeCode({ workflowRoute: "normal" })).toBe("9");
    expect(getNextSuffix(null)).toBe("aa");
    expect(getNextSuffix("az")).toBe("ba");

    expect(
      buildProjectNumber({
        officeCode: "DFW",
        projectTypeCode: "4",
        createdAt: new Date("2026-04-16T15:00:00.000Z"),
        suffix: "ac",
      })
    ).toBe("DFW-4-10626-ac");
  });

  it("assigns only on first entry to Opportunity when no project number exists", () => {
    expect(
      shouldAssignProjectNumberForStageChange({
        currentStageSlug: "sales_validation_stage",
        targetStageSlug: "opportunity",
        existingProjectNumber: null,
      })
    ).toBe(true);
    expect(
      shouldAssignProjectNumberForStageChange({
        currentStageSlug: "opportunity",
        targetStageSlug: "opportunity",
        existingProjectNumber: null,
      })
    ).toBe(false);
    expect(
      shouldAssignProjectNumberForStageChange({
        currentStageSlug: "sales_validation_stage",
        targetStageSlug: "opportunity",
        existingProjectNumber: "DFW-9-10626-aa",
      })
    ).toBe(false);
  });
});
