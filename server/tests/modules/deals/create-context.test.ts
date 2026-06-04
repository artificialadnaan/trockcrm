import { describe, expect, it } from "vitest";
import { resolveDealCreateOfficeCode } from "../../../src/modules/deals/create-context.js";

// office_code is a cosmetic project-number PREFIX (DFW-/ATL-), decoupled from the active office / data
// schema: a Dallas-active rep may stamp ATL (and vice-versa) without changing which records they access.
// resolveDealCreateOfficeCode therefore accepts any valid requested code regardless of the active office,
// and only falls back to the active office's code when none is requested.
describe("resolveDealCreateOfficeCode", () => {
  it("auto-fills a missing officeCode from the active office slug", () => {
    expect(
      resolveDealCreateOfficeCode({
        requestedOfficeCode: undefined,
        officeSlug: "dallas",
      })
    ).toEqual({ officeCode: "dfw" });
  });

  it("passes through explicit invalid officeCode values so createDeal still rejects them", () => {
    expect(
      resolveDealCreateOfficeCode({
        requestedOfficeCode: "bad-office",
        officeSlug: "dallas",
      })
    ).toEqual({ officeCode: "bad-office" });
  });

  it("allows an explicit officeCode when it matches the active office slug", () => {
    expect(
      resolveDealCreateOfficeCode({
        requestedOfficeCode: "ATL",
        officeSlug: "atlanta",
      })
    ).toEqual({ officeCode: "atl" });
  });

  it("accepts an explicit officeCode that differs from the active office (prefix is decoupled from schema)", () => {
    expect(
      resolveDealCreateOfficeCode({
        requestedOfficeCode: "ATL",
        officeSlug: "dallas",
      })
    ).toEqual({ officeCode: "atl" });
  });

  it("accepts a valid requested code even with no active office (the prefix is independent)", () => {
    expect(
      resolveDealCreateOfficeCode({
        requestedOfficeCode: "atl",
        officeSlug: null,
      })
    ).toEqual({ officeCode: "atl" });
  });

  it.each([null, 123, {}])("does not infer over malformed explicit officeCode %j", (requestedOfficeCode) => {
    expect(
      resolveDealCreateOfficeCode({
        requestedOfficeCode,
        officeSlug: "dallas",
      })
    ).toEqual({ officeCode: String(requestedOfficeCode ?? "") });
  });

  it("fails cleanly when no active office can be resolved and none is requested", () => {
    expect(resolveDealCreateOfficeCode({ requestedOfficeCode: undefined })).toEqual({
      error: "Cannot create deal: no active office. Contact admin.",
    });
  });

  it("accepts a differing lead officeCode too (lead create flow, prefix decoupled)", () => {
    expect(
      resolveDealCreateOfficeCode({
        requestedOfficeCode: "dfw",
        officeSlug: "atlanta",
        recordType: "lead",
      })
    ).toEqual({ officeCode: "dfw" });
  });
});
