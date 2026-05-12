import { describe, expect, it } from "vitest";
import { resolveDealCreateOfficeCode } from "../../../src/modules/deals/create-context.js";

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

  it.each([null, 123, {}])("does not infer over malformed explicit officeCode %j", (requestedOfficeCode) => {
    expect(
      resolveDealCreateOfficeCode({
        requestedOfficeCode,
        officeSlug: "dallas",
      })
    ).toEqual({ officeCode: String(requestedOfficeCode ?? "") });
  });

  it("fails cleanly when no active office can be resolved", () => {
    expect(resolveDealCreateOfficeCode({ requestedOfficeCode: undefined })).toEqual({
      error: "Cannot create deal: no active office. Contact admin.",
    });
  });
});
