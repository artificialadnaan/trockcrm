import { describe, expect, it } from "vitest";
import {
  CORE_WEEKLY_REPORT_MAX_PAGE_SIZE,
  CoreWeeklyReportContractError,
  parseCoreWeeklyReportJson,
  parseCoreWeeklyReportDetailRequest,
  parseCoreWeeklyReportListRequest,
  parseCoreWeeklyReportResolveDealRequest,
} from "./core-api-contracts.js";

const DEAL = "00000000-0000-4000-8000-000000000011";
const REPORT = "00000000-0000-4000-8000-000000000022";

describe("T Rock Core weekly-report strict request contracts", () => {
  it("parses valid raw JSON before applying the DTO contract", () => {
    expect(
      parseCoreWeeklyReportJson(
        '{"officeSlug":"dallas","projectNumber":"DFW-1","metadata":{"same":1},"rows":[{"same":2}]}',
      ),
    ).toMatchObject({ officeSlug: "dallas", projectNumber: "DFW-1" });
  });

  it.each([
    '{"officeSlug":"dallas","officeSlug":"atlanta","projectNumber":"DFW-1"}',
    '{"officeSlug":"dallas","office\\u0053lug":"atlanta","projectNumber":"DFW-1"}',
    '{"officeSlug":"dallas","projectNumber":"DFW-1","nested":{"key":1,"key":2}}',
  ])("rejects duplicate raw JSON keys before last-key-wins parsing: %s", (source) => {
    expect(() => parseCoreWeeklyReportJson(source)).toThrow("duplicate object key");
  });

  it.each(["", "{", "[1,]", '{"officeSlug":01}', "true false"])(
    "rejects malformed raw JSON: %j",
    (source) => {
      expect(() => parseCoreWeeklyReportJson(source)).toThrow(CoreWeeklyReportContractError);
    },
  );

  it("accepts the three exact shapes and normalizes UUID case", () => {
    expect(
      parseCoreWeeklyReportResolveDealRequest({
        officeSlug: "dallas",
        projectNumber: " DFW–1–00123–AA ",
      }),
    ).toEqual({ officeSlug: "dallas", projectNumber: "DFW–1–00123–AA" });
    expect(
      parseCoreWeeklyReportListRequest({
        officeSlug: "dallas",
        dealId: DEAL.toUpperCase(),
        canonicalProjectNumber: "dfw-1-00123-aa",
        limit: 50,
        cursor: null,
      }),
    ).toMatchObject({ dealId: DEAL, limit: 50, cursor: null });
    expect(
      parseCoreWeeklyReportDetailRequest({
        officeSlug: "dallas",
        dealId: DEAL,
        canonicalProjectNumber: "dfw-1-00123-aa",
        reportId: REPORT,
      }),
    ).toMatchObject({ dealId: DEAL, reportId: REPORT });
  });

  it.each([
    null,
    [],
    "object",
    { officeSlug: "dallas" },
    { officeSlug: "dallas", projectNumber: "DFW-1", extra: true },
  ])("rejects a non-exact resolution body: %j", (value) => {
    expect(() => parseCoreWeeklyReportResolveDealRequest(value)).toThrow(CoreWeeklyReportContractError);
  });

  it.each([0, -1, 1.5, CORE_WEEKLY_REPORT_MAX_PAGE_SIZE + 1, "50", null])(
    "rejects an out-of-contract page limit: %j",
    (limit) => {
      expect(() =>
        parseCoreWeeklyReportListRequest({
          officeSlug: "dallas",
          dealId: DEAL,
          canonicalProjectNumber: "dfw-1-00123-aa",
          limit,
        }),
      ).toThrow(CoreWeeklyReportContractError);
    },
  );

  it("requires the canonical number returned by resolution, not a display spelling", () => {
    for (const value of ["DFW-1-00123-AA", "dfw–1–00123–aa", " dfw-1-00123-aa "]) {
      expect(() =>
        parseCoreWeeklyReportDetailRequest({
          officeSlug: "dallas",
          dealId: DEAL,
          canonicalProjectNumber: value,
          reportId: REPORT,
        }),
      ).toThrow(CoreWeeklyReportContractError);
    }
  });

  it("rejects unsafe tenant/report identifiers before a database cast", () => {
    for (const body of [
      { officeSlug: "dallas;drop", dealId: DEAL, canonicalProjectNumber: "dfw-1", reportId: REPORT },
      { officeSlug: "dallas", dealId: "not-a-uuid", canonicalProjectNumber: "dfw-1", reportId: REPORT },
      { officeSlug: "dallas", dealId: DEAL, canonicalProjectNumber: "dfw-1", reportId: "not-a-uuid" },
    ]) {
      expect(() => parseCoreWeeklyReportDetailRequest(body)).toThrow(CoreWeeklyReportContractError);
    }
  });
});
