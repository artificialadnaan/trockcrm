import { describe, expect, it } from "vitest";
import {
  buildProjectNumber,
  generateDealNumberForProject,
  generateJulianDate,
  getNextSuffix,
  resolveOfficeCode,
  resolveProjectTypeCode,
} from "../../src/services/projectNumber.js";

describe("projectNumber service", () => {
  it("uses SyncHub Central-time DDDYY Julian date format", () => {
    expect(generateJulianDate(new Date("2026-04-16T05:30:00.000Z"))).toBe("10626");
    expect(generateJulianDate(new Date("2026-04-16T04:30:00.000Z"))).toBe("10526");
  });

  it("uses SyncHub office, type, and suffix conventions", () => {
    expect(resolveOfficeCode("Atlanta")).toBe("atl");
    expect(resolveOfficeCode("Dallas")).toBe("dfw");
    expect(resolveProjectTypeCode({ workflowRoute: "service" })).toBe("4");
    expect(resolveProjectTypeCode({ workflowRoute: "normal" })).toBe("9");
    expect(getNextSuffix(null)).toBe("aa");
    expect(getNextSuffix("az")).toBe("ba");
    expect(getNextSuffix("ba")).toBe("bb");

    expect(
      buildProjectNumber({
        officeCode: "DFW",
        projectTypeCode: "4",
        createdAt: new Date("2026-04-16T15:00:00.000Z"),
        suffix: "ac",
      })
    ).toBe("DFW-4-10626-ac");
  });

  it("formats generated project numbers with uppercase office prefix and lowercase suffix", () => {
    expect(
      buildProjectNumber({
        officeCode: "dfw",
        projectTypeCode: "1",
        createdAt: new Date("2026-05-10T15:00:00.000Z"),
        suffix: "aa",
      })
    ).toBe("DFW-1-13026-aa");

    expect(
      buildProjectNumber({
        officeCode: "Dfw" as never,
        projectTypeCode: "2",
        createdAt: new Date("2026-05-10T15:00:00.000Z"),
        suffix: "Ab",
      })
    ).toBe("DFW-2-13026-ab");

    expect(
      buildProjectNumber({
        officeCode: "atl",
        projectTypeCode: "4",
        createdAt: new Date("2026-05-10T15:00:00.000Z"),
        suffix: "ba",
      })
    ).toBe("ATL-4-13026-ba");
  });

  it("uses one daily suffix sequence across offices and rolls over suffixes", async () => {
    const executeCalls: string[] = [];
    const tenantDb = {
      execute: async () => {
        executeCalls.push("execute");
        if (executeCalls.length === 1) {
          return {
            rows: [
              { deal_number: "dfw-3-11826-az" },
              { deal_number: "atl-4-11826-ba" },
            ],
          };
        }
        if (executeCalls.length === 3) {
          return { rows: [{ last_suffix: "ba" }] };
        }
        return { rows: [] };
      },
    };

    const dealNumber = await generateDealNumberForProject(
      tenantDb,
      {
        id: "new",
        officeCode: "dfw",
        projectType: "roofing",
        createdAt: new Date("2026-04-28T15:00:00.000Z"),
      },
      new Date("2026-04-28T15:00:00.000Z")
    );

    expect(dealNumber).toBe("DFW-3-11826-bb");
    expect(executeCalls).toHaveLength(4);
  });

  it("seeds the daily sequence from existing same-day deal numbers", async () => {
    const executeCalls: string[] = [];
    const tenantDb = {
      execute: async () => {
        executeCalls.push("execute");
        if (executeCalls.length === 1) {
          return {
            rows: [
              { deal_number: "dfw-3-11826-ay" },
              { deal_number: "atl-4-11826-az" },
            ],
          };
        }
        if (executeCalls.length === 3) {
          return { rows: [{ last_suffix: "az" }] };
        }
        return { rows: [] };
      },
    };

    const dealNumber = await generateDealNumberForProject(
      tenantDb,
      {
        id: "new",
        officeCode: "atl",
        projectType: "service",
        createdAt: new Date("2026-04-28T15:00:00.000Z"),
      },
      new Date("2026-04-28T15:00:00.000Z")
    );

    expect(dealNumber).toBe("ATL-4-11826-ba");
  });
});
